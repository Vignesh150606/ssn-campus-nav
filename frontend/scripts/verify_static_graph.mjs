import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
const root = fileURLToPath(new URL('../', import.meta.url))
const read = name => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url), 'utf8'))
const graph = read('graph'), locations = read('locations')
const hash = data => createHash('sha256').update(JSON.stringify(data)).digest('hex')
const updated = { ...graph, revision: 'next-app-deployment' }
let record = { data: graph, hash: hash(graph), version: hash(graph), bootstrapVersion: hash(graph), cachedAt: 1 }
let downloaded = updated, failWrite = false, calls = []
globalThis.__graphTest = { get: () => structuredClone(record), put: row => {
  if (failWrite) throw new Error('Quota')
  record = structuredClone(row)
} }
const original = globalThis.fetch
globalThis.fetch = async url => { calls.push(url); assert.equal(url, '/data/graph.json'); return Response.json(downloaded) }
async function server(version) {
  return createServer({ root, configFile: false, envDir: false,
    plugins: [{ name: 'graph-storage-double', enforce: 'pre',
      resolveId(source, importer) { if (source === '../offline/db' && importer?.endsWith('graphData.js')) return '\0graph-db' },
      load(id) { if (id === '\0graph-db') return `export const STORE_BUNDLE_CACHE='cache';
        export async function idbGet() { return globalThis.__graphTest.get() }
        export async function idbPut(_store,_key,row) { globalThis.__graphTest.put(row) }` },
    }], optimizeDeps: { noDiscovery: true, entries: [] },
    define: { 'import.meta.env.VITE_API_BASE': JSON.stringify('https://api.invalid'), 'import.meta.env.CAMPUS_GRAPH_VERSION': JSON.stringify(version) },
    server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
}
async function scenario(version, check) {
  const vite = await server(version)
  try { await check(await vite.ssrLoadModule('/src/routing/graphData.js')) }
  finally { await vite.close() }
}
const settle = () => new Promise(resolve => originalSetTimeout(resolve, 30))
const originalSetTimeout = setTimeout
try {
  await scenario(hash(graph), async repo => {
    await repo.loadGraph(locations)
    for (let i = 0; i < 100; i++) repo.startGraphSync()()
    await settle()
    assert.equal(calls.length, 0, 'Unchanged deployed graph must not download or poll Render')
  })
  await scenario(hash(updated), async repo => {
    await repo.loadGraph(locations)
    assert.equal(repo.graphMetadata().hash, hash(graph), 'Ready immediately from IDB')
    for (let i = 0; i < 10; i++) repo.startGraphSync()()
    await settle()
    assert.equal(calls.length, 1, 'One coalesced same-origin download for a new deployment')
    assert.equal(record.hash, hash(updated))
    assert.equal(record.bootstrapVersion, hash(updated))
    assert.equal(repo.graphMetadata().hash, hash(updated))
  })
  const good = structuredClone(record)
  downloaded = { nodes: [], edges: [], location_edges: [] }
  await scenario(hash(downloaded), async repo => {
    await repo.loadGraph(locations); repo.startGraphSync(); await settle()
    assert.deepEqual(record, good, 'Invalid graph cannot replace good storage')
  })
  downloaded = { ...updated, revision: 'third-deployment' }; failWrite = true
  await scenario(hash(downloaded), async repo => {
    await repo.loadGraph(locations); repo.startGraphSync(); await settle()
    assert.deepEqual(record, good, 'Failed atomic write retains durable graph')
    assert.equal(repo.graphMetadata().hash, good.hash)
  })
  record = null; failWrite = false; downloaded = graph
  await scenario(hash(updated), async repo => {
    await assert.rejects(repo.loadGraph(locations), /No valid campus map/, 'First boot must reject a graph from a different app deployment')
    assert.equal(record, null)
  })
  console.log('PASS: static graph makes zero backend/polling requests; new deployment downloads once; validation and failed-write retention preserved.')
} finally { globalThis.fetch = original; delete globalThis.__graphTest }
