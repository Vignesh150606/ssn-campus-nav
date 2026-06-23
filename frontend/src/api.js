// Thin wrapper around the FastAPI backend.
//
// In dev, Vite proxies /api/* to the backend (see vite.config.js dev server
// proxy is not set up by default — instead we read VITE_API_BASE so this
// works whether the backend runs on a different port or a different host).
//
// Set VITE_API_BASE in a .env file when deploying, e.g.:
//   VITE_API_BASE=https://campus-api.yourdomain.com

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000'

async function getJSON(path) {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    throw new Error(detail.detail || `Request failed: ${res.status}`)
  }
  return res.json()
}

export function getLocations(category) {
  const q = category ? `?category=${encodeURIComponent(category)}` : ''
  return getJSON(`/api/locations${q}`)
}

export function searchLocations(q) {
  if (!q) return Promise.resolve([])
  return getJSON(`/api/locations/search?q=${encodeURIComponent(q)}`)
}

export function getLocation(id) {
  return getJSON(`/api/locations/${id}`)
}

export function getEvents(fest) {
  const q = fest ? `?fest=${encodeURIComponent(fest)}` : ''
  return getJSON(`/api/events${q}`)
}

export function getEvent(id) {
  return getJSON(`/api/events/${id}`)
}

export function getRoute(fromId, toId) {
  return getJSON(`/api/route?from_id=${encodeURIComponent(fromId)}&to_id=${encodeURIComponent(toId)}`)
}

/** Same as getRoute, but starting from a live GPS coordinate instead of a
 *  named location — used to recalculate a route once the user has drifted
 *  off the original path. */
export function getRouteFromCoords(lat, lng, toId) {
  return getJSON(`/api/route?from_lat=${lat}&from_lng=${lng}&to_id=${encodeURIComponent(toId)}`)
}

/** Road segments (with open/closed state) — reused on the frontend to
 *  surface "passes through X road" entries in the route preview panel. */
export function getRoadSegments() {
  return getJSON('/api/road-segments')
}

export function eventQrUrl(id) {
  return `${API_BASE}/api/events/${id}/qr`
}

export { API_BASE }
