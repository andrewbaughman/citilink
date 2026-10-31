// Citilink Live Transit webapp — map, my-stop arrivals, typical wait time, alerts.
// Built on top of api.js (thin fetch wrappers for the SWIV REST API).

const VEHICLE_POLL_MS = 500; // matches the vendor app's own timer.vehicule
const ARRIVALS_POLL_MS = 15000; // matches timer.horaire
const ALERTS_POLL_MS = 60000; // matches timer.version
const HEADWAY_MAX_HOPS_PER_DEST = 5;
const HEADWAY_MAX_DESTINATIONS = 4;
const MY_STOP_STORAGE_KEY = "citilink_my_stop_id";
const MAP_CENTER = [41.0874, -85.1482];

let map;
const lineLookup = {}; // idLigne -> { mnemo, nomCommercial, couleur }
const stopsById = {}; // idPointArret -> { idPointArret, nomCommercial, mnemoPointArret, lat, lng, infoLigneSwiv }
let stopsList = [];
const stopMarkerById = {};
const vehicleMarkers = new Map(); // vehicle id -> L.marker (rectangle divIcon)
const routeLayersByLine = {}; // idLigne -> [L.polyline, ...]

let selectedStopId = null;
let lastAlertsData = [];
let arrivalsIntervalHandle = null;
let highlightedLineId = null;

// --- helpers ---

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderError(container, err) {
  container.innerHTML = `<p class="error">Error: ${escapeHtml(err.message)}. Make sure you launched this page via ./launch-chrome.sh.</p>`;
}

function secondsToClock(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined) return "--";
  const s = ((totalSeconds % 86400) + 86400) % 86400;
  let hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const mm = String(minutes).padStart(2, "0");
  return `${hours}:${mm} ${ampm}`;
}

function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function servingLineIds(idPointArret) {
  const stop = stopsById[idPointArret];
  return new Set((stop?.infoLigneSwiv || []).map((x) => x.idLigne));
}

function renderHoraireEntry(entry) {
  const destBlocks = (entry.destination || [])
    .map((d) => {
      const rows = (d.horaires || [])
        .map((h) => {
          const predicted = secondsToClock(h.horaire);
          const scheduled = h.horaireApplicable ? secondsToClock(h.horaireApplicable) : "--";
          return `<tr><td>Predicted: ${predicted}</td><td>Scheduled: ${scheduled}</td></tr>`;
        })
        .join("");
      return `<div class="destination-block">
        <p><strong>${escapeHtml(d.libelle)}</strong></p>
        <table class="horaire-table">${rows}</table>
      </div>`;
    })
    .join("");
  const lineLabel = lineLookup[entry.idLigne]?.nomCommercial || `Line ${entry.idLigne}`;
  return `<div class="horaire-entry"><p class="line-id">${escapeHtml(lineLabel)}</p>${destBlocks}</div>`;
}

// --- map + topology ---

function initMap() {
  map = L.map("map", { preferCanvas: true, center: MAP_CENTER, zoom: 12 });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    minZoom: 2,
    maxZoom: 19,
    attribution: "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors"
  }).addTo(map);
}

// --- route highlighting (shared by the routes panel and clicking a bus) ---

function routeNumber(info) {
  const n = parseInt(info.nomCommercial, 10);
  if (!Number.isNaN(n)) return n;
  const m = parseInt(info.mnemo, 10);
  return Number.isNaN(m) ? Infinity : m;
}

function renderRoutesList() {
  const listEl = document.getElementById("routes-list");
  const sorted = Object.entries(lineLookup).sort(([, a], [, b]) => {
    const diff = routeNumber(a) - routeNumber(b);
    if (diff !== 0) return diff;
    return (a.nomCommercial || a.mnemo || "").localeCompare(b.nomCommercial || b.mnemo || "");
  });
  const rows = sorted
    .map(([idLigne, info]) => {
      const label = info.nomCommercial || info.mnemo || `Line ${idLigne}`;
      return `<div class="route-item" data-id-ligne="${idLigne}">
        <span class="route-swatch" style="background:${escapeHtml(info.couleur || "#666")}"></span>
        <span class="route-label">${escapeHtml(label)}</span>
        <span class="route-count" data-id-ligne="${idLigne}" title="active buses on this route">0</span>
      </div>`;
    })
    .join("");
  listEl.innerHTML = rows;
  listEl.querySelectorAll(".route-item").forEach((el) => {
    el.addEventListener("click", () => highlightRoute(Number(el.dataset.idLigne)));
  });
}

