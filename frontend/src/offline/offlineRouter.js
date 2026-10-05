/**
 * offlineRouter.js — the browser-side campus router. This is the DEFAULT
 * router for the app (see ../routing/clientRouting.js and api.js): route,
 * reroute, nearest-node snapping and the junction flags turn instructions
 * are gated on all run here, on-device, with no network involved.
 *
 * It is a behavioural port of backend/utils/router.py, which remains the
 * source of truth — when the two disagree, Python wins unless Python is
 * shown to be wrong, in which case that gets reported rather than silently
 * "fixed" on one side only. The port covers, function for function:
 *
 *   router.py                         here
 *   ───────────────────────────────   ───────────────────────────────────
 *   _node_degree                      nodeDegree (via derive())
 *   _build_adj                        buildAdj (closure penalty, hostel
 *                                     road penalty, location edges)
 *   _dijkstra                         dijkstra (binary heap ordered by
 *                                     (cost, node id) — see below)
 *   _stitch                           stitch (id/junction annotation,
 *                                     junction = degree >= 3)
 *   _nearest_node                     nearestNode (SNAP_MARGIN_M shortlist,
 *                                     UNVERIFIED_CONNECTOR_CAP_M caps,
 *                                     accuracy-gated closest-vs-best check,
 *                                     prefer_node stickiness, capped-node
 *                                     fallback)
 *   find_route                        findRoute
 *   find_route_from_point             findRouteFromPoint
 *
 * Things that look incidental but are what make the output match
 * bit-for-bit (they are exercised by scripts/routing_parity/parity.mjs):
 *  - Dijkstra ties: Python's heapq orders (cost, node_id) tuples, so equal-
 *    cost alternatives resolve by node id. The heap here uses the same
 *    total order; a plain "first minimum found" scan would not.
 *  - math.radians(x) in CPython is x * (pi / 180), not (x * pi) / 180.
 *  - round(x, 1) in Python rounds the exact binary value, half-to-even;
 *    Math.round(x * 10) / 10 differs on values like 0.35 and 12.25.
 *
 * This module deliberately has no browser, React or network dependency so
 * Node can import the very same file for the parity test.
 */

// ── Constants (must equal router.py's; the parity script asserts it) ──────
export const HOSTEL_DEST = new Set(['boys-hostel-gate', 'boys-hostel-office'])
export const HOSTEL_PENALTY = 8.0
export const CLOSURE_PENALTY = 999999.0 // effectively blocked, but still allows a fallback path
export const WALKING_MPS = 1.4
export const NEAREST_NODE_CANDIDATES = 8
export const SNAP_MARGIN_M = 30
export const STICKY_MIN_MARGIN_M = 20

// Field-verified per-node snap-distance caps — see the long evidence
// comment on UNVERIFIED_CONNECTOR_CAP_M in router.py before touching this.
export const UNVERIFIED_CONNECTOR_CAP_M = Object.freeze({
  n_136: 15.0,
  n_98: 15.0,
  n_128: 15.0,
  n_116: 15.0,
  n_127: 15.0,
  n_137: 15.0,
  n_193: 15.0,
  n_194: 15.0,
})

const EARTH_R = 6371000
const DEG2RAD = Math.PI / 180 // CPython: math.radians(x) == x * (pi / 180)
const INF_DIST = 1e18 // router.py's dist.get(v, 1e18)

function capFor(nodeId) {
  return Object.prototype.hasOwnProperty.call(UNVERIFIED_CONNECTOR_CAP_M, nodeId)
    ? UNVERIFIED_CONNECTOR_CAP_M[nodeId]
    : Infinity
}

// ── Geometry ──────────────────────────────────────────────────────────────

/** router.py _point_dist */
export function pointDist(lat1, lng1, lat2, lng2) {
  const p1 = lat1 * DEG2RAD
  const p2 = lat2 * DEG2RAD
  const dp = (lat2 - lat1) * DEG2RAD
  const dl = (lng2 - lng1) * DEG2RAD
  const sdp = Math.sin(dp / 2)
  const sdl = Math.sin(dl / 2)
  const a = sdp * sdp + Math.cos(p1) * Math.cos(p2) * sdl * sdl
  return 2 * EARTH_R * Math.asin(Math.sqrt(a))
}

/** router.py _path_length */
function pathLength(pts) {
  let d = 0
  for (let i = 0; i < pts.length - 1; i++) {
    d += pointDist(pts[i].lat, pts[i].lng, pts[i + 1].lat, pts[i + 1].lng)
  }
  return d
}

