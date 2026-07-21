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

// ─────────────────────────────────────────────────────────────────────────
// Map-matching — projects a live GPS point onto the route's own geometry
// instead of snapping to the nearest raw vertex.
//
// Root-cause note: the previous "current position on route" logic scanned
// every vertex in the WHOLE path on every GPS tick and had no memory of
// which part of the route the user was already on. Two failure modes fell
// out of that directly:
//   1. It measured distance to path VERTICES, not to the path itself — a
//      GPS point sitting exactly on a long straight segment, but far from
//      either endpoint, could be reported as "far from the route".
//   2. Wherever the route geometry passes close to a different, unrelated
//      part of itself (a corner, a path that loops back near a building —
//      exactly the IT Block/CSE Annexure/Open Air Theatre cluster in the
//      bug reports), a few metres of GPS noise could make the "nearest"
//      match jump to that unrelated part instead of staying on the
//      segment the user is actually walking. Every downstream value
//      (remaining path geometry, remaining distance, ETA, and the
//      turn-by-turn instruction, which is just computeUpcomingTurn() of
//      whatever remaining path this produced) inherited that discontinuity
//      on every single GPS tick — that's the mechanism behind the
//      diagonal/V-shaped route segments and the flickering turn
//      instructions reported in real-world testing.
//
// matchToPath() fixes both: it projects onto path SEGMENTS (not just
// vertices — projectOntoSegment below clamps the projection to the
// segment, so it's still well-defined at the ends), and — the important
// part — when given the previous tick's matched segment, it only searches
// a small window around it, so the match can only ever progress along the
// route the user is actually on rather than teleporting to a lookalike
// stretch elsewhere in the path.
// ─────────────────────────────────────────────────────────────────────────

/** Local flat-earth (equirectangular) projection, using the query point
 *  itself as the origin. Accurate to sub-metre precision over the scale
 *  of a single route segment (tens of metres) on a campus this size —
 *  this is ONLY used for the point-to-segment projection math below, not
 *  for any of the haversine distances the rest of the app already uses. */
function toLocalXY(lat, lng, originLat, originLng) {
  const cosLat = Math.cos((originLat * Math.PI) / 180)
  const mPerDegLat = 110540
  const mPerDegLng = 111320 * cosLat
  return {
    x: (lng - originLng) * mPerDegLng,
    y: (lat - originLat) * mPerDegLat,
  }
}

/** Closest point to (lat,lng) on the segment [a,b] — clamped to the
 *  segment itself (t in [0,1]), not the infinite line through it.
 *  Returns { lat, lng, distance (metres), t }. */
export function projectOntoSegment(lat, lng, a, b) {
  const pa = toLocalXY(a.lat, a.lng, lat, lng)
  const pb = toLocalXY(b.lat, b.lng, lat, lng)
  const abx = pb.x - pa.x, aby = pb.y - pa.y
  const lenSq = abx * abx + aby * aby
  let t = lenSq === 0 ? 0 : (-pa.x * abx + -pa.y * aby) / lenSq
  t = Math.max(0, Math.min(1, t))
  const projX = pa.x + abx * t
  const projY = pa.y + aby * t
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
    distance: Math.hypot(projX, projY),
    t,
  }
}

// How far around the previous match to search on subsequent ticks.
// Backward slack is small (routes don't need to reconsider segments the
// user has clearly already passed) but non-zero (a stationary/slow-moving
// user's noisy fix can legitimately project slightly behind the last
// match). Forward slack is generous — large enough to comfortably cover a
// normal walking pace between GPS ticks — but still bounded, so a genuinely
// wrong turn is left for off-route detection to catch rather than the
// matcher quietly "finding" a plausible-looking segment far down the route.
const MATCH_WINDOW_BACK_SEGMENTS = 2
const MATCH_WINDOW_FORWARD_SEGMENTS = 25

/**
 * Match a live GPS point onto `path`, constrained to a window around
 * `searchFromIndex` (the previous tick's matched segment index) when
 * supplied. Pass `null` for the first match of a route (or right after a
 * reroute, when `path` itself is new) — that does one unconstrained,
 * whole-path search to establish an initial position.
 *
 * Returns { segmentIndex, point: {lat,lng}, distance (perpendicular
 * distance from (lat,lng) to the matched point, metres), cumulativeDistanceM
 * (arc length from path[0] to the matched point) }, or null if `path` has
 * fewer than 2 points.
 */
