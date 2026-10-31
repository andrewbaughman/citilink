// Thin fetch wrappers for the SWIV Citilink REST API.
// See ../api-discovery/openapi.json for the full documented spec.

// The browser calls our local server. It forwards these requests to Citilink so
// the public API's missing CORS headers never reach the browser.
const API_BASE = "/api";

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText} (${url})`);
  }
  // The API sends `Content-Type: application/octet-stream` for JSON bodies.
  // response.json() parses on content regardless of the declared content-type.
  return res.json();
}

function cacheBust() {
  return Date.now();
}

async function getTopo() {
  return fetchJson(`${API_BASE}/topo?_tmp=${cacheBust()}`);
}

async function getTopoRefresh() {
  return fetchJson(`${API_BASE}/topo/refresh?_tmp=${cacheBust()}`);
}

async function getVehicules() {
  return fetchJson(`${API_BASE}/topo/vehicules?_tmp=${cacheBust()}`);
}

async function getVersion() {
  return fetchJson(`${API_BASE}/config/version?_tmp=${cacheBust()}`);
}

async function getServiceMessages() {
  return fetchJson(`${API_BASE}/iv/message`);
}

async function getStopArrivals(idPointArret) {
  return fetchJson(`${API_BASE}/horaires/pta/${idPointArret}?_tmp=${cacheBust()}`);
}

async function getStopArrivalNavigation(idPointArret, idHoraire, direction) {
  return fetchJson(
    `${API_BASE}/horaires/horaire/${idPointArret}/${idHoraire}/${direction}?_tmp=${cacheBust()}`
  );
}
