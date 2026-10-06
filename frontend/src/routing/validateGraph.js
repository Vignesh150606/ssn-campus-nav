import { pointDist, UNVERIFIED_CONNECTOR_CAP_M } from '../offline/offlineRouter'

// Reject incomplete updates, not just invalid JSON. Edges are undirected in
// both routers; a single connected walkway component is required on campus.
export function validateGraph(graph, locations = [], previousNodeIds = []) {
  const fail = (why) => { throw new Error(`Campus graph rejected: ${why}`) }
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.location_edges)) fail('missing arrays')
  if (!graph.nodes.length || !graph.edges.length || !graph.location_edges.length || graph.nodes.length > 5000 || graph.edges.length > 20000) fail('empty or oversized graph')
  const coordinate = p => p && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lng) && Math.abs(p.lng) <= 180
  const nodes = new Map(), adjacency = new Map(), coordinates = new Set()
  for (const n of graph.nodes) {
    if (typeof n.id !== 'string' || !n.id || nodes.has(n.id) || !coordinate(n)) fail('invalid/duplicate node')
    const key = `${n.lat},${n.lng}`
    if (coordinates.has(key)) fail('duplicate node coordinates')
    coordinates.add(key)
    nodes.set(n.id, n)
    adjacency.set(n.id, [])
  }
  for (const id of [...Object.keys(UNVERIFIED_CONNECTOR_CAP_M), ...previousNodeIds]) {
    if (!nodes.has(id)) fail('existing node ID/snap safety reference removed')
  }
  const edges = new Set(), connectedLocations = new Set()
  let points = 0
  function edge(e, connector) {
    if (!e || typeof e.from !== 'string' || typeof e.to !== 'string' || e.from === e.to) fail('invalid edge/self loop')
    if (!nodes.has(e.to) || (!connector && !nodes.has(e.from)) || (connector && nodes.has(e.from))) fail('unknown edge reference')
    const key = [e.from, e.to].sort().join('|')
    if (edges.has(key)) fail('duplicate edge')
    edges.add(key)
    if (!Number.isFinite(e.distance_m) || e.distance_m <= 0 || !Array.isArray(e.path) || e.path.length < 2 || e.path.some(p => !coordinate(p))) fail('invalid weight/geometry')
    if (e.hostel_only !== undefined && typeof e.hostel_only !== 'boolean') fail('invalid hostel restriction')
    points += e.path.length
    if (points > 100000) fail('oversized geometry')
    const start = connector ? locations.find(l => l.id === e.from) : nodes.get(e.from)
    if (connector && locations.length && !start) fail('unknown destination reference')
    const end = nodes.get(e.to)
    if ((start && pointDist(start.lat, start.lng, e.path[0].lat, e.path[0].lng) > 1) || pointDist(end.lat, end.lng, e.path.at(-1).lat, e.path.at(-1).lng) > 1) fail('geometry endpoint mismatch')
    let length = 0
    for (let i = 1; i < e.path.length; i++) {
      const a = e.path[i - 1], b = e.path[i]
      const d = pointDist(a.lat, a.lng, b.lat, b.lng)
      if (d <= 0) fail('duplicate path point')
      length += d
    }
    if (Math.abs(length - e.distance_m) > Math.max(1, length * 0.03)) fail('distance disagrees with geometry')
    if (connector) connectedLocations.add(e.from)
    else {
      adjacency.get(e.from).push(e.to)
      adjacency.get(e.to).push(e.from)
    }
  }
  graph.edges.forEach(e => edge(e, false))
  graph.location_edges.forEach(e => edge(e, true))
  const seen = new Set(), stack = [graph.nodes[0].id]
  while (stack.length) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...adjacency.get(id).filter(n => !seen.has(n)))
  }
  if (seen.size !== nodes.size) fail('disconnected walkway component')
  if (locations.some(l => !connectedLocations.has(l.id))) fail('unreachable campus destination')
  // JSON round-trip also removes any non-data values before persistence.
  return JSON.parse(JSON.stringify(graph))
}

export async function graphHash(graph) {
  const bytes = new TextEncoder().encode(JSON.stringify(graph))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}
