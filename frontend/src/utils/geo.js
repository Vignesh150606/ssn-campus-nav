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

// How much straight-line "cost" (metres) is charged per metre a candidate
// point's walking-distance-along-the-path sits away from the last matched
// position. A candidate has to be substantially closer in a straight line
// to win over simply continuing forward along the path already being
// followed. Tuned so a ~10-15m parallel leg (a typical hairpin/U-turn
// width) is never worth jumping to for a few metres of extra straight-line
// proximity, while a genuine, large forward step (normal walking, several
// seconds between fixes) still costs very little.
const NEAREST_INDEX_CONTINUITY_WEIGHT = 0.5
// If even the continuity-weighted winner is this far away in a straight
// line, `previousIndex` context is untrustworthy (e.g. right after a
// route swap, or the very first fix) — fall back to a plain nearest-point
// match instead of forcing a bad one.
const NEAREST_INDEX_FALLBACK_M = 60

function plainNearest(lat, lng, path) {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < path.length; i++) {
    const d = haversine(lat, lng, path[i].lat, path[i].lng)
    if (d < bestDist) { bestDist = d; best = i }
  }
  return { index: best, distance: bestDist }
}

/**
 * Find the closest point on `path` to (lat, lng).
 *
 * `previousIndex`, when supplied, biases the match toward continuing
 * along the path from roughly where it left off, instead of a pure
 * closest-point search. This matters anywhere the walkway graph loops or
 * folds back close to itself (a U-turn, two roughly-parallel paths a few
 * metres apart, a path that passes near an earlier stretch of itself) —
 * a plain nearest-VERTEX search has no notion of "which leg was I already
 * walking," so a few metres of GPS drift can flip the match to a
 * geometrically-close but topologically-distant vertex on the OTHER leg,
 * and slicing the path array from there draws a straight chord across to
 * it. This is generic route-progress matching, not tied to any one
 * location on campus — any route is susceptible wherever its own
 * geometry happens to fold back near itself, regardless of how densely
 * that stretch happens to be vertexed (an index-count "window" doesn't
 * reliably solve this — a tight hairpin can be only a few vertices apart
 * even though walking it is a real detour — so the bias here is instead
 * weighted by actual walking distance ALONG the path: `previousIndex`'s
 * cumulative distance vs. each candidate's, not its array index).
 *
 * Omit `previousIndex` (or pass null) for a plain unconstrained nearest-
 * point search — correct for "first fix against a brand-new route" or any
 * other one-off lookup with no prior position to be continuous with.
 */
export function nearestIndex(lat, lng, path, previousIndex = null) {
  if (previousIndex == null || previousIndex < 0 || previousIndex >= path.length) {
    return plainNearest(lat, lng, path)
  }

  // Cumulative walking distance from index 0 -- computed once per call so
  // "how far along the path is index i from index j" is an O(1) lookup
  // for every candidate below, rather than re-walking the path per
  // candidate.
  const cumulative = new Array(path.length)
  cumulative[0] = 0
  for (let i = 1; i < path.length; i++) {
    cumulative[i] = cumulative[i - 1] + haversine(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng)
  }
  const prevArc = cumulative[previousIndex]

  let best = 0
  let bestScore = Infinity
  let bestStraightDist = Infinity
  for (let i = 0; i < path.length; i++) {
    const straight = haversine(lat, lng, path[i].lat, path[i].lng)
    const arcDeviation = Math.abs(cumulative[i] - prevArc)
    const score = straight + NEAREST_INDEX_CONTINUITY_WEIGHT * arcDeviation
    if (score < bestScore) { bestScore = score; best = i; bestStraightDist = straight }
  }

  if (bestStraightDist > NEAREST_INDEX_FALLBACK_M) {
    // Even continuity-weighted, nothing plausible was found near the
    // reported position -- previousIndex no longer means anything for
    // this array (e.g. a fresh route was just swapped in). Fall back to
    // a plain nearest-point match rather than force a distant one.
    return plainNearest(lat, lng, path)
  }

  return { index: best, distance: bestStraightDist }
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
