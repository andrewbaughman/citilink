// UI wiring for the SWIV Citilink API POC. Each panel is fetch-on-click,
// using the functions defined in api.js.

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
  container.innerHTML = `<p class="error">Error: ${escapeHtml(err.message)}. If every panel fails like this, you probably opened this file directly instead of running ./launch-chrome.sh — see the notice at the top of the page.</p>`;
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

function renderRawJson(data) {
  const MAX_CHARS = 300000;
  let text = JSON.stringify(data, null, 2);
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS) + `\n\n... truncated, ${text.length - MAX_CHARS} more characters omitted ...`;
  }
  return text;
}

// Shared renderer for a single "destination schedule" entry, used by both
// the Stop Arrivals panel (one per line serving a stop) and the Navigate
// Schedule panel (a single entry returned directly).
function renderHoraireEntry(entry, navContext) {
  const destBlocks = (entry.destination || [])
    .map((d) => {
      const horaireRows = (d.horaires || [])
        .map((h) => {
          const predicted = secondsToClock(h.horaire);
          const scheduled = h.horaireApplicable ? secondsToClock(h.horaireApplicable) : "--";
          const useBtn = navContext
            ? `<button class="use-btn" data-id-point-arret="${escapeHtml(navContext.idPointArret)}" data-id-horaire="${h.idHoraire}">Use &#9656;</button>`
            : "";
          return `<tr><td>Predicted: ${predicted}</td><td>Scheduled: ${scheduled}</td><td>idHoraire: ${h.idHoraire}</td><td>${useBtn}</td></tr>`;
        })
        .join("");
      const nav = `${d.existePrecedent ? "&#9664; has previous" : ""} ${d.existeSuivant ? "has next &#9654;" : ""}`;
      return `<div class="destination-block">
        <p><strong>${escapeHtml(d.libelle)}</strong> <span class="nav-flags">${nav}</span></p>
        <table class="horaire-table">${horaireRows}</table>
      </div>`;
    })
    .join("");
  return `<div class="horaire-entry"><p class="line-id">Line ID: ${entry.idLigne}</p>${destBlocks}</div>`;
}

// Panel 1: Topology
document.getElementById("btn-topo").addEventListener("click", async () => {
  const summaryEl = document.getElementById("topo-summary");
  const rawEl = document.getElementById("topo-raw");
  summaryEl.innerHTML = "Loading...";
  rawEl.textContent = "";
  try {
    const data = await getTopo();
    const centres = data.topo || [];
    let totalLignes = 0, totalStops = 0, totalDeviations = 0;
    const rows = centres
      .map((c) => {
        const lignes = c.ligne ? c.ligne.length : 0;
        const stops = c.pointArret ? c.pointArret.length : 0;
        const deviations = c.deviation ? c.deviation.length : 0;
        totalLignes += lignes;
        totalStops += stops;
        totalDeviations += deviations;
        return `<li>${escapeHtml(c.libelleCE)}: ${lignes} lines, ${stops} stops, ${deviations} active deviations</li>`;
      })
      .join("");
    summaryEl.innerHTML = `<ul>${rows}</ul><p><strong>Totals:</strong> ${totalLignes} lines, ${totalStops} stops, ${totalDeviations} deviations across ${centres.length} transit center(s)</p>`;
    rawEl.textContent = renderRawJson(data);
  } catch (err) {
    renderError(summaryEl, err);
  }
});

// Panel 2: Topology Refresh
document.getElementById("btn-topo-refresh").addEventListener("click", async () => {
  const summaryEl = document.getElementById("topo-refresh-summary");
  const rawEl = document.getElementById("topo-refresh-raw");
  summaryEl.innerHTML = "Loading...";
  rawEl.textContent = "";
  try {
    const data = await getTopoRefresh();
    const updates = data.update || [];
    const rows = updates
      .map((u, i) => {
        const linesChanged = u.ligne ? u.ligne.length : 0;
        const commonGroups = u.tronconsCommun ? u.tronconsCommun.length : 0;
        const stopsUpdated = u.pointArret ? u.pointArret.length : 0;
        const newItineraries = u.objetsSuppl?.itineraires ? u.objetsSuppl.itineraires.length : 0;
        const newStops = u.objetsSuppl?.pointsArret ? u.objetsSuppl.pointsArret.length : 0;
        return `<li>Update ${i + 1} (${escapeHtml(u.libelleCE)}): ${linesChanged} lines changed, ${commonGroups} shared-segment groups, ${stopsUpdated} stops updated, ${newItineraries} new itineraries, ${newStops} new stops</li>`;
      })
      .join("");
    summaryEl.innerHTML = updates.length ? `<ul>${rows}</ul>` : "<p>No pending topology changes.</p>";
    rawEl.textContent = renderRawJson(data);
  } catch (err) {
    renderError(summaryEl, err);
  }
});

