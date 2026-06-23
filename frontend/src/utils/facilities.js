/**
 * Helpers for:
 *  - Feature 4 (Route Preview): "landmarks the route passes" — existing
 *    locations + named road segments near the route polyline.
 *  - Feature 5 (Nearby Facilities): nearest building that *contains* a
 *    restroom / water station, and the nearest standalone canteen.
 *
 * Per the data-model rule for this feature: restrooms and water stations
 * are NOT separate markers. Every building tagged with the facility lives
 * in locations.json with a `facilities: ["restroom", "water_station"]`
 * array (added to every academic block + the library). This file only
 * ever reads that field — it never invents a new coordinate.
 */
import { haversine } from './geo'

/** Distance (metres) from a point to the nearest vertex of a polyline.
 *  Good enough for "is this location near the route" at walking-path
 *  resolution — the route polylines already have closely spaced vertices. */
function distanceToPath(lat, lng, path) {
  let best = Infinity
  for (const p of path) {
    const d = haversine(lat, lng, p.lat, p.lng)
    if (d < best) best = d
  }
  return best
}

/** Index of the path vertex nearest to (lat, lng) — used to order landmarks
 *  by where they occur along the route, not by distance from the start. */
function nearestPathIndex(lat, lng, path) {
  let bestI = 0, best = Infinity
  for (let i = 0; i < path.length; i++) {
    const d = haversine(lat, lng, path[i].lat, path[i].lng)
    if (d < best) { best = d; bestI = i }
  }
  return bestI
}

const LANDMARK_RADIUS_M = 45
const SEGMENT_RADIUS_M  = 35

/**
 * Locations + road segments that the given route polyline passes near,
 * ordered by where they occur along the route. `excludeIds` should contain
 * the origin and destination ids so the destination doesn't list itself.
 */
export function landmarksAlongPath(path, locations, segments, excludeIds = []) {
  if (!path?.length) return []

  const locHits = locations
    .filter(l => !excludeIds.includes(l.id))
    .map(l => ({ ...l, _dist: distanceToPath(l.lat, l.lng, path), _kind: 'location' }))
    .filter(l => l._dist <= LANDMARK_RADIUS_M)

  const segHits = (segments || [])
    .filter(s => !s.closed)
    .map(s => {
      const cLat = (s.bbox.lat_min + s.bbox.lat_max) / 2
      const cLng = (s.bbox.lng_min + s.bbox.lng_max) / 2
      return { id: s.id, name: s.name, lat: cLat, lng: cLng, _dist: distanceToPath(cLat, cLng, path), _kind: 'segment' }
    })
    .filter(s => s._dist <= SEGMENT_RADIUS_M)

  return [...locHits, ...segHits]
    .map(h => ({ ...h, _order: nearestPathIndex(h.lat, h.lng, path) }))
    .sort((a, b) => a._order - b._order)
}

/** Nearest location (from `locations`) whose `facilities` array contains
 *  `facilityKey` (e.g. 'restroom' or 'water_station'). Returns
 *  { location, distanceM } or null if no building has that facility. */
export function nearestWithFacility(locations, fromLat, fromLng, facilityKey) {
  let best = null
  for (const loc of locations) {
    if (!loc.facilities?.includes(facilityKey)) continue
    const d = haversine(fromLat, fromLng, loc.lat, loc.lng)
    if (!best || d < best.distanceM) best = { location: loc, distanceM: d }
  }
  return best
}

/** Nearest standalone canteen — uses the existing 'dining' category and
 *  its real coordinates, no facility tagging needed. */
export function nearestCanteen(locations, fromLat, fromLng) {
  let best = null
  for (const loc of locations) {
    if (loc.category !== 'dining') continue
    const d = haversine(fromLat, fromLng, loc.lat, loc.lng)
    if (!best || d < best.distanceM) best = { location: loc, distanceM: d }
  }
  return best
}
