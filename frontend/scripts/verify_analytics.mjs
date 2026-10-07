import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const root = fileURLToPath(new URL('../', import.meta.url))
const originals = { fetch, setTimeout, clearTimeout, document: globalThis.document, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') }
let visibility, accepted = true
const persisted = [], batches = [], beacons = [], timers = new Map()
globalThis.__analyticsTest = { persisted }
globalThis.document = { visibilityState: 'visible', addEventListener(_name, fn) { visibility = fn } }
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true,
  sendBeacon(_url, blob) { beacons.push(blob); return accepted } } })
const vite = await createServer({ root, configFile: false, envDir: false,
  plugins: [{ name: 'analytics-storage-double', enforce: 'pre',
    resolveId(source, importer) { if (source === '../offline/db' && importer?.endsWith('analyticsClient.js')) return '\0analytics-db' },
    load(id) { if (id === '\0analytics-db') return `export const STORE_ANALYTICS_QUEUE='queue';
      export async function idbAdd(_store,event) { globalThis.__analyticsTest.persisted.push(event) }
      export async function idbGetAllEntries() { return { keys: globalThis.__analyticsTest.persisted.map((_,i)=>i), values: [...globalThis.__analyticsTest.persisted] } }
      export async function idbDeleteKeys(_store,keys) { keys.reverse().forEach(i=>globalThis.__analyticsTest.persisted.splice(i,1)) }` },
  }], optimizeDeps: { noDiscovery: true, entries: [] },
  define: { 'import.meta.env.VITE_API_BASE': JSON.stringify('https://api.invalid'),
    'import.meta.env.VITE_ANALYTICS_ENABLED': JSON.stringify('true') },
  server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
try {
  const client = await vite.ssrLoadModule('/src/analytics/analyticsClient.js')
  let counter = 0
  globalThis.setTimeout = (fn, delay) => { const id = ++counter; timers.set(id, { fn, delay }); return id }
  globalThis.clearTimeout = id => timers.delete(id)
  globalThis.fetch = async (_url, options) => { batches.push(JSON.parse(options.body)); return Response.json({ ok: true }) }
  for (let i = 0; i < 5; i++) client.track('search', { i })
  assert.equal(batches.length, 0)
  assert.equal(timers.size, 1)
  const timer = [...timers.values()][0]
  assert.equal(timer.delay, 60_000)
  timers.clear(); timer.fn()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(batches[0].events.length, 5)
  for (let i = 0; i < 40; i++) client.track('navigation_start')
  await Promise.resolve()
  assert.equal(batches[1].events.length, 40)
  assert.equal(timers.size, 0, 'Size flush cancels the old early timer')
  client.track('arrival')
  document.visibilityState = 'hidden'; visibility()
  assert.equal(JSON.parse(await beacons[0].text()).events[0].event_type, 'arrival')
  await client.flush()
  assert.equal(batches.length, 2, 'Accepted beacon must not be sent again')
  accepted = false; client.track('navigation_exit'); visibility()
  await client.flush()
  assert.equal(batches[2].events[0].event_type, 'navigation_exit', 'Rejected beacon retains data')
  navigator.onLine = false; client.track('search'); await client.flush()
  assert.equal(persisted.length, 1)
  navigator.onLine = true; await client.flushQueuedOffline()
  assert.equal(persisted.length, 0)
  assert.equal(batches[3].events[0].event_type, 'search')
  console.log('PASS: 60-second analytics batching; 40-event threshold; hide beacon success/rejection; offline persistence/replay; no events dropped.')
} finally {
  globalThis.fetch = originals.fetch; globalThis.setTimeout = originals.setTimeout; globalThis.clearTimeout = originals.clearTimeout
  if (originals.document === undefined) delete globalThis.document; else globalThis.document = originals.document
  if (originals.navigator) Object.defineProperty(globalThis, 'navigator', originals.navigator); else delete globalThis.navigator
  delete globalThis.__analyticsTest
  await vite.close()
}

// A second module graph uses the production default: no flag, no telemetry.
const disabled = await createServer({ root, configFile: false, envDir: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  define: { 'import.meta.env.VITE_API_BASE': JSON.stringify('https://api.invalid') },
  server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
let requests = 0, writes = 0, timersCreated = 0, hideListeners = 0
const beforeDisabled = { fetch, setTimeout, document: globalThis.document }
globalThis.fetch = async () => { requests++; throw new Error('Render must not be contacted') }
globalThis.setTimeout = () => { timersCreated++; return 1 }
globalThis.document = { addEventListener() { hideListeners++ } }
try {
  const client = await disabled.ssrLoadModule('/src/analytics/analyticsClient.js')
  timersCreated = 0 // Ignore Vite's own transform timers; measure visitor calls.
  // Any IndexedDB access would record a write; no disabled backlog is created.
  globalThis.indexedDB = { open() { writes++; throw new Error('Disabled analytics touched storage') } }
  for (let i = 0; i < 500; i++) client.track('route_requested')
  await client.flush(); await client.flushQueuedOffline()
  assert.equal(requests, 0); assert.equal(writes, 0)
  assert.equal(timersCreated, 0); assert.equal(hideListeners, 0)
  console.log('PASS: default-disabled analytics makes no fetch/beacon, timer, IndexedDB write or backlog replay.')
} finally {
  globalThis.fetch = beforeDisabled.fetch; globalThis.setTimeout = beforeDisabled.setTimeout
  if (beforeDisabled.document === undefined) delete globalThis.document; else globalThis.document = beforeDisabled.document
  delete globalThis.indexedDB
  await disabled.close()
}