export function matchToPath(lat, lng, path, searchFromIndex = null) {
  if (!path || path.length < 2) return null

  const lastSegment = path.length - 2
  const lo = searchFromIndex == null ? 0 : Math.max(0, searchFromIndex - MATCH_WINDOW_BACK_SEGMENTS)
  const hi = searchFromIndex == null ? lastSegment : Math.min(lastSegment, searchFromIndex + MATCH_WINDOW_FORWARD_SEGMENTS)

  // Zero-length segments (two consecutive path points that round to the
  // same lat/lng) have no direction to project onto — skip them as match
  // candidates so a real, direction-bearing neighbour always wins instead.
  // build_walkway_graph.py's dedupe_consecutive_points now prevents this
  // in the shipped graph data at the source, but this also covers the
  // rarer coincidence of a live GPS fix landing exactly on a path vertex
  // (which makes the segment before and after it briefly indistinguishable
  // in remainingPathFromMatch's output) — belt-and-braces for whatever
  // path this function is ever handed.
  const DEGENERATE_SEGMENT_M = 0.1
  let best = null
  for (let i = lo; i <= hi; i++) {
    if (haversine(path[i].lat, path[i].lng, path[i + 1].lat, path[i + 1].lng) < DEGENERATE_SEGMENT_M) continue
    const proj = projectOntoSegment(lat, lng, path[i], path[i + 1])
    if (!best || proj.distance < best.distance) {
      best = { segmentIndex: i, point: { lat: proj.lat, lng: proj.lng }, distance: proj.distance }
    }
  }
  // Every candidate segment in the window was degenerate (pathological,
  // e.g. a 1-point-effective path) — fall back to the first one so this
  // still returns a usable match rather than dropping tracking entirely.
  if (!best) {
    const proj = projectOntoSegment(lat, lng, path[lo], path[lo + 1])
    best = { segmentIndex: lo, point: { lat: proj.lat, lng: proj.lng }, distance: proj.distance }
  }

  let cumulative = 0
  for (let i = 0; i < best.segmentIndex; i++) {
    cumulative += haversine(path[i].lat, path[i].lng, path[i + 1].lat, path[i + 1].lng)
  }
  cumulative += haversine(path[best.segmentIndex].lat, path[best.segmentIndex].lng, best.point.lat, best.point.lng)

  return { segmentIndex: best.segmentIndex, point: best.point, distance: best.distance, cumulativeDistanceM: cumulative }
}

/** Builds the "remaining route" polyline from a match: starts exactly at
 *  the matched (on-route) point — not the raw, possibly-off-to-the-side
 *  GPS coordinate, and not a distant vertex — followed by the untouched
 *  remaining vertices of the original path. This is what keeps the
 *  rendered blue line glued to the actual route geometry tick to tick
 *  instead of re-deriving a new shape (and a new upcoming-turn
 *  calculation) from wherever the last GPS sample happened to land. */
export function remainingPathFromMatch(path, match) {
  if (!match) return path
  return [match.point, ...path.slice(match.segmentIndex + 1)]
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

    // A degenerate incoming segment (path[i-1] and path[i] effectively the
    // same point — see matchToPath's comment above for how this can arise
    // even with clean graph data) has no real bearing: bearing() between
    // identical points is undefined and returns a bogus 0°, which then
    // reads as a large, wrong angleDiff against whatever bearingOut
    // actually is. Skip evaluating a turn at this vertex rather than
    // trusting that reading — the real turn, if any, is still correctly
    // found a few points later once a genuine bearingIn is available.
    if (segLen < 0.1) {
      cumulative += segLen
      continue
    }

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
    const segLen = haversine(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng)
    cumulative += segLen
    // See computeUpcomingTurn's comment above for why a near-zero-length
    // incoming segment must be skipped rather than treated as a real turn.
    if (segLen < 0.1) continue
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
