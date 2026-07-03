/**
 * Shared geo-math helpers.
 * Pure functions with no React/DOM dependencies.
 */

const EARTH_RADIUS_M = 6371000

export function haversine(lat1, lng1, lat2, lng2) {
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dp = ((lat2 - lat1) * Math.PI) / 180
  const dl = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a))
}

export function pathLength(points) {
  let total = 0
  for (let i = 0; i < points.length - 1; i++) {
    total += haversine(points[i].lat, points[i].lng, points[i + 1].lat, points[i + 1].lng)
  }
  return total
}

export function nearestIndex(lat, lng, path) {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < path.length; i++) {
    const d = haversine(lat, lng, path[i].lat, path[i].lng)
    if (d < bestDist) { bestDist = d; best = i }
  }
  return { index: best, distance: bestDist }
}

export function destinationPoint(lat, lng, bearingDeg, distanceM) {
  const dByR = distanceM / EARTH_RADIUS_M
  const brng = (bearingDeg * Math.PI) / 180
  const lat1 = (lat * Math.PI) / 180
  const lng1 = (lng * Math.PI) / 180
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dByR) + Math.cos(lat1) * Math.sin(dByR) * Math.cos(brng)
  )
  const lng2 = lng1 + Math.atan2(
    Math.sin(brng) * Math.sin(dByR) * Math.cos(lat1),
    Math.cos(dByR) - Math.sin(lat1) * Math.sin(lat2)
  )
  return { lat: (lat2 * 180) / Math.PI, lng: (lng2 * 180) / Math.PI }
}

export function bearing(lat1, lng1, lat2, lng2) {
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dl = ((lng2 - lng1) * Math.PI) / 180
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

function angleDiff(a, b) {
  let d = (b - a) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

// Phase 9 — corrected turn thresholds per spec:
// 0–20°  → Continue Straight  (skip, no turn)
// 20–45° → Slight Left / Slight Right
// 45–135°→ Turn Left / Turn Right
// 135°+  → U-Turn
const STRAIGHT_THRESHOLD_DEG = 20
const SLIGHT_THRESHOLD_DEG   = 45
const UTURN_THRESHOLD_DEG    = 135
const TURN_LOOKAHEAD_M       = 300  // extended from 250m

/**
 * Scan the remaining path for the next meaningful turn.
 * Returns { distanceM, direction, angleDeg, turnIndex, lat, lng }
 * where direction is one of: 'slight left', 'slight right', 'left', 'right', 'u-turn'
 * Returns null if path is straight within the lookahead window.
 *
 * Keyed on (lat, lng) of the turn point — stable across ticks unlike turnIndex.
 */
export function computeUpcomingTurn(path) {
  if (!path || path.length < 3) return null

  // Priority 6 (Phase 4.2.5) root-cause fix: `cumulative` must always mean
  // "distance from path[0] up to path[i-1]" — i.e. BEFORE the segment
  // currently being examined — so that `cumulative + segLen` is the
  // correct distance to path[i]. The previous version only added segLen
  // to cumulative when i>1, but ALSO re-added the same segment again in
  // the turn branch below — for i===1 this coincidentally cancelled out
  // and looked right, but for every turn at i>=2 it dropped the very
  // first segment of the path from the sum entirely while double-counting
  // the final segment into the turn, silently reporting the wrong
  // distance for every turn but the first one. The error is largest
  // exactly where Priority 6 asks to look closest — closely spaced
  // intersections/short segments — because a fixed-size double-count/drop
  // is a much bigger fraction of a short distance than a long one.
  let cumulative = 0
  for (let i = 1; i < path.length - 1; i++) {
    if (cumulative > TURN_LOOKAHEAD_M) break

    const segLen = haversine(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng)
    const bearingIn  = bearing(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng)
    const bearingOut = bearing(path[i].lat, path[i].lng, path[i + 1].lat, path[i + 1].lng)
    const diff    = angleDiff(bearingIn, bearingOut)
    const absDiff = Math.abs(diff)

    if (absDiff >= STRAIGHT_THRESHOLD_DEG) {
      const distanceToTurn = cumulative + segLen
      const isRight = diff > 0

      let direction
      if (absDiff >= UTURN_THRESHOLD_DEG) {
        direction = 'u-turn'
      } else if (absDiff >= SLIGHT_THRESHOLD_DEG) {
        direction = isRight ? 'right' : 'left'
      } else {
        direction = isRight ? 'slight right' : 'slight left'
      }

      return {
        distanceM: Math.round(distanceToTurn),
        direction,
        angleDeg: absDiff,
        turnIndex: i,
        lat: path[i].lat,
        lng: path[i].lng,
      }
    }

    cumulative += segLen
  }
  return null
}

export function pointAtDistanceAlongPath(path, distanceM) {
  if (!path?.length) return null
  if (distanceM <= 0) return { lat: path[0].lat, lng: path[0].lng }
  let remaining = distanceM
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1]
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

/**
 * Presentation-only helper for the "Fully Expanded" nav sheet tier — lists
 * every meaningful turn along the REMAINING route, not just the next one.
 * Same bearing-diff detection as computeUpcomingTurn, just without the
 * 300m lookahead cutoff / early return. Does not feed voice guidance, the
 * GPS off-route check, or routing in any way — it's a read-only summary of
 * the path array already computed by the router.
 */
export function computeAllTurns(path) {
  if (!path || path.length < 3) return []
  const turns = []
  let cumulative = 0
  for (let i = 1; i < path.length - 1; i++) {
    cumulative += haversine(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng)
    const bearingIn  = bearing(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng)
    const bearingOut = bearing(path[i].lat, path[i].lng, path[i + 1].lat, path[i + 1].lng)
    const diff    = angleDiff(bearingIn, bearingOut)
    const absDiff = Math.abs(diff)
    if (absDiff >= STRAIGHT_THRESHOLD_DEG) {
      const isRight = diff > 0
      let direction
      if (absDiff >= UTURN_THRESHOLD_DEG) direction = 'u-turn'
      else if (absDiff >= SLIGHT_THRESHOLD_DEG) direction = isRight ? 'right' : 'left'
      else direction = isRight ? 'slight right' : 'slight left'
      turns.push({ distanceM: Math.round(cumulative), direction, turnIndex: i, lat: path[i].lat, lng: path[i].lng })
    }
  }
  return turns
}
