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
// Task 1 (offline support) — getLocations/getEvents/getRoadSegments/
// getGraph each cache their result via offline/offlineBundle.js the
// moment a network call succeeds, and fall back to that same cache if a
// later call fails. getRoute/getRouteFromCoords fall back to computing
// the route on-device via offline/offlineRouter.js, using whatever of
// that cached data is available. Every fallback below is genuinely
// best-effort: if nothing has ever been cached yet (a device's very
// first-ever launch, offline from the start), the original network error
// is what gets thrown, same as before this was added — see each
// function's own comment for specifics.

import { API_BASE } from './apiBase'
import { track } from './analytics/analyticsClient'
import { cacheBundleResource, getCachedBundleResource } from './offline/offlineBundle'
import { routeBetweenLocations, routeFromPoint } from './offline/offlineRouter'

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
  const q = category ? `?category=${encodeURIComponent(category)}` : ''
  try {
    const data = await getJSON(`/api/locations${q}`)
    // Only the unfiltered list is cached — every real caller in this app
    // (Home.jsx) always calls getLocations() with no category and filters
    // client-side, so caching a filtered subset under the same key would
    // silently corrupt the offline cache for everyone else. Guarded here
    // anyway rather than assumed, in case that ever changes.
    if (!category) cacheBundleResource('locations', data)
    return data
  } catch (err) {
    const cached = await getCachedBundleResource('locations')
    if (!cached) throw err
    return category
      ? cached.filter(l => (l.category || '').toLowerCase() === category.toLowerCase())
      : cached
  }
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

export async function getLocation(id) {
  try {
    return await getJSON(`/api/locations/${id}`)
  } catch (err) {
    const cached = await getCachedBundleResource('locations')
    const found = cached?.find(l => l.id === id)
    if (found) return found
    throw err
  }
}

export async function getEvents(fest) {
  const q = fest ? `?fest=${encodeURIComponent(fest)}` : ''
  try {
    const data = await getJSON(`/api/events${q}`)
    if (!fest) cacheBundleResource('events', data)
    return data
  } catch (err) {
    const cached = await getCachedBundleResource('events')
    if (!cached) throw err
    return fest ? cached.filter(e => (e.fest || '').toLowerCase() === fest.toLowerCase()) : cached
  }
}

export async function getEvent(id) {
  try {
    return await getJSON(`/api/events/${id}`)
  } catch (err) {
    const cached = await getCachedBundleResource('events')
    const found = cached?.find(e => e.id === id)
    if (found) return found
    throw err
  }
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
//
// Task 1 (offline support): if /api/route can't be reached at all,
// `offlineFallback` computes the same shape of response on-device via
// offline/offlineRouter.js, using whatever graph/locations/road-segments
// were cached from a previous successful online session (see
// loadOfflineRouteInputs below). If nothing has been cached yet, the
// fallback itself throws, and that error (not the original network one)
// is what the caller sees — its message says exactly that, since "no
// internet, and nothing to fall back to either" is a genuinely different
// situation from an ordinary network failure.
async function _routeQuery(query, meta, offlineFallback) {
  let r
  let usedOffline = false
  try {
    r = await getJSON(`/api/route?${query}`)
  } catch (networkErr) {
    try {
      r = await offlineFallback()
      usedOffline = true
    } catch {
      throw networkErr
    }
  }
  track(meta.isReroute ? 'reroute' : 'route_requested', {
    destination_id: meta.toId ?? null,
    from_id: meta.fromId ?? null,
    from_gps: !!meta.fromGps,
    distance_m: r.distance_m,
    eta_minutes: r.eta_minutes,
    accuracy_m: meta.accuracyM ?? null,
    snapped_to: r.snapped_to ?? null,
    warning: !!r.warning,
    offline: usedOffline,
  })
  return r
}

/** Loads the three inputs offline/offlineRouter.js needs, all previously
 *  cached by a successful getGraph/getRoadSegments/getLocations call.
 *  Throws (not returns null) when any of them is missing, since that's a
 *  genuinely different, more specific situation than "route request
 *  failed" — see _routeQuery above. */
async function loadOfflineRouteInputs() {
  const [graph, roadSegments, locations] = await Promise.all([
    getCachedBundleResource('graph'),
    getCachedBundleResource('road-segments'),
    getCachedBundleResource('locations'),
  ])
  if (!graph || !roadSegments || !locations) {
    throw new Error('No offline route data cached yet — connect to the internet at least once first.')
  }
  return { graph, roadSegments, locationsById: new Map(locations.map((l) => [l.id, l])) }
}

export function getRoute(fromId, toId, meta = {}) {
  return _routeQuery(
    `from_id=${encodeURIComponent(fromId)}&to_id=${encodeURIComponent(toId)}`,
    { ...meta, fromId, toId },
    async () => {
      const { graph, roadSegments, locationsById } = await loadOfflineRouteInputs()
      return routeBetweenLocations(graph, roadSegments, locationsById, fromId, toId)
    }
  )
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
 *  Omit it (the default) for a user-initiated route request.
 *
 *  Offline fallback note: offline/offlineRouter.js's snap-to-nearest-node
 *  is a simpler, single-candidate version of the backend's — it doesn't
 *  use accuracyM/preferNodeId (see that file's own docstring for why).
 *  Both are still accepted and forwarded to the real backend call above;
 *  they just have no effect on the one response that's computed offline. */
export function getRouteFromCoords(lat, lng, toId, accuracyM, preferNodeId, meta = {}) {
  const acc = accuracyM != null ? `&accuracy=${accuracyM}` : ''
  const prefer = preferNodeId ? `&prefer_node=${encodeURIComponent(preferNodeId)}` : ''
  return _routeQuery(
    `from_lat=${lat}&from_lng=${lng}&to_id=${encodeURIComponent(toId)}${acc}${prefer}`,
    { ...meta, toId, fromLat: lat, fromLng: lng, fromGps: true, accuracyM },
    async () => {
      const { graph, roadSegments, locationsById } = await loadOfflineRouteInputs()
      return routeFromPoint(graph, roadSegments, locationsById, lat, lng, toId)
    }
  )
}

/** Road segments (with open/closed state) — reused on the frontend to
 *  surface "passes through X road" entries in the route preview panel.
 *  Also one of the three inputs offline routing needs — see
 *  loadOfflineRouteInputs above. */
export async function getRoadSegments() {
  try {
    const data = await getJSON('/api/road-segments')
    cacheBundleResource('road-segments', data)
    return data
  } catch (err) {
    const cached = await getCachedBundleResource('road-segments')
    if (cached) return cached
    throw err
  }
}

/** The raw walkway graph (nodes/edges/location_edges) — added for Task 1
 *  (offline support). Nothing in the UI reads this directly; it exists
 *  purely so offline routing has a graph to compute over at all. Cached
 *  the same way as everything else above, no fallback of its own to
 *  return since a failed fetch here just means loadOfflineRouteInputs
 *  won't find anything cached under 'graph' yet either. */
export async function getGraph() {
  const data = await getJSON('/api/graph')
  cacheBundleResource('graph', data)
  return data
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
