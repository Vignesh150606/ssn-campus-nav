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
// Task 1 (offline support) — getLocations/getEvents/getRoadSegments each
// cache their result via offline/offlineBundle.js the moment a network call
// succeeds, and fall back to that same cache if a later call fails. Every
// fallback is genuinely best-effort: if nothing has ever been cached yet (a
// device's very first-ever launch, offline from the start), the original
// network error is what gets thrown.
//
// Routing and search always run on-device. Background data synchronization
// is separate — see routing/clientRouting.js and data/dataClient.js.

import { API_BASE } from './apiBase'
import { track } from './analytics/analyticsClient'
import * as snap from './data/dataClient'
import { searchCampusLocations } from './routing/searchLocations'
import {
  routeToLocationSync, routeFromCoordsSync,
  setRoadSegmentsSnapshot, setLocationsSnapshot, prepareClientRouting,
} from './routing/clientRouting'

// Bound legitimate online operations (feedback/admin consumers), never routing.
const DEFAULT_TIMEOUT_MS = 15000

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('Request timed out — check your connection and try again.')
      err.status = 0
      err.timeout = true
      throw err
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export async function getLocations(category) {
  const data = await snap.getLocations(category)
  if (!category) setLocationsSnapshot(data)
  return data
}

export async function searchLocations(q) {
  const results = searchCampusLocations(await getLocations(), q)
  track('search', { query: q, result_count: results.length })
  return results
}

export function getLocation(id) {
  return snap.getLocation(id)
}

export function getEvents(fest) {
  return snap.getSchedule({ fest })
}

export function getEvent(id) {
  return snap.getEvent(id)
}

// ── Routing ──────────────────────────────────────────────────────────────
//
// Routes and reroutes use the validated local graph. Background synchronization
// updates inputs without adding requests or waits to route/GPS ticks.
function _trackRoute(meta, r) {
  track(meta.isReroute ? 'reroute' : 'route_requested', {
    destination_id: meta.toId ?? null,
    from_id: meta.fromId ?? null,
    from_gps: !!meta.fromGps,
    distance_m: r.distance_m,
    eta_minutes: r.eta_minutes,
    accuracy_m: meta.accuracyM ?? null,
    snapped_to: r.snapped_to ?? null,
    warning: !!r.warning,
    offline: typeof navigator !== 'undefined' && navigator.onLine === false,
    routing_mode: 'client',
  })
}

function _clientRoute(meta, local) {
  const r = local()
  _trackRoute(meta, r)
  return r
}

/** Synchronous, client-mode-only. Throws on failure. */
export function getRouteSync(fromId, toId, meta = {}) {
  return _clientRoute({ ...meta, fromId, toId }, () => routeToLocationSync(fromId, toId))
}

export async function getRoute(fromId, toId, meta = {}) {
  const m = { ...meta, fromId, toId }
  const local = () => routeToLocationSync(fromId, toId)
  await prepareClientRouting()
  return _clientRoute(m, local)
}

/** Synchronous, client-mode-only equivalent of getRouteFromCoords. Throws on
 *  failure. Used by LocationProvider's reroute so the new route is applied in
 *  the same tick it's computed — there is no in-flight request to go stale. */
export function getRouteFromCoordsSync(lat, lng, toId, accuracyM, preferNodeId, meta = {}) {
  // GPS reroutes apply within the same tick, using the latest subscribed road
  // status. Background subscriptions refresh it independently of GPS ticks.
  return _clientRoute(
    { ...meta, toId, fromLat: lat, fromLng: lng, fromGps: true, accuracyM },
    () => routeFromCoordsSync(lat, lng, toId, accuracyM, preferNodeId)
  )
}

/** Same as getRoute, but starting from a live GPS coordinate instead of a
 *  named location — used to recalculate a route once the user has drifted
 *  off the original path.
 *
 *  `accuracyM` is the fix's own reported accuracy and `preferNodeId` the node
 *  the in-progress route was last snapped to (this call's response returns
 *  `snapped_to`; live reroutes hold onto it and pass it back next time).
 *  Both are applied identically by the on-device router and by the backend
 *  — see utils/router.py _nearest_node's docstring for what they guard
 *  against (the CSE-Annexure shortcut bug and branch flip-flopping).
 *
 *  `meta.isReroute`, when true, tags this as an automatic on-route
 *  recalculation for analytics only. */
export async function getRouteFromCoords(lat, lng, toId, accuracyM, preferNodeId, meta = {}) {
  const m = { ...meta, toId, fromLat: lat, fromLng: lng, fromGps: true, accuracyM }
  const local = () => routeFromCoordsSync(lat, lng, toId, accuracyM, preferNodeId)
  await prepareClientRouting()
  return _clientRoute(m, local)
}

/** Road segments (with open/closed state). Besides the route preview panel's
 *  "passes through X road" entries, this is the closure input of the
 *  on-device router: every result (fresh or cached) is handed to it, so a
 *  closure fetched once at app start applies to every later route without
 *  another request. Closures are as fresh as the last successful call. */
export async function getRoadSegments() {
  const data = await snap.getClosures()
  setRoadSegmentsSnapshot(data)
  return data
}

export function getGraph() {
  return snap.getGraph()
}

/** Phase 4.2 — food court menu image for today (or a specific date). UI
 *  already treats a menu fetch failure as "no menu today" rather than a
 *  hard error. */
export function getVenueMenu(venueId, date) {
  return snap.getVenueMenu(venueId, date)
}

export function eventQrUrl(id) {
  return snap.qrUrl(id)
}

// ── Route feedback (Feature 3) ──────────────────────────────────────────

async function postJSON(path, body) {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
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
 *  reached). */
export function submitFeedback(payload) {
  return postJSON('/api/feedback', payload)
}

export { API_BASE }
