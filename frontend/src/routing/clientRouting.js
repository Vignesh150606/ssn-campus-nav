/**
 * clientRouting.js — the on-device routing service: the bundled graph + the
 * two live inputs the router needs (road closures, location names) held in
 * memory so a route can be computed synchronously, with no await and no
 * request.
 *
 * Inputs:
 *   graph          bundled at build time (./graphData.js) — never fetched.
 *   road closures  the one input that changes at runtime. Today they come
 *                  from the existing GET /api/road-segments, fetched by the
 *                  normal app-start calls to api.js getRoadSegments() (which
 *                  hands each result to setRoadSegmentsSnapshot below) and
 *                  mirrored to IndexedDB, so a cold start with no network
 *                  still has the last-known closures. This is the single
 *                  seam to change when closures move to a static snapshot.
 *                  Initial routes await the snapshot/live/cache getter in
 *                  api.js; foreground subscriptions keep reroutes current.
 *                  Missing road status is never assumed to mean all-open.
 *   locations      only used to fill the from/to names in the response
 *                  (same shape as GET /api/route); routing itself doesn't
 *                  need them, and a missing one degrades to the id.
 */
import { WALKWAY_GRAPH } from './graphData'
import { routeBetweenLocations, routeFromPoint } from '../offline/offlineRouter'
import { getCachedBundleResource } from '../offline/offlineBundle'

let roadSegments = []
let roadSegmentsReady = false
let roadSegmentsSetAt = 0 // 0 = nothing received this session yet
let locationsById = new Map()
let locationsSetAt = 0

/** Latest road open/closed state (GET /api/road-segments shape). */
export function setRoadSegmentsSnapshot(data) {
  if (!Array.isArray(data)) return
  roadSegments = data
  roadSegmentsReady = true
  roadSegmentsSetAt = Date.now()
}

export function getRoadSegmentsSnapshot() {
  return roadSegments
}

/** Latest unfiltered locations list (GET /api/locations shape). */
export function setLocationsSnapshot(list) {
  if (!Array.isArray(list)) return
  locationsById = new Map(list.map((l) => [l.id, l]))
  locationsSetAt = Date.now()
}

// Cold start: load whatever a previous session cached in IndexedDB. A
// fresher in-memory snapshot (set while this is still in flight) always wins.
async function hydrateFromCache() {
  const [segs, locs] = await Promise.all([
    getCachedBundleResource('road-segments'),
    getCachedBundleResource('locations'),
  ])
  if (!roadSegmentsSetAt && Array.isArray(segs)) {
    roadSegments = segs
    roadSegmentsReady = true
  }
  if (!locationsSetAt && Array.isArray(locs)) locationsById = new Map(locs.map((l) => [l.id, l]))
}
if (typeof indexedDB !== 'undefined') hydrateFromCache().catch(() => {})

function requireRoadStatus() {
  if (!roadSegmentsReady) throw new Error('Road status is still loading. Please retry shortly.')
}

/** Equivalent of GET /api/route?from_id=…&to_id=…, computed synchronously. */
export function routeToLocationSync(fromId, toId) {
  requireRoadStatus()
  return routeBetweenLocations(WALKWAY_GRAPH, roadSegments, locationsById, fromId, toId)
}

/** Equivalent of GET /api/route?from_lat=…&from_lng=…&to_id=…&accuracy=…&prefer_node=…,
 *  computed synchronously. */
export function routeFromCoordsSync(lat, lng, toId, accuracyM, preferNodeId) {
  requireRoadStatus()
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Invalid coordinates')
  return routeFromPoint(WALKWAY_GRAPH, roadSegments, locationsById, lat, lng, toId, {
    accuracyM: accuracyM ?? null,
    preferNodeId: preferNodeId ?? null,
  })
}