function updateRoutesListActiveState() {
  document.querySelectorAll(".route-item").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.idLigne) === highlightedLineId);
  });
}

// Clicking the already-highlighted route (or the bus on it) again clears the highlight.
function highlightRoute(idLigne) {
  const isClearing = highlightedLineId === idLigne;
  highlightedLineId = isClearing ? null : idLigne;

  for (const [lineIdStr, layers] of Object.entries(routeLayersByLine)) {
    const lineId = Number(lineIdStr);
    const isTarget = !isClearing && lineId === idLigne;
    const isDimmed = !isClearing && !isTarget;
    const color = isDimmed ? "#999999" : lineLookup[lineId]?.couleur;
    const weight = isTarget ? 6 : 3;
    const opacity = isDimmed ? 0.5 : isTarget ? 0.95 : 0.75;
    layers.forEach((layer) => {
      layer.setStyle({ color, weight, opacity });
      if (isTarget) layer.bringToFront();
    });
  }

  updateRoutesListActiveState();

  if (!isClearing) {
    const layers = routeLayersByLine[idLigne] || [];
    if (layers.length) {
      const bounds = layers[0].getBounds();
      layers.slice(1).forEach((l) => bounds.extend(l.getBounds()));
      if (bounds.isValid()) map.fitBounds(bounds, { maxZoom: 15, padding: [20, 20] });
    }
  }
}

async function loadTopology() {
  const statusEl = document.getElementById("load-status");
  try {
    const data = await getTopo();
    let lineCount = 0;
    let stopCount = 0;
    for (const centre of data.topo || []) {
      for (const ligne of centre.ligne || []) {
        lineLookup[ligne.idLigne] = {
          mnemo: ligne.mnemo,
          nomCommercial: ligne.nomCommercial,
          couleur: ligne.couleur,
        };
        lineCount++;
        for (const itin of ligne.itineraire || []) {
          const points = (itin.troncons || []).flatMap((t) => [
            [t.debut.lat, t.debut.lng],
            [t.fin.lat, t.fin.lng],
          ]);
          if (points.length) {
            const polyline = L.polyline(points, {
              color: ligne.couleur,
              weight: 3,
              opacity: 0.75,
            }).addTo(map);
            (routeLayersByLine[ligne.idLigne] ||= []).push(polyline);
          }
        }
      }
      for (const stop of centre.pointArret || []) {
        const record = {
          idPointArret: stop.idPointArret,
          nomCommercial: stop.nomCommercial,
          mnemoPointArret: stop.mnemoPointArret,
          lat: stop.localisation.lat,
          lng: stop.localisation.lng,
          infoLigneSwiv: stop.infoLigneSwiv || [],
        };
        stopsById[stop.idPointArret] = record;
        stopsList.push(record);
        stopCount++;

        const marker = L.circleMarker([record.lat, record.lng], {
          radius: 4,
          color: "#333",
          weight: 1,
          fillColor: "#fff",
          fillOpacity: 1,
        }).addTo(map);
        marker.bindPopup(escapeHtml(record.nomCommercial));
        marker.on("click", () => selectStop(record.idPointArret));
        stopMarkerById[stop.idPointArret] = marker;
      }
    }
    statusEl.textContent = `Loaded ${lineCount} lines, ${stopCount} stops.`;
    statusEl.className = "load-status ready";
    document.getElementById("stop-search").disabled = false;
    document.getElementById("btn-use-location").disabled = false;
    renderRoutesList();
  } catch (err) {
    statusEl.textContent = `Failed to load route/stop data: ${err.message}. Make sure you launched via ./launch-chrome.sh.`;
    statusEl.className = "load-status error";
    throw err;
  }
}

// --- live vehicles ---

function makeVehicleIcon(color, servesMyStop) {
  const w = servesMyStop ? 18 : 14;
  const h = servesMyStop ? 11 : 9;
  const highlightClass = servesMyStop ? "serves-my-stop" : "";
  return L.divIcon({
    className: "",
    html: `<div class="vehicle-rect ${highlightClass}" style="width:${w}px;height:${h}px;background:${color};"></div>`,
    iconSize: [w, h],
    iconAnchor: [w / 2, h / 2],
    popupAnchor: [0, -h / 2],
  });
}

