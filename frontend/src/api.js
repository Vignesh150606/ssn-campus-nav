// Thin wrapper around the FastAPI backend.
//
// In dev, Vite proxies /api/* to the backend (see vite.config.js dev server
// proxy is not set up by default — instead we read VITE_API_BASE so this
// works whether the backend runs on a different port or a different host).
//
// Set VITE_API_BASE in a .env file when deploying, e.g.:
//   VITE_API_BASE=https://campus-api.yourdomain.com
//
// Phase X (Navigation Analytics) — this file is also where analytics
// logging lives, rather than scattered across every screen that calls
// these functions. See ./analytics/analyticsClient.js.
//
// The offline-routing fallbacks this file used to also carry (a network
// failure falling back to an on-device cached graph/location bundle) have
// been removed — the app is intended for on-campus use where connectivity
// is assumed, and every export below now has the exact same signature and
// behaviour it had before that offline-first experience was added.

import { API_BASE } from './apiBase'
import { track } from './analytics/analyticsClient'

async function getJSON(path) {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    const err = new Error(detail.detail || `Request failed: ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

export async function getLocations(category) {
  const q = category ? `?category=${encodeURIComponent(category)}` : ''
  return getJSON(`/api/locations${q}`)
}

export async function searchLocations(q) {
  if (!q) return []
  const results = await getJSON(`/api/locations/search?q=${encodeURIComponent(q)}`)
  track('search', { query: q, result_count: results.length })
  return results
}

export async function getLocation(id) {
  return getJSON(`/api/locations/${id}`)
}

export async function getEvents(fest) {
  const q = fest ? `?fest=${encodeURIComponent(fest)}` : ''
  return getJSON(`/api/events${q}`)
}

export async function getEvent(id) {
  return getJSON(`/api/events/${id}`)
}

// ── Routing ──────────────────────────────────────────────────────────────
//
// Both getRoute and getRouteFromCoords hit the same /api/route endpoint and
// get back the same response shape; `_routeQuery` below is the one place
// that logs the route_requested / reroute analytics event. `meta.isReroute`
// distinguishes an automatic on-route recalculation (LocationProvider.jsx,
// the only caller that passes it) from every other, user-initiated route
// request, so "most requested routes" and "most rerouted paths" can be
// told apart in the analytics summary.
async function _routeQuery(query, meta) {
  const r = await getJSON(`/api/route?${query}`)
  track(meta.isReroute ? 'reroute' : 'route_requested', {
    destination_id: meta.toId ?? null,
    from_id: meta.fromId ?? null,
    from_gps: !!meta.fromGps,
    distance_m: r.distance_m,
    eta_minutes: r.eta_minutes,
    accuracy_m: meta.accuracyM ?? null,
    snapped_to: r.snapped_to ?? null,
    warning: !!r.warning,
    offline: false,
  })
  return r
}

export function getRoute(fromId, toId, meta = {}) {
  return _routeQuery(`from_id=${encodeURIComponent(fromId)}&to_id=${encodeURIComponent(toId)}`, {
    ...meta,
    fromId,
    toId,
  })
}

/** Same as getRoute, but starting from a live GPS coordinate instead of a
 *  named location — used to recalculate a route once the user has drifted
 *  off the original path.
 *
 *  `accuracyM`, when available, is passed through so the backend's nearest-
 *  node snap can't trust a farther candidate any more than this specific
 *  fix's own measured uncertainty allows — see utils/router.py
 *  _nearest_node's docstring for why (root cause of the CSE-Annexure
 *  shortcut bug). Omit it and the backend falls back to its previous,
 *  unchanged default margin.
 *
 *  `preferNodeId`, when available, is the walkway node the in-progress
 *  route was last snapped to (this call's response also returns
 *  `snapped_to` — callers doing live rerouting should hold onto it and
 *  pass it back in here next time). This stops a route from flipping
 *  between two similarly-costed branches on a few metres of GPS noise
 *  alone — see the same docstring for the follow-up bug this fixes. Omit
 *  it for a fresh, one-off route request (nothing to stay consistent
 *  with yet).
 *
 *  `meta.isReroute`, when true, tags this as an automatic on-route
 *  recalculation for analytics purposes only — see _routeQuery above.
 *  Omit it (the default) for a user-initiated route request. */
export function getRouteFromCoords(lat, lng, toId, accuracyM, preferNodeId, meta = {}) {
  const acc = accuracyM != null ? `&accuracy=${accuracyM}` : ''
  const prefer = preferNodeId ? `&prefer_node=${encodeURIComponent(preferNodeId)}` : ''
  return _routeQuery(`from_lat=${lat}&from_lng=${lng}&to_id=${encodeURIComponent(toId)}${acc}${prefer}`, {
    ...meta,
    toId,
    fromLat: lat,
    fromLng: lng,
    fromGps: true,
    accuracyM,
  })
}

/** Road segments (with open/closed state) — reused on the frontend to
 *  surface "passes through X road" entries in the route preview panel. */
export async function getRoadSegments() {
  return getJSON('/api/road-segments')
}

/** Phase 4.2 — food court menu image for today (or a specific date). UI
 *  already treats a menu fetch failure as "no menu today" rather than a
 *  hard error. */
export function getVenueMenu(venueId, date) {
  const q = date ? `?date=${encodeURIComponent(date)}` : ''
  return getJSON(`/api/locations/${encodeURIComponent(venueId)}/menu${q}`)
}

export function eventQrUrl(id) {
  return `${API_BASE}/api/events/${id}/qr`
}

/** Phase 4A.1 — used by the startup boot screen to detect when the
 *  backend (Render free-tier cold start can take 20-50s) and Supabase
 *  are both reachable. Deliberately never throws — a failed/timed-out
 *  check just means "not ready yet", which the caller polls again for.
 *  `timeoutMs` bounds a single attempt so one slow request can't hang
 *  the whole retry loop. */
export async function checkHealth(timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${API_BASE}/api/health`, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ── Route feedback (Feature 3) ──────────────────────────────────────────

async function postJSON(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    const err = new Error(detail.detail || `Request failed: ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

/** Submit route feedback (shown when navigation ends or the destination is
 *  reached). Returns { feedback_id } so a screenshot can optionally follow
 *  via uploadFeedbackScreenshot. */
export function submitFeedback(payload) {
  return postJSON('/api/feedback', payload)
}

/** Optional screenshot attach for a feedback submission. */
export async function uploadFeedbackScreenshot(feedbackId, file) {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${API_BASE}/api/feedback/${encodeURIComponent(feedbackId)}/screenshot`, {
    method: 'POST',
    body: form,
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    const err = new Error(detail.detail || `Request failed: ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

export { API_BASE }