// Panel 3: Live Vehicles
document.getElementById("btn-vehicles").addEventListener("click", async () => {
  const resultEl = document.getElementById("vehicles-result");
  resultEl.innerHTML = "Loading...";
  try {
    const data = await getVehicules();
    const vehicules = data.vehicule || [];
    if (vehicules.length === 0) {
      resultEl.innerHTML = "<p>No active vehicles.</p>";
      return;
    }
    const rows = vehicules
      .map((v) => {
        return `<tr>
          <td>${escapeHtml(v.type || "")} #${escapeHtml(v.numeroEquipement || "")}</td>
          <td>${v.conduite?.idLigne ?? ""}</td>
          <td>${escapeHtml(v.conduite?.destination || "")}</td>
          <td>${escapeHtml(v.conduite?.avanceRetard || "")}</td>
          <td>${v.conduite?.vitesse ?? ""}</td>
          <td>${escapeHtml(v.vehiculeLoad ?? "—")}</td>
        </tr>`;
      })
      .join("");
    resultEl.innerHTML = `<table class="data-table">
      <thead><tr><th>Vehicle</th><th>Line ID</th><th>Destination</th><th>Delay</th><th>Speed</th><th>Load</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  } catch (err) {
    renderError(resultEl, err);
  }
});

// Panel 4: Config Version
document.getElementById("btn-version").addEventListener("click", async () => {
  const resultEl = document.getElementById("version-result");
  resultEl.innerHTML = "Loading...";
  try {
    const data = await getVersion();
    const versions = data.version || [];
    const rows = versions
      .map((v) => `<li>${escapeHtml(v.libelleCE)}: version ${v.valeur}</li>`)
      .join("");
    resultEl.innerHTML = `<ul>${rows}</ul>`;
  } catch (err) {
    renderError(resultEl, err);
  }
});

// Panel 5: Service Alerts
document.getElementById("btn-alerts").addEventListener("click", async () => {
  const resultEl = document.getElementById("alerts-result");
  resultEl.innerHTML = "Loading...";
  try {
    const data = await getServiceMessages();
    const withMessages = (data || []).filter((m) => m.message && m.message.trim().length > 0);
    if (withMessages.length === 0) {
      resultEl.innerHTML = "<p>No active service alerts.</p>";
      return;
    }
    const rows = withMessages
      .map((m) => {
        const badges = (m.ligne || [])
          .map((l) => `<span class="badge" style="background:${escapeHtml(l.couleur || "#666")}">${escapeHtml(l.mnemo || "")}</span>`)
          .join(" ");
        return `<li><span class="importance">${escapeHtml(m.importanceMessage || "")}</span> ${badges} ${escapeHtml(m.message)}</li>`;
      })
      .join("");
    resultEl.innerHTML = `<ul class="alerts-list">${rows}</ul>`;
  } catch (err) {
    renderError(resultEl, err);
  }
});

// Panel 6: Stop Arrivals
document.getElementById("btn-stop-arrivals").addEventListener("click", async () => {
  const stopId = document.getElementById("stop-id-input").value.trim();
  const resultEl = document.getElementById("stop-arrivals-result");
  resultEl.innerHTML = "Loading...";
  try {
    const data = await getStopArrivals(stopId);
    const entries = data.listeHoraires || [];
    if (entries.length === 0) {
      resultEl.innerHTML = "<p>No scheduled arrivals for this stop.</p>";
      return;
    }
    resultEl.innerHTML = entries.map((e) => renderHoraireEntry(e, { idPointArret: stopId })).join("");
    resultEl.querySelectorAll(".use-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.getElementById("nav-stop-id-input").value = btn.dataset.idPointArret;
        document.getElementById("nav-horaire-id-input").value = btn.dataset.idHoraire;
        document.getElementById("nav-panel").scrollIntoView({ behavior: "smooth" });
      });
    });
  } catch (err) {
    renderError(resultEl, err);
  }
});

// Panel 7: Navigate Schedule
document.getElementById("btn-nav").addEventListener("click", async () => {
  const stopId = document.getElementById("nav-stop-id-input").value.trim();
  const horaireId = document.getElementById("nav-horaire-id-input").value.trim();
  const direction = document.getElementById("nav-direction-select").value;
  const resultEl = document.getElementById("nav-result");
  resultEl.innerHTML = "Loading...";
  try {
    const data = await getStopArrivalNavigation(stopId, horaireId, direction);
    resultEl.innerHTML = renderHoraireEntry(data, null);
  } catch (err) {
    renderError(resultEl, err);
  }
});
