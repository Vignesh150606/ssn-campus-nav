// No .env loading and no real network: exercises snapshot/live/cache contracts.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const vite = await createServer({ root, configFile: false, envDir: false,
  define: { 'import.meta.env.VITE_API_BASE': JSON.stringify('https://api.invalid'),
    'import.meta.env.VITE_SNAPSHOT_BASE_URL': JSON.stringify('https://storage.invalid/snapshots') },
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const realFetch = globalThis.fetch
const realNow = Date.now
let now = realNow(), mode = 'absent', eventName = 'Fest', version = 1, calls = [], fallback = false
Date.now = () => now
const locations = [{ id: 'main-gate', name: 'Main Gate', lat: 12.75, lng: 80.19 }]
const events = () => [{ id: 'e1', name: eventName, location_id: 'main-gate', location: { id: 'main-gate' }, fest: 'Invente' }]
const graph = { nodes: [], edges: [], location_edges: [] }
const closures = [{ id: 'road', closed: true }]
globalThis.fetch = async (url) => {
  calls.push(String(url))
  if (mode === 'offline') throw new TypeError('offline')
  if (url === '/data/locations.json') return Response.json(locations)
  if (url === '/data/graph.json') return Response.json(graph)
  if (String(url).startsWith('https://storage.invalid')) {
    if (mode === 'absent') return new Response('', { status: 404 })
    const name = String(url).split('/').at(-1).split('.')[0]
    const data = mode === 'malformed' ? {} : name === 'closures' ? closures : events()
    return Response.json({ schema: 1, version, data, meta: { qr_ids: ['e1'] } },
      { headers: fallback ? { 'X-SSN-Snapshot-Source': 'sw-cache' } : {} })
  }
  if (String(url).endsWith('/api/events')) return Response.json(events())
  if (String(url).endsWith('/api/road-segments')) return Response.json(closures)
  if (String(url).includes('/menu?')) return Response.json({ detail: 'No menu' }, { status: 404 })
  return Response.json({ detail: 'Unknown' }, { status: 404 })
}
try {
  const data = await vite.ssrLoadModule('/src/data/dataClient.js')
  assert.deepEqual(await data.getLocations(), locations)
  assert.deepEqual(await data.getGraph(), graph)
  assert.deepEqual(await data.getSchedule(), events())
  assert.deepEqual(await data.getClosures(), closures)
  assert(calls.some(x => x.endsWith('/api/events')), 'missing bucket must fall back to API')
  assert.equal((await data.getEvent('e1')).location.name, 'Main Gate')
  assert.equal(data.qrUrl('e1'), 'https://api.invalid/api/events/e1/qr')
  assert.equal(await data.hasCachedBootData(), true)
  calls = []
  await data.getSchedule(); await data.getClosures()
  assert.equal(calls.length, 0, 'fresh client data avoids requests')
  now += 31_000; mode = 'malformed'
  const off = data.subscribe('schedule', () => {})
  await data.getSchedule()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert(calls.some(x => x.endsWith('/api/events')), 'invalid JSON shape must fall back')
  off()
  now += 31_000; mode = 'snapshot'; eventName = 'Updated'
  let notification
  const stop = data.subscribe('schedule', value => { notification = value })
  await data.getSchedule()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(notification[0].name, 'Updated')
  assert.equal(data.qrUrl('e1'), 'https://storage.invalid/snapshots/qr/e1.png')
  stop()
  const before = data._state().schedule.fetchedAt
  now += 31_000; fallback = true
  await data.getSchedule()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(data._state().schedule.fetchedAt, before, 'SW fallback must not renew freshness')
  mode = 'offline'; now += 600_000
  assert.equal((await data.getSchedule())[0].name, 'Updated')
  assert.deepEqual(await data.getClosures(), closures)
  await assert.rejects(data.getVenueMenu('main-gate'), /offline/)
  mode = 'absent'
  await assert.rejects(data.getVenueMenu('main-gate'), e => e.status === 404)
  console.log('PASS: baked data, missing/malformed snapshots, live fallback, TTL, subscriptions, QR, venue enrichment, offline data, menu errors')
} finally {
  globalThis.fetch = realFetch; Date.now = realNow
  await vite.close()
}