/** Python's round(x, 1): exact-binary-value rounding, ties to even. */
export function round1(x) {
  const q = x * 4
  if (Number.isInteger(q) && q % 2 !== 0) {
    // x is an odd multiple of 0.25 (12.25, 0.75, …): a true tie at one
    // decimal. toFixed() would pick the larger neighbour; Python picks even.
    const r = x * 10 // exact for these values
    const lo = Math.floor(r)
    return (lo % 2 === 0 ? lo : lo + 1) / 10
  }
  return Number(x.toFixed(1)) // correctly rounded for every non-tie value
}

// ── Per-graph derived data (router.py _graph_cache / _degree_cache) ───────

const derivedCache = new WeakMap()

function derive(graph) {
  let d = derivedCache.get(graph)
  if (d) return d
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  // _node_degree: distinct `edges` touching each node. location_edges are
  // deliberately NOT counted, same as Python.
  const degree = new Map()
  for (const e of graph.edges || []) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1)
    degree.set(e.to, (degree.get(e.to) || 0) + 1)
  }
  // _validate_cap_table_against_graph
  const missing = Object.keys(UNVERIFIED_CONNECTOR_CAP_M).filter((id) => !nodeById.has(id)).sort()
  if (missing.length && typeof console !== 'undefined') {
    console.warn(
      `UNVERIFIED_CONNECTOR_CAP_M references node ID(s) ${missing.join(', ')} that do not exist in ` +
      'the loaded walkway graph — those field-verified snap caps are silently NOT being applied.'
    )
  }
  d = { nodeById, degree }
  derivedCache.set(graph, d)
  return d
}

// ── Adjacency (router.py _build_adj) ──────────────────────────────────────

function inBbox(lat, lng, bb) {
  return bb.lat_min <= lat && lat <= bb.lat_max && bb.lng_min <= lng && lng <= bb.lng_max
}

function closedBboxes(roadSegments) {
  return (roadSegments || []).filter((s) => s && s.closed && s.bbox).map((s) => s.bbox)
}

function closedWarning(roadSegments) {
  const closed = (roadSegments || []).filter((s) => s && s.closed).map((s) => s.name)
  return closed.length ? `Note: ${closed.join(', ')} is closed. Using alternate route.` : null
}

function buildAdj(graph, roadSegments, toId) {
  const { nodeById } = derive(graph)
  const bboxes = closedBboxes(roadSegments)
  const goingToHostel = HOSTEL_DEST.has(toId)
  const adj = new Map()

  function add(a, b, w, path) {
    if (!adj.has(a)) adj.set(a, [])
    if (!adj.has(b)) adj.set(b, [])
    adj.get(a).push([b, w, path])
    adj.get(b).push([a, w, [...path].reverse()])
  }

  for (const e of graph.edges) {
    let w = e.distance_m
    const nf = nodeById.get(e.from)
    const nt = nodeById.get(e.to)
    // Closure: very high weight, not a hard block, so a path can still be
    // found when no alternative exists.
    if (nf && nt && bboxes.length) {
      for (const bb of bboxes) {
        if (inBbox(nf.lat, nf.lng, bb) && inBbox(nt.lat, nt.lng, bb)) {
          w += CLOSURE_PENALTY
          break
        }
      }
    }
    // Hostel road penalty — applied AFTER the closure penalty, as in Python.
    if (e.hostel_only && !goingToHostel) w *= HOSTEL_PENALTY
    add(e.from, e.to, w, e.path)
  }
  for (const e of graph.location_edges || []) {
    add(e.from, e.to, e.distance_m, e.path)
  }
  return adj
}

// ── Dijkstra (router.py _dijkstra) ────────────────────────────────────────

// Binary min-heap over [cost, nodeId], ordered exactly like Python's tuple
// comparison: cost first, then node id (string) as the tie-break.
function entryLess(a, b) {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
}

function heapPush(h, item) {
  h.push(item)
  let i = h.length - 1
  while (i > 0) {
    const p = (i - 1) >> 1
    if (!entryLess(h[i], h[p])) break
    ;[h[i], h[p]] = [h[p], h[i]]
    i = p
  }
}

function heapPop(h) {
  const top = h[0]
  const last = h.pop()
  if (h.length) {
    h[0] = last
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      if (l < h.length && entryLess(h[l], h[m])) m = l
      if (r < h.length && entryLess(h[r], h[m])) m = r
      if (m === i) break
      ;[h[i], h[m]] = [h[m], h[i]]
      i = m
    }
  }
  return top
}

