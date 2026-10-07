// No credentials, .env loading, live network or additional dependencies.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const root = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = name => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url), 'utf8'))
const graph = read('graph'), locations = read('locations'), closures = read('closures')
const rows = new Map()
const realInterval = globalThis.setInterval, intervals = new Set()
globalThis.setInterval = (...args) => { const timer = realInterval(...args); intervals.add(timer); return timer }
let abortWrites = false, backendGraph = graph, liveClosures = closures, closureVersion = 0, calls = []
// Transaction-aware storage double. Real IndexedDB and SW are tested in Chrome.
globalThis.indexedDB = { open() {
  const request = {}
  queueMicrotask(() => {
    request.result = { objectStoreNames: { contains: () => true }, close() {}, transaction() {
      const transaction = { objectStore() { return { transaction,
        get(key) { const r = {}; queueMicrotask(() => { r.result = structuredClone(rows.get(key)); r.onsuccess?.() }); return r },
        put(value, key) { const r = {}; queueMicrotask(() => {
          r.onsuccess?.()
          if (abortWrites) { transaction.error = new Error('quota'); transaction.onabort?.() }
          else { rows.set(key, structuredClone(value)); transaction.oncomplete?.() }
        }); return r },
      } } }
      return transaction
    } }
    request.onsuccess?.()
  })
  return request
} }
globalThis.fetch = async url => {
  calls.push(String(url))
  if (url === '/data/graph.json') return Response.json(graph)
  if (url === '/data/locations.json') return Response.json(locations)
  if (url === '/data/closures.json') return Response.json(closures)
  if (String(url).endsWith('/snapshots/closures.json')) return Response.json({ schema: 1, version: ++closureVersion, data: liveClosures, meta: {} })
  if (String(url).endsWith('/api/graph')) return Response.json(backendGraph)
  if (String(url).endsWith('/api/road-segments')) return Response.json(liveClosures)
  throw new TypeError('Render completely unavailable')
}
const vite = await createServer({ root, configFile: false, envDir: false, optimizeDeps: { noDiscovery: true, entries: [] },
  define: { 'import.meta.env.VITE_API_BASE': JSON.stringify('https://api.invalid'),
    'import.meta.env.VITE_SNAPSHOT_BASE_URL': JSON.stringify('https://storage.invalid/snapshots') },
  server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
try {
  const validation = await vite.ssrLoadModule('/src/routing/validateGraph.js')
  assert.equal(validation.validateGraph(graph, locations).nodes.length, graph.nodes.length)
  const mutations = [
    g => { g.nodes.push(g.nodes[0]) },
    g => { g.nodes[0].lat = NaN },
    g => { g.edges[0].to = 'absent' },
    g => { g.edges[0].to = g.edges[0].from },
    g => { g.edges[0].distance_m = 0 },
    g => { g.edges.push(g.edges[0]) },
    g => { g.edges[0].distance_m *= 10 },
    g => { g.nodes.push({ id: 'isolated', lat: 12.751, lng: 80.197 }) },
    g => { g.location_edges.pop() },
    g => { g.edges[0].path = [] },
    g => {
      for (const n of g.nodes) n.id = `renamed_${n.id}`
      for (const e of g.edges) { e.from = `renamed_${e.from}`; e.to = `renamed_${e.to}` }
      for (const e of g.location_edges) e.to = `renamed_${e.to}`
    },
  ]
  for (const mutate of mutations) { const bad = structuredClone(graph); mutate(bad); assert.throws(() => validation.validateGraph(bad, locations)) }
  const api = await vite.ssrLoadModule('/src/api.js')
  const local = await vite.ssrLoadModule('/src/routing/clientRouting.js')
  const repository = await vite.ssrLoadModule('/src/routing/graphData.js')
  const connectivity = await vite.ssrLoadModule('/src/offline/offlineBundle.js')
  assert.equal(connectivity.getOfflineStatus().online, null, 'browser hint alone is not observed connectivity')
  await local.prepareClientRouting()
  assert(rows.get('graph').hash && rows.get('graph').version && rows.get('graph').cachedAt)
  const baseline = await api.getRoute('main-gate', 'cse-block')
  calls = []
  const start = performance.now()
  await Promise.all(Array.from({ length: 100 }, async () => {
    const route = await api.getRoute('main-gate', 'cse-block')
    assert.deepEqual(route.path, baseline.path)
    const reroute = api.getRouteFromCoordsSync(12.7522, 80.1975, 'cse-block', 10, null, { isReroute: true })
    assert(reroute.distance_m > 0 && reroute.path.length > 1)
  }))
  assert.equal(calls.filter(url => !url.includes('/api/analytics/events')).length, 0, '100 navigating users generate zero input or route fetches')
  console.log(`100 local routes + reroutes: ${(performance.now() - start).toFixed(1)}ms total; zero requests`)
  const data = await vite.ssrLoadModule('/src/data/dataClient.js')
  liveClosures = [{ ...closures[0], name: 'Test Road', closed: true, bbox: { lat_min: 12.74, lat_max: 12.76, lng_min: 80.18, lng_max: 80.21 } }]
  data._state().closures.fetchedAt = 0
  await data.getClosures()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.match(api.getRouteSync('main-gate', 'cse-block').warning, /Test Road/, 'public closure snapshot reaches the router subscription without Render')
  liveClosures = closures; data._state().closures.fetchedAt = 0
  await data.getClosures(); await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(api.getRouteSync('main-gate', 'cse-block').warning, baseline.warning)
  const before = repository.graphMetadata().hash
  backendGraph = { nodes: [], edges: [], location_edges: [] }
  assert.equal(await repository.syncGraph(), false)
  assert.equal(repository.graphMetadata().hash, before)
  assert.equal(rows.get('graph').hash, before)
  backendGraph = structuredClone(graph)
  backendGraph.revision = 'verified-update'
  const pathIds = baseline.path.filter(p => graph.nodes.some(n => n.id === p.id)).map(p => p.id)
  const changed = backendGraph.edges.find(e => [e.from, e.to].includes(pathIds[0]) && [e.from, e.to].includes(pathIds[1]))
  assert(changed)
  const a = changed.path[0], b = changed.path[1]
  changed.path.splice(1, 0, { lat: (a.lat + b.lat) / 2 + 0.00003, lng: (a.lng + b.lng) / 2 })
  const geometry = await vite.ssrLoadModule('/src/offline/offlineRouter.js')
  changed.distance_m = changed.path.slice(1).reduce((sum, p, i) => sum + geometry.pointDist(changed.path[i].lat, changed.path[i].lng, p.lat, p.lng), 0)
  assert.equal(await repository.syncGraph(), true)
  assert.notEqual(repository.graphMetadata().hash, before)
  const updatedRoute = await api.getRoute('main-gate', 'cse-block')
  assert.notDeepEqual(updatedRoute.path, baseline.path, 'routing uses updated IDB graph geometry, not bundled baseline')
  const updated = repository.graphMetadata().hash
  backendGraph = { ...graph, revision: 'aborted-update' }; abortWrites = true
  await repository.syncGraph()
  assert.equal(repository.graphMetadata().hash, updated)
  assert.equal(rows.get('graph').hash, updated)
  abortWrites = false
  globalThis.fetch = async () => { throw new TypeError('offline') }
  await repository.syncGraph()
  assert.deepEqual((await api.getRoute('main-gate', 'cse-block')).path, updatedRoute.path)
  const search = await vite.ssrLoadModule('/src/routing/searchLocations.js')
  assert(search.searchCampusLocations(locations, 'BME').some(l => /biomedical/i.test(l.name)))
  assert(search.searchCampusLocations(locations, 'libary').some(l => /library/i.test(l.name)))
  local.setRoadSegmentsSnapshot([{ id: 'test', name: 'Test Road', closed: true, bbox: { lat_min: 12.74, lat_max: 12.76, lng_min: 80.18, lng_max: 80.21 } }])
  assert.match(api.getRouteSync('main-gate', 'cse-block').warning, /Test Road/)
  const realNow = Date.now
  const later = realNow() + 61_000
  try {
    Date.now = () => later
    connectivity.reportSynchronizationFailure()
    assert.equal(connectivity.getOfflineStatus().online, false)
    assert.equal(connectivity.getOfflineStatus().graphAvailable, true, 'failed synchronization cannot disable local navigation')
    connectivity.reportPublicReachability()
    assert.equal(connectivity.getOfflineStatus().online, true, 'a fresh public snapshot establishes actual reachability')
  } finally { Date.now = realNow }
  console.log('PASS: bootstrap, integrity (11 malformed updates including snap-ID renumbering), atomic abort, versions, Render-down routing, 100 users, local search and closure refresh')
} finally {
  intervals.forEach(clearInterval)
  globalThis.setInterval = realInterval
  await vite.close()
}
