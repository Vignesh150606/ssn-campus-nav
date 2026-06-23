/**
 * Shared geo-math helpers.
 *
 * These are pure functions with no React/DOM dependencies, used by both the
 * real GPS pipeline and the simulated (dev mode) pipeline in
 * `context/LocationProvider.jsx`, so the two never drift out of sync.
 */

const EARTH_RADIUS_M = 6371000

/** Great-circle distance between two lat/lng points, in metres. */
export function haversine(lat1, lng1, lat2, lng2) {
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dp = ((lat2 - lat1) * Math.PI) / 180
  const dl = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a))
}

/** Total length of a polyline (array of {lat,lng}), in metres. */
export function pathLength(points) {
  let total = 0
  for (let i = 0; i < points.length - 1; i++) {
    total += haversine(points[i].lat, points[i].lng, points[i + 1].lat, points[i + 1].lng)
  }
  return total
}

/** Index of the path point nearest to (lat,lng), plus the distance to it (metres). */
export function nearestIndex(lat, lng, path) {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < path.length; i++) {
    const d = haversine(lat, lng, path[i].lat, path[i].lng)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return { index: best, distance: bestDist }
}

/**
 * Destination point given a start coordinate, a bearing (degrees, 0 = north,
 * 90 = east), and a distance in metres. Used by the "Go Off Route" dev-mode
 * test to push the simulated position a known distance away from the path.
 */
export function destinationPoint(lat, lng, bearingDeg, distanceM) {
  const dByR = distanceM / EARTH_RADIUS_M
  const bearing = (bearingDeg * Math.PI) / 180
  const lat1 = (lat * Math.PI) / 180
  const lng1 = (lng * Math.PI) / 180

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dByR) + Math.cos(lat1) * Math.sin(dByR) * Math.cos(bearing)
  )
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(dByR) * Math.cos(lat1),
      Math.cos(dByR) - Math.sin(lat1) * Math.sin(lat2)
    )

  return { lat: (lat2 * 180) / Math.PI, lng: (lng2 * 180) / Math.PI }
}

/**
 * Initial bearing from point A to point B, in degrees (0 = north, 90 = east,
 * compass convention). Used by the navigation compass (bearing to
 * destination) and by turn-by-turn detection (bearing of each path segment).
 */
export function bearing(lat1, lng1, lat2, lng2) {
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dl = ((lng2 - lng1) * Math.PI) / 180
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  const deg = (Math.atan2(y, x) * 180) / Math.PI
  return (deg + 360) % 360
}

/** Smallest signed difference (degrees, -180..180) going from `a` to `b`. */
function angleDiff(a, b) {
  let d = (b - a) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

const TURN_ANGLE_THRESHOLD_DEG = 28 // bearing change sharper than this counts as a "turn"
const TURN_LOOKAHEAD_M = 250        // only look this far ahead along the remaining path

/**
 * Scans a remaining-path polyline for the next meaningful turn (a bearing
 * change sharper than TURN_ANGLE_THRESHOLD_DEG), within a lookahead window.
 *
 * This is a heuristic, not true turn-by-turn data (the dataset has no
 * street names or intersection metadata) — it finds where the walkway
 * geometry itself bends sharply and reports that as "the next turn".
 * Good enough for "turn left/right in 50m" style voice prompts on a small
 * campus path network; not a substitute for a real directions engine.
 *
 * Returns { distanceM, direction: 'left'|'right', turnIndex, lat, lng } for
 * the nearest qualifying turn, or null if the path is straight (or too
 * short) within the lookahead window.
 *
 * `lat`/`lng` are the coordinates of the turn point itself (path[i]). The
 * caller is given these specifically so it has a stable, route-position-
 * based identifier to key on — `turnIndex` is only the index within
 * whatever array was passed in, which is *not* stable across calls if the
 * caller passes a shrinking "remaining path" slice (the same physical turn
 * ends up at a different index every tick as points fall off the front of
 * the slice). lat/lng of the turn point don't change tick to tick, so
 * they're safe to use as a dedup key.
 */
export function computeUpcomingTurn(path) {
  if (!path || path.length < 3) return null

  let cumulative = 0
  for (let i = 1; i < path.length - 1; i++) {
    const segLen = haversine(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng)
    if (i > 1) cumulative += segLen
    if (cumulative > TURN_LOOKAHEAD_M) break

    const bearingIn  = bearing(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng)
    const bearingOut = bearing(path[i].lat, path[i].lng, path[i + 1].lat, path[i + 1].lng)
    const diff = angleDiff(bearingIn, bearingOut)

    if (Math.abs(diff) >= TURN_ANGLE_THRESHOLD_DEG) {
      const distanceToTurn = cumulative + haversine(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng)
      return {
        distanceM: Math.round(distanceToTurn),
        direction: diff > 0 ? 'right' : 'left',
        turnIndex: i,
        lat: path[i].lat,
        lng: path[i].lng,
      }
    }
  }
  return null
}

/**
 * Walk a given distance (metres) along a polyline starting from its first
 * point, returning the {lat,lng} at that cumulative distance. If the
 * distance exceeds the path length, returns the final point. Used to drive
 * "Auto Walk" — each tick advances a fixed number of metres along the route.
 */
export function pointAtDistanceAlongPath(path, distanceM) {
  if (!path?.length) return null
  if (distanceM <= 0) return { lat: path[0].lat, lng: path[0].lng }

  let remaining = distanceM
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]
    const b = path[i + 1]
    const segLen = haversine(a.lat, a.lng, b.lat, b.lng)
    if (segLen >= remaining) {
      const t = segLen === 0 ? 0 : remaining / segLen
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }
    }
    remaining -= segLen
  }
  const last = path[path.length - 1]
  return { lat: last.lat, lng: last.lng }
}