function updateRouteVehicleCounts(countsByLine) {
  document.querySelectorAll(".route-count").forEach((el) => {
    el.textContent = String(countsByLine[Number(el.dataset.idLigne)] || 0);
  });
}

async function loadVehicles() {
  try {
    const data = await getVehicules();
    const seenIds = new Set();
    const servingLines = selectedStopId ? servingLineIds(selectedStopId) : new Set();
    const countsByLine = {};

    for (const v of data.vehicule || []) {
      seenIds.add(v.id);
      const idLigne = v.conduite?.idLigne;
      countsByLine[idLigne] = (countsByLine[idLigne] || 0) + 1;
      const color = lineLookup[idLigne]?.couleur || "#333";
      const servesMyStop = servingLines.has(idLigne);
      const icon = makeVehicleIcon(color, servesMyStop);
      const popupHtml = `<strong>${escapeHtml(lineLookup[idLigne]?.nomCommercial || "Line " + idLigne)}</strong><br/>
        To: ${escapeHtml(v.conduite?.destination || "")}<br/>
        ${escapeHtml(v.conduite?.avanceRetard || "")}<br/>
        ${escapeHtml(v.type || "")} #${escapeHtml(v.numeroEquipement || "")}`;

      let marker = vehicleMarkers.get(v.id);
      if (marker) {
        marker.setLatLng([v.localisation.lat, v.localisation.lng]);
        marker.setIcon(icon);
        marker.setPopupContent(popupHtml);
        marker.currentLigne = idLigne;
      } else {
        marker = L.marker([v.localisation.lat, v.localisation.lng], { icon }).addTo(map);
        marker.bindPopup(popupHtml);
        marker.currentLigne = idLigne;
        marker.on("click", () => highlightRoute(marker.currentLigne));
        vehicleMarkers.set(v.id, marker);
      }
    }

    for (const [id, marker] of vehicleMarkers.entries()) {
      if (!seenIds.has(id)) {
        map.removeLayer(marker);
        vehicleMarkers.delete(id);
      }
    }

    updateRouteVehicleCounts(countsByLine);
  } catch (err) {
    console.error("Failed to load vehicles:", err);
  }
}

function startVehiclePolling() {
  loadVehicles();
  setInterval(loadVehicles, VEHICLE_POLL_MS);
}

// --- my stop: search, geolocation, selection ---

function renderSearchResults(container, matches, onDistanceLabel) {
  container.innerHTML = matches
    .map((s) => {
      const dist = onDistanceLabel ? `<span class="dist">${onDistanceLabel(s)}</span>` : "";
      return `<div class="search-result-item" data-id="${s.idPointArret}">${escapeHtml(s.nomCommercial)} ${dist}</div>`;
    })
    .join("");
  container.querySelectorAll(".search-result-item").forEach((el) => {
    el.addEventListener("click", () => {
      const id = Number(el.dataset.id);
      selectStop(id);
      document.getElementById("stop-search").value = stopsById[id].nomCommercial;
      container.innerHTML = "";
    });
  });
}

document.getElementById("stop-search").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  const resultsEl = document.getElementById("stop-search-results");
  if (q.length < 2) {
    resultsEl.innerHTML = "";
    return;
  }
  const matches = stopsList.filter((s) => s.nomCommercial.toLowerCase().includes(q)).slice(0, 15);
  renderSearchResults(resultsEl, matches);
});

document.getElementById("btn-use-location").addEventListener("click", () => {
  const nearbyEl = document.getElementById("nearby-stops");
  if (!navigator.geolocation) {
    nearbyEl.innerHTML = '<p class="error">Geolocation not supported by this browser.</p>';
    return;
  }
  nearbyEl.innerHTML = "Locating…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      const nearest = stopsList
        .map((s) => ({ ...s, dist: haversineDistanceMeters(latitude, longitude, s.lat, s.lng) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 5);
      renderSearchResults(nearbyEl, nearest, (s) => `${Math.round(s.dist)} m`);
    },
    (err) => {
      nearbyEl.innerHTML = `<p class="error">Location error: ${escapeHtml(err.message)}</p>`;
    },
    { timeout: 10000 }
  );
});

