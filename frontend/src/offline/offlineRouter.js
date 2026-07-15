/**
 * offlineRouter.js — client-side routing fallback, used ONLY when
 * /api/route can't be reached (see api.js).
 *
 * Phase X (Feature 1 — Offline-First Experience).
 *
 * IMPORTANT — this is deliberately NOT a port of backend/utils/router.py.
 * That engine is explicitly out of scope for this phase (production-stable,
 * "do not touch") and is intentionally more sophisticated than this needs
 * to be offline: its `_nearest_node` snap logic carries several hard-won,
 * narrowly-targeted fixes for live-GPS edge cases (see that file's
 * docstring) that only matter for a continuously-updating live position,
 * not for graceful offline degradation. Reimplementing all of that here
 * would be exactly the kind of duplicated, drift-prone logic this phase's
 * brief asks to avoid.
 *
 * What this DOES mirror faithfully, because it materially changes the
 * route: Dijkstra over the same graph shape, the road-closure penalty, and
 * the hostel-road penalty — using the same graph/location/road-segment data
 * the backend serves (cached via offlineBundle.js), so an offline route is
 * still "the shortest currently-open walking path", just snapped to the
 * single nearest node by straight-line distance rather than the backend's
 * multi-candidate, accuracy-aware tie-break.
 *
 * Returns the same shape as GET /api/route so every caller of
 * getRoute/getRouteFromCoords in api.js can stay agnostic to where the
 * route actually came from.
 */

const HOSTEL_DEST = new Set(['boys-hostel-gate', 'boys-hostel-office'])
const HOSTEL_PENALTY = 8.0
const CLOSURE_PENALTY = 999999.0
const WALKING_MPS = 1.4
const EARTH_R = 6371000

function haversine(lat1, lng1, lat2, lng2) {
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dp = ((lat2 - lat1) * Math.PI) / 180
  const dl = ((lng2 - lng1) * Math.PI) / 180
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.sqrt(a))
}

function pathLength(pts) {
  let d = 0
  for (let i = 0; i < pts.length - 1; i++) {
    d += haversine(pts[i].lat, pts[i].lng, pts[i + 1].lat, pts[i + 1].lng)
  }
  return d
}

function inBbox(lat, lng, bbox) {
  return lat >= bbox.lat_min && lat <= bbox.lat_max && lng >= bbox.lng_min && lng <= bbox.lng_max
}

function buildAdjacency(graph, roadSegments, toId) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
  const closedBboxes = (roadSegments || []).filter((s) => s.closed).map((s) => s.bbox)
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
    const nf = nodes.get(e.from)
    const nt = nodes.get(e.to)
    if (nf && nt && closedBboxes.length) {
      for (const bb of closedBboxes) {
        if (inBbox(nf.lat, nf.lng, bb) && inBbox(nt.lat, nt.lng, bb)) {
          w += CLOSURE_PENALTY
          break
        }
      }
    }
    if (e.hostel_only && !goingToHostel) w *= HOSTEL_PENALTY
    add(e.from, e.to, w, e.path)
  }
  for (const e of graph.location_edges || []) {
    add(e.from, e.to, e.distance_m, e.path)
  }
  return adj
}

function dijkstra(adj, fromId, toId) {
  const dist = new Map([[fromId, 0]])
  const prev = new Map()
  // Simple binary-heap-free priority queue — fine at this graph size
  // (a few hundred nodes; router.py's own comment notes the same for its
  // plain nearest-node scan).
  const visited = new Set()
  while (true) {
    let u = null
    let best = Infinity
    for (const [node, d] of dist) {
      if (!visited.has(node) && d < best) {
        best = d
        u = node
      }
    }
    if (u === null) break
    visited.add(u)
    if (u === toId) break
    for (const [v, w] of adj.get(u) || []) {
      const nd = best + w
      if (nd < (dist.has(v) ? dist.get(v) : Infinity)) {
        dist.set(v, nd)
        prev.set(v, u)
      }
    }
  }
  return { dist, prev }
}

