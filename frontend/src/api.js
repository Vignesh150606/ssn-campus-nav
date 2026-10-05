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
// Routing (getRoute/getRouteFromCoords) runs on-device by default and makes
// no request — see the Routing section below and routing/routingMode.js.

import { API_BASE } from './apiBase'
import { track } from './analytics/analyticsClient'
import * as snap from './data/dataClient'
import { getCachedBundleResource } from './offline/offlineBundle'
import { ROUTING_MODE } from './routing/routingMode'
import {
  routeToLocationSync, routeFromCoordsSync,
  setRoadSegmentsSnapshot, setLocationsSnapshot,
} from './routing/clientRouting'

snap.subscribe('closures', setRoadSegmentsSnapshot)
snap.subscribe('locations', setLocationsSnapshot)

// Previously plain fetch() with no timeout. LocationProvider.jsx's
// maybeRecalculate() sets recalculatingRef.current = true before calling
// getRouteFromCoords() (-> getJSON here) and only ever resets it to false
// in that promise's .finally() — so one request that never settles (bad
// signal, backend hung, cold-start stall) left recalculatingRef stuck
// true for the rest of the tab's life, and every future off-route tick
// silently no-ops on the "already-in-flight" guard forever, permanently
// killing auto-reroute. Same pattern already used correctly by
// checkHealth() below; applied here to every JSON call so nothing else
// downstream (route requests, feedback submission) can wedge the same way.
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

async function getJSON(path) {
  const res = await fetchWithTimeout(`${API_BASE}${path}`)
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    const err = new Error(detail.detail || `Request failed: ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

export async function getLocations(category) {
  const data = await snap.getLocations(category)
  if (!category) setLocationsSnapshot(data)
  return data
}

export async function searchLocations(q) {
  if (!q) return []
  try {
    const results = await getJSON(`/api/locations/search?q=${encodeURIComponent(q)}`)
    track('search', { query: q, result_count: results.length })
    return results
  } catch (err) {
    const cached = await getCachedBundleResource('locations')
    if (!cached) throw err
    // Offline degradation only — a plain substring match over name/
    // department/category, not a port of the backend's fuzzy/alias/
    // relevance-ranked search (data_access.py's search_locations). Good
    // enough that search isn't completely dead with no connection; not
    // meant to match backend results exactly.
    const ql = q.trim().toLowerCase()
    const results = cached.filter(l =>
      (l.name || '').toLowerCase().includes(ql) ||
      (l.department || '').toLowerCase().includes(ql) ||
      (l.category || '').toLowerCase().includes(ql)
    )
    track('search', { query: q, result_count: results.length, offline: true })
    return results
  }
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
// Default (VITE_ROUTING_MODE=client): every route and reroute is computed in
// the browser by offline/offlineRouter.js — a port of backend/utils/router.py
// — over the bundled walkway graph and the cached road closures. No request
// is made. getRoute/getRouteFromCoords keep returning Promises so existing
// callers are unchanged; getRouteSync/getRouteFromCoordsSync return the route
// directly for the one caller that must apply it within the same tick
// (LocationProvider's automatic reroute).
//
// VITE_ROUTING_MODE=server (escape hatch): ask GET /api/route first, exactly
// as before client routing, and compute on-device only if that request fails.
// Client mode never falls back to the server — a client-side error (e.g. an
// unknown destination) is surfaced as-is, never papered over by a request.
//
// `meta.isReroute` distinguishes an automatic on-route recalculation
// (LocationProvider.jsx) from a user-initiated route request in the
// analytics summary; the route_requested / reroute event is logged here, in
// one place, for both modes.
function _trackRoute(meta, r, usedServerFallback) {
  track(meta.isReroute ? 'reroute' : 'route_requested', {
    destination_id: meta.toId ?? null,
    from_id: meta.fromId ?? null,
    from_gps: !!meta.fromGps,
    distance_m: r.distance_m,
    eta_minutes: r.eta_minutes,
    accuracy_m: meta.accuracyM ?? null,
    snapped_to: r.snapped_to ?? null,
    warning: !!r.warning,
    offline: usedServerFallback, // true only when server mode had to fall back to on-device routing
    routing_mode: ROUTING_MODE,
  })
}

async function _serverFirst(query, meta, local) {
  let r
  let usedFallback = false
  try {
    r = await getJSON(`/api/route?${query}`)
  } catch (networkErr) {
    try {
      await prepareClientRouting()
      r = local()
      usedFallback = true
    } catch {
      throw networkErr
    }
  }
  _trackRoute(meta, r, usedFallback)
  return r
}

function _clientRoute(meta, local) {
  const r = local()
  _trackRoute(meta, r, false)
  return r
}

/** Synchronous, client-mode-only. Throws on failure. */
export function getRouteSync(fromId, toId, meta = {}) {
  getRoadSegments().catch(() => {})
  return _clientRoute({ ...meta, fromId, toId }, () => routeToLocationSync(fromId, toId))
}

export async function getRoute(fromId, toId, meta = {}) {
  const m = { ...meta, fromId, toId }
  const local = () => routeToLocationSync(fromId, toId)
  if (ROUTING_MODE === 'client') {
    await prepareClientRouting()
    return _clientRoute(m, local)
  }
  return _serverFirst(`from_id=${encodeURIComponent(fromId)}&to_id=${encodeURIComponent(toId)}`, m, local)
}

/** Synchronous, client-mode-only equivalent of getRouteFromCoords. Throws on
 *  failure. Used by LocationProvider's reroute so the new route is applied in
 *  the same tick it's computed — there is no in-flight request to go stale. */
export function getRouteFromCoordsSync(lat, lng, toId, accuracyM, preferNodeId, meta = {}) {
  // GPS reroutes apply within the same tick, using the latest subscribed road
  // status. The TTL-aware getter also revalidates it rather than retaining a
  // one-time startup copy. Initial async routes await this getter first.
  getRoadSegments().catch(() => {})
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
  if (ROUTING_MODE === 'client') {
    await prepareClientRouting()
    return _clientRoute(m, local)
  }
  const acc = accuracyM != null ? `&accuracy=${accuracyM}` : ''
  const prefer = preferNodeId ? `&prefer_node=${encodeURIComponent(preferNodeId)}` : ''
  return _serverFirst(`from_lat=${lat}&from_lng=${lng}&to_id=${encodeURIComponent(toId)}${acc}${prefer}`, m, local)
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

async function prepareClientRouting() {
  await Promise.all([getRoadSegments(), getLocations()])
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
