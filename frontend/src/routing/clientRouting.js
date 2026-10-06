/** Local routing over the validated IndexedDB graph; closures are refreshed
 * by the shared data subscriptions, independently of route requests. */
import { currentGraph, loadGraph } from './graphData'
import { routeBetweenLocations, routeFromPoint } from '../offline/offlineRouter'
import { getCachedBundleResource, setNavigationStatus } from '../offline/offlineBundle'
import { getLocations, getClosures, subscribe } from '../data/dataClient'

let roadSegments = []
let roadSegmentsReady = false
let locationsById = new Map()
let ready = null

subscribe('closures', setRoadSegmentsSnapshot)
subscribe('locations', setLocationsSnapshot)

/** Only startup/bootstrap awaits input loading. Subsequent routes use memory;
 * graph and closure synchronization never belongs to a GPS/request tick. */
export function prepareClientRouting() {
  if (ready) return ready
  ready = (async () => {
    const [locs, segs] = await Promise.all([getLocations(), getClosures()])
    setLocationsSnapshot(locs)
    setRoadSegmentsSnapshot(segs)
    await loadGraph(locs)
    const [graph, cachedLocs, cachedSegs] = await Promise.all(['graph', 'locations', 'road-segments'].map(getCachedBundleResource))
    setNavigationStatus({ hasCache: !!(graph && cachedLocs && cachedSegs) })
  })().catch(error => { ready = null; throw error })
  return ready
}

/** Latest road open/closed state (GET /api/road-segments shape). */
export function setRoadSegmentsSnapshot(data) {
  if (!Array.isArray(data)) return
  roadSegments = data
  roadSegmentsReady = true
}

export function getRoadSegmentsSnapshot() {
  return roadSegments
}

/** Latest unfiltered locations list (GET /api/locations shape). */
export function setLocationsSnapshot(list) {
  if (!Array.isArray(list)) return
  locationsById = new Map(list.map((l) => [l.id, l]))
}

function requireRoadStatus() {
  if (!roadSegmentsReady) throw new Error('Road status is still loading. Please retry shortly.')
}

/** Equivalent of GET /api/route?from_id=…&to_id=…, computed synchronously. */
export function routeToLocationSync(fromId, toId) {
  requireRoadStatus()
  return routeBetweenLocations(currentGraph(), roadSegments, locationsById, fromId, toId)
}

/** Equivalent of GET /api/route?from_lat=…&from_lng=…&to_id=…&accuracy=…&prefer_node=…,
 *  computed synchronously. */
export function routeFromCoordsSync(lat, lng, toId, accuracyM, preferNodeId) {
  requireRoadStatus()
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Invalid coordinates')
  return routeFromPoint(currentGraph(), roadSegments, locationsById, lat, lng, toId, {
    accuracyM: accuracyM ?? null,
    preferNodeId: preferNodeId ?? null,
  })
}