function stitch(adj, seq) {
  let fullPath = []
  let realDist = 0
  for (let i = 0; i < seq.length - 1; i++) {
    const a = seq[i]
    const b = seq[i + 1]
    const edge = (adj.get(a) || []).find(([nb]) => nb === b)
    if (!edge) continue
    const pts = edge[2]
    fullPath = fullPath.length ? fullPath.concat(pts.slice(1)) : pts.slice()
    realDist += pathLength(pts)
  }
  return { fullPath, realDist }
}

function nearestNode(graph, lat, lng) {
  let bestId = null
  let bestDist = Infinity
  for (const n of graph.nodes) {
    const d = haversine(lat, lng, n.lat, n.lng)
    if (d < bestDist) {
      bestDist = d
      bestId = n.id
    }
  }
  return { id: bestId, dist: bestDist }
}

function closedWarning(roadSegments) {
  const closed = (roadSegments || []).filter((s) => s.closed).map((s) => s.name)
  return closed.length ? `Note: ${closed.join(', ')} is closed. Using alternate route.` : null
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

/** Offline equivalent of backend find_route(from_id, to_id). */
export function routeBetweenLocations(graph, roadSegments, locationsById, fromId, toId) {
  const adj = buildAdjacency(graph, roadSegments, toId)
  if (!adj.has(fromId)) throw new Error(`No road connection for '${fromId}' (offline)`)
  if (!adj.has(toId)) throw new Error(`No road connection for '${toId}' (offline)`)

  const { dist, prev } = dijkstra(adj, fromId, toId)
  if (!dist.has(toId)) throw new Error(`No offline path from '${fromId}' to '${toId}'`)

  const seq = reconstruct(prev, fromId, toId)
  const { fullPath, realDist } = stitch(adj, seq)
  const a = locationsById.get(fromId)
  const b = locationsById.get(toId)

  return {
    from: a ? { id: a.id, name: a.name, lat: a.lat, lng: a.lng } : { id: fromId, name: fromId, lat: null, lng: null },
    to: b ? { id: b.id, name: b.name, lat: b.lat, lng: b.lng } : { id: toId, name: toId, lat: null, lng: null },
    distance_m: Math.round(realDist * 10) / 10,
    eta_minutes: Math.round((realDist / WALKING_MPS / 60) * 10) / 10,
    path: fullPath,
    source: 'offline',
    warning: closedWarning(roadSegments),
    snapped_to: null,
  }
}

/** Offline equivalent of backend find_route_from_point(lat, lng, to_id). */
export function routeFromPoint(graph, roadSegments, locationsById, lat, lng, toId) {
  const adj = buildAdjacency(graph, roadSegments, toId)
  if (!adj.has(toId)) throw new Error(`No road connection for '${toId}' (offline)`)

  const snap = nearestNode(graph, lat, lng)
  if (snap.id === null) throw new Error('Offline walkway graph has no nodes to snap to')

  const { dist, prev } = dijkstra(adj, snap.id, toId)
  if (!dist.has(toId)) throw new Error(`No offline path from current location to '${toId}'`)

  const seq = reconstruct(prev, snap.id, toId)
  const { fullPath, realDist } = stitch(adj, seq)
  const snapNode = graph.nodes.find((n) => n.id === snap.id)
  const withSnapSegment = [{ lat, lng }, { lat: snapNode.lat, lng: snapNode.lng }].concat(fullPath.slice(1))
  const totalDist = realDist + snap.dist
  const b = locationsById.get(toId)

  return {
    from: { id: null, name: 'Current location', lat, lng },
    to: b ? { id: b.id, name: b.name, lat: b.lat, lng: b.lng } : { id: toId, name: toId, lat: null, lng: null },
    distance_m: Math.round(totalDist * 10) / 10,
    eta_minutes: Math.round((totalDist / WALKING_MPS / 60) * 10) / 10,
    path: withSnapSegment,
    source: 'offline',
    warning: closedWarning(roadSegments),
    snapped_to: snap.id,
  }
}