function selectStop(idPointArret) {
  const previous = selectedStopId;
  selectedStopId = idPointArret;
  localStorage.setItem(MY_STOP_STORAGE_KEY, String(idPointArret));

  if (previous != null && stopMarkerById[previous]) {
    stopMarkerById[previous].setStyle({ radius: 4, color: "#333", weight: 1, fillColor: "#fff", fillOpacity: 1 });
  }
  const marker = stopMarkerById[idPointArret];
  if (marker) {
    marker.setStyle({ radius: 7, color: "#1b89ca", weight: 2, fillColor: "#1b89ca", fillOpacity: 1 });
    map.panTo(marker.getLatLng());
  }

  const stop = stopsById[idPointArret];
  document.getElementById("selected-stop-display").innerHTML = stop
    ? `Selected: <span class="stop-name">${escapeHtml(stop.nomCommercial)}</span>`
    : "";

  document.getElementById("btn-headway").disabled = false;
  document.getElementById("headway-result").innerHTML = "";

  startArrivalsPolling(idPointArret);
  renderAlerts();
  loadVehicles();
}

// --- next arrivals ---

async function loadArrivals(idPointArret) {
  const resultEl = document.getElementById("arrivals-result");
  try {
    const data = await getStopArrivals(idPointArret);
    const entries = data.listeHoraires || [];
    resultEl.innerHTML = entries.length
      ? entries.map(renderHoraireEntry).join("")
      : "<p>No scheduled arrivals for this stop right now.</p>";
  } catch (err) {
    renderError(resultEl, err);
  }
}

function startArrivalsPolling(idPointArret) {
  if (arrivalsIntervalHandle) clearInterval(arrivalsIntervalHandle);
  loadArrivals(idPointArret);
  arrivalsIntervalHandle = setInterval(() => loadArrivals(idPointArret), ARRIVALS_POLL_MS);
}

// --- typical wait time ---

async function calculateHeadway() {
  const resultEl = document.getElementById("headway-result");
  if (!selectedStopId) return;
  resultEl.innerHTML = "Calculating… (this makes several API calls)";
  try {
    const data = await getStopArrivals(selectedStopId);
    let destinations = data.listeHoraires || [];
    const cappedDestinations = destinations.length > HEADWAY_MAX_DESTINATIONS;
    if (cappedDestinations) destinations = destinations.slice(0, HEADWAY_MAX_DESTINATIONS);

    const perLineResults = [];
    const allTimestamps = [];
    let cappedAnyHops = false;

    for (const entry of destinations) {
      for (const dest of entry.destination || []) {
        const timestamps = (dest.horaires || []).map((h) => h.horaire).filter((x) => x != null);
        let lastHoraireId = dest.horaires?.[dest.horaires.length - 1]?.idHoraire;
        let existeSuivant = dest.existeSuivant;
        let hops = 0;

        while (existeSuivant && hops < HEADWAY_MAX_HOPS_PER_DEST && lastHoraireId != null) {
          let nav;
          try {
            nav = await getStopArrivalNavigation(selectedStopId, lastHoraireId, "SUIVANT");
          } catch (e) {
            break;
          }
          const navDest = nav.destination?.[0];
          if (!navDest || !navDest.horaires?.length) break;
          const newHoraire = navDest.horaires[navDest.horaires.length - 1];
          if (timestamps.includes(newHoraire.horaire)) break;
          timestamps.push(newHoraire.horaire);
          lastHoraireId = newHoraire.idHoraire;
          existeSuivant = navDest.existeSuivant;
          hops++;
        }
        if (existeSuivant && hops >= HEADWAY_MAX_HOPS_PER_DEST) cappedAnyHops = true;

        timestamps.sort((a, b) => a - b);
        const gaps = [];
        for (let i = 1; i < timestamps.length; i++) gaps.push(timestamps[i] - timestamps[i - 1]);
        const avgGapMinutes = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length / 60 : null;

        perLineResults.push({
          idLigne: entry.idLigne,
          destinationLabel: dest.libelle,
          sampleCount: timestamps.length,
          avgGapMinutes,
        });
        allTimestamps.push(...timestamps);
      }
    }

    allTimestamps.sort((a, b) => a - b);
    const combinedGaps = [];
    for (let i = 1; i < allTimestamps.length; i++) combinedGaps.push(allTimestamps[i] - allTimestamps[i - 1]);
    const combinedAvgMinutes = combinedGaps.length
      ? combinedGaps.reduce((a, b) => a + b, 0) / combinedGaps.length / 60
      : null;
    const lineCount = new Set(perLineResults.map((r) => r.idLigne)).size;

    let html = "";
    if (combinedAvgMinutes != null) {
      html += `<p class="headway-summary">~${combinedAvgMinutes.toFixed(1)} min between buses</p>`;
      html += `<p class="headway-note">Based on ${allTimestamps.length} upcoming departures across ${lineCount} line(s).</p>`;
    } else {
      html += "<p>Not enough upcoming departures to estimate a wait time right now.</p>";
    }
    html +=
      '<ul class="headway-breakdown">' +
      perLineResults
        .map((r) => {
          const label = lineLookup[r.idLigne]?.mnemo || `Line ${r.idLigne}`;
          const avg = r.avgGapMinutes != null ? `${r.avgGapMinutes.toFixed(1)} min avg` : "not enough data";
          return `<li>${escapeHtml(label)} — ${escapeHtml(r.destinationLabel)}: ${avg} (${r.sampleCount} samples)</li>`;
        })
        .join("") +
      "</ul>";
    if (cappedDestinations) {
      html += `<p class="headway-note">Only the first ${HEADWAY_MAX_DESTINATIONS} destinations serving this stop were used.</p>`;
    }
    if (cappedAnyHops) {
      html += `<p class="headway-note">Hit the ${HEADWAY_MAX_HOPS_PER_DEST}-lookup-per-line cap before running out of scheduled departures — the real average may differ slightly.</p>`;
    }
    resultEl.innerHTML = html;
  } catch (err) {
    renderError(resultEl, err);
  }
}