function dijkstra(adj, fromId, toId) {
  const dist = new Map([[fromId, 0.0]])
  const prev = new Map()
  const pq = [[0.0, fromId]]
  while (pq.length) {
    const [d, u] = heapPop(pq)
    if (d > (dist.has(u) ? dist.get(u) : INF_DIST)) continue
    if (u === toId) break
    for (const [v, w] of adj.get(u) || []) {
      const nd = d + w
      if (nd < (dist.has(v) ? dist.get(v) : INF_DIST)) {
        dist.set(v, nd)
        prev.set(v, u)
        heapPush(pq, [nd, v])
      }
    }
  }
  return { dist, prev }
}

function reconstruct(prev, fromId, toId) {
  const seq = []
  let cur = toId
  while (prev.has(cur)) {
    seq.push(cur)
    cur = prev.get(cur)
  }
  seq.push(fromId)
  seq.reverse()
  return seq
}

// ── Path assembly (router.py _stitch) ─────────────────────────────────────

function stitch(adj, seq, degree) {
  let fullPath = []
  let realDist = 0.0
  for (let i = 0; i < seq.length - 1; i++) {
    const a = seq[i]
    const b = seq[i + 1]
    const edge = (adj.get(a) || []).find(([nb]) => nb === b)
    if (!edge) continue
    const pts = edge[2]
    const n = pts.length
    const annotated = pts.map((p, j) => {
      // Interior points are shape data, never graph nodes — never a turn.
      const id = j === 0 ? a : j === n - 1 ? b : null
      return { lat: p.lat, lng: p.lng, id, junction: id !== null && (degree.get(id) || 0) >= 3 }
    })
    fullPath = fullPath.length ? fullPath.concat(annotated.slice(1)) : annotated
    realDist += pathLength(pts)
  }
  return { fullPath, realDist }
}

// ── Nearest-node snapping (router.py _nearest_node) ───────────────────────

/**
 * Port of _nearest_node. Read its docstring in router.py for the field
 * evidence behind each rule; the structure below follows it step for step:
 *   1. shortlist: up to NEAREST_NODE_CANDIDATES nodes within SNAP_MARGIN_M
 *      of the closest, each also within its own UNVERIFIED_CONNECTOR_CAP_M;
 *   2. pick the lowest (snap distance + remaining route cost);
 *   3. accuracy gate: a non-closest winner must beat the closest candidate
 *      by more than (extra snap distance + the fix's own accuracy);
 *   4. stickiness: keep preferNodeId unless the winner beats it by more
 *      than STICKY_MIN_MARGIN_M — and only if it clears margin AND cap;
 *   5. nothing reachable: fall back to the nearest node that respects its
 *      cap (never the raw nearest — that was the round-6 regression).
 * Returns { id, dist }; id is null only if no node is usable at all.
 */
export function nearestNode(graph, lat, lng, adj = null, toId = null, accuracyM = null, preferNodeId = null) {
  const candidates = []
  for (const n of graph.nodes) candidates.push({ d: pointDist(lat, lng, n.lat, n.lng), id: n.id })
  if (!candidates.length) return { id: null, dist: null }
  candidates.sort((x, y) => x.d - y.d) // stable, like Python's list.sort

  if (adj === null || toId === null) return { id: candidates[0].id, dist: candidates[0].d }

  const nearestDist = candidates[0].d
  const shortlist = candidates
    .slice(0, NEAREST_NODE_CANDIDATES)
    .filter((c) => c.d <= nearestDist + SNAP_MARGIN_M && c.d <= capFor(c.id))

  let best = null // { id, total, snap }
  let closest = null
  for (const c of shortlist) {
    const { dist } = dijkstra(adj, c.id, toId)
    if (!dist.has(toId)) continue // this candidate can't reach the destination
    const total = c.d + dist.get(toId)
    if (closest === null) closest = { id: c.id, total, snap: c.d } // shortlist is distance-sorted
    if (best === null || total < best.total) best = { id: c.id, total, snap: c.d }
  }

  // Accuracy-gated closest-vs-best sanity check. accuracy_m is added to the
  // bar `improvement` must clear (a worse fix is MORE conservative); it does
  // not gate whether the check runs.
  if (accuracyM != null && best !== null && closest !== null && best.id !== closest.id) {
    const extraSnap = best.snap - closest.snap
    const improvement = closest.total - best.total
    if (improvement < extraSnap + accuracyM) best = closest
  }

  // Route-continuity stickiness. The preferred node must itself still be a
  // currently-nearby candidate AND within its own cap (the cap-bypass fix).
  if (preferNodeId != null && best !== null && preferNodeId !== best.id) {
    const pref = candidates.find((c) => c.id === preferNodeId)
    if (pref && pref.d <= nearestDist + SNAP_MARGIN_M && pref.d <= capFor(preferNodeId)) {
      const { dist } = dijkstra(adj, preferNodeId, toId)
      if (dist.has(toId)) {
        const preferTotal = pref.d + dist.get(toId)
        if (best.total >= preferTotal - STICKY_MIN_MARGIN_M) {
          best = { id: preferNodeId, total: preferTotal, snap: pref.d }
        }
      }
    }
  }

  if (best === null) {
    // Capped-node fallback fix: walk the FULL candidate list in distance
    // order and return the first node that respects its own cap.
    for (const c of candidates) {
      if (c.d <= capFor(c.id)) return { id: c.id, dist: c.d }
    }
    return { id: null, dist: null }
  }
  return { id: best.id, dist: best.snap }
}