document.getElementById("btn-headway").addEventListener("click", calculateHeadway);

// --- service alerts ---

async function loadAlerts() {
  try {
    lastAlertsData = (await getServiceMessages()) || [];
    renderAlerts();
  } catch (err) {
    renderError(document.getElementById("alerts-result"), err);
  }
}

function renderAlerts() {
  const resultEl = document.getElementById("alerts-result");
  const withMessages = lastAlertsData.filter((m) => m.message && m.message.trim().length > 0);
  if (withMessages.length === 0) {
    resultEl.innerHTML = "<p>No active service alerts.</p>";
    return;
  }
  const servingLines = selectedStopId ? servingLineIds(selectedStopId) : new Set();
  const sorted = [...withMessages].sort((a, b) => {
    const aPinned = (a.ligne || []).some((l) => servingLines.has(l.idLigne));
    const bPinned = (b.ligne || []).some((l) => servingLines.has(l.idLigne));
    return (bPinned ? 1 : 0) - (aPinned ? 1 : 0);
  });
  const rows = sorted
    .map((m) => {
      const pinned = (m.ligne || []).some((l) => servingLines.has(l.idLigne));
      const badges = (m.ligne || [])
        .map((l) => `<span class="badge" style="background:${escapeHtml(l.couleur || "#666")}">${escapeHtml(l.mnemo || "")}</span>`)
        .join(" ");
      return `<li class="${pinned ? "pinned" : ""}">${pinned ? "\u{1F4CD} " : ""}<span class="importance">${escapeHtml(m.importanceMessage || "")}</span> ${badges} ${escapeHtml(m.message)}</li>`;
    })
    .join("");
  resultEl.innerHTML = `<ul class="alerts-list">${rows}</ul>`;
}

function startAlertsPolling() {
  loadAlerts();
  setInterval(loadAlerts, ALERTS_POLL_MS);
}

// --- init ---

async function init() {
  initMap();
  try {
    await loadTopology();
  } catch (err) {
    return; // load-status already shows the error; nothing else can proceed
  }
  startVehiclePolling();
  startAlertsPolling();

  const savedStopId = localStorage.getItem(MY_STOP_STORAGE_KEY);
  if (savedStopId && stopsById[savedStopId]) {
    document.getElementById("stop-search").value = stopsById[savedStopId].nomCommercial;
    selectStop(Number(savedStopId));
  }
}

init();