// ── Public routing API ────────────────────────────────────────────────────

function roundedEta(realDist) {
  return round1(realDist / WALKING_MPS / 60)
}

/** router.py find_route — same keys as Python's result. */
export function findRoute(graph, roadSegments, fromId, toId) {
  const adj = buildAdj(graph, roadSegments, toId)
  if (!adj.has(fromId)) throw new Error(`No road connection for '${fromId}'`)
  if (!adj.has(toId)) throw new Error(`No road connection for '${toId}'`)

  const { dist, prev } = dijkstra(adj, fromId, toId)
  if (!dist.has(toId)) throw new Error(`No path from '${fromId}' to '${toId}'`)

  const seq = reconstruct(prev, fromId, toId)
  const { fullPath, realDist } = stitch(adj, seq, derive(graph).degree)
  return {
    path: fullPath,
    distance_m: round1(realDist),
    eta_minutes: roundedEta(realDist),
    junctions: [fromId, toId],
    warning: closedWarning(roadSegments),
  }
}

/** router.py find_route_from_point — same keys as Python's result. */
export function findRouteFromPoint(graph, roadSegments, lat, lng, toId, { accuracyM = null, preferNodeId = null } = {}) {
  const adj = buildAdj(graph, roadSegments, toId)
  if (!adj.has(toId)) throw new Error(`No road connection for '${toId}'`)

  const snap = nearestNode(graph, lat, lng, adj, toId, accuracyM, preferNodeId)
  if (snap.id === null) throw new Error('Walkway graph has no nodes to snap to')

  const { dist, prev } = dijkstra(adj, snap.id, toId)
  if (!dist.has(toId)) throw new Error(`No path from current location to '${toId}'`)

  const seq = reconstruct(prev, snap.id, toId)
  const { degree, nodeById } = derive(graph)
  const { fullPath, realDist: routeDist } = stitch(adj, seq, degree)

  // The live point is joined to the snapped node by one straight connector —
  // the only synthesized segment in the path. The live point is never a
  // junction; the snap node is a real node and gets a real flag.
  const snapNode = nodeById.get(snap.id)
  const path = [
    { lat, lng, id: null, junction: false },
    { lat: snapNode.lat, lng: snapNode.lng, id: snap.id, junction: (degree.get(snap.id) || 0) >= 3 },
  ].concat(fullPath.slice(1))

  const realDist = routeDist + snap.dist
  return {
    path,
    distance_m: round1(realDist),
    eta_minutes: roundedEta(realDist),
    junctions: [snap.id, toId],
    warning: closedWarning(roadSegments),
    snapped_to: snap.id,
    snap_distance_m: round1(snap.dist),
  }
}

// ── GET /api/route-shaped wrappers ────────────────────────────────────────

function locRef(locationsById, id) {
  const l = locationsById && locationsById.get(id)
  return l ? { id: l.id, name: l.name, lat: l.lat, lng: l.lng } : { id, name: id, lat: null, lng: null }
}

/** Client equivalent of GET /api/route?from_id=…&to_id=… */
export function routeBetweenLocations(graph, roadSegments, locationsById, fromId, toId) {
  const r = findRoute(graph, roadSegments, fromId, toId)
  return {
    from: locRef(locationsById, fromId),
    to: locRef(locationsById, toId),
    distance_m: r.distance_m,
    eta_minutes: r.eta_minutes,
    path: r.path,
    source: 'client',
    warning: r.warning,
    snapped_to: null,
  }
}

/** Client equivalent of GET /api/route?from_lat=…&from_lng=…&to_id=…
 *  (&accuracy=…&prefer_node=…) */
export function routeFromPoint(graph, roadSegments, locationsById, lat, lng, toId, opts = {}) {
  const r = findRouteFromPoint(graph, roadSegments, lat, lng, toId, opts)
  return {
    from: { id: null, name: 'Current location', lat, lng },
    to: locRef(locationsById, toId),
    distance_m: r.distance_m,
    eta_minutes: r.eta_minutes,
    path: r.path,
    source: 'client',
    warning: r.warning,
    snapped_to: r.snapped_to,
  }
}
