// No .env loading and no real network: exercises snapshot/live/cache contracts.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { readFileSync } from 'node:fs'

const root = fileURLToPath(new URL('../', import.meta.url))
const vite = await createServer({ root, configFile: false, envDir: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  define: { 'import.meta.env.VITE_API_BASE': JSON.stringify('https://api.invalid'),
    'import.meta.env.VITE_SNAPSHOT_BASE_URL': JSON.stringify('https://storage.invalid/snapshots') },
  server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
const realFetch = globalThis.fetch
const realNow = Date.now
let now = realNow(), mode = 'absent', eventName = 'Fest', version = 1, calls = [], fallback = false
Date.now = () => now
const locations = JSON.parse(readFileSync(new URL('../public/data/locations.json', import.meta.url), 'utf8'))
const events = () => [{ id: 'e1', name: eventName, location_id: 'main-gate', location: { id: 'main-gate' }, fest: 'Invente' }]
const graph = JSON.parse(readFileSync(new URL('../public/data/graph.json', import.meta.url), 'utf8'))
const closures = JSON.parse(readFileSync(new URL('../public/data/closures.json', import.meta.url), 'utf8'))
globalThis.fetch = async (url, options = {}) => {
  calls.push(String(url))
  if (mode === 'offline') throw new TypeError('offline')
  if (String(url).includes('/api/admin/')) return Response.json({ message: 'Updated' })
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
  assert.equal((await data.getEvent('e1')).location.name, locations.find(l => l.id === 'main-gate').name)
  assert.equal(data.qrUrl('e1'), 'https://storage.invalid/snapshots/qr/e1.png')
  assert.equal(await data.hasCachedBootData(), true)
  calls = []
  await data.getSchedule(); await data.getClosures()
  assert.equal(calls.length, 0, 'fresh client data avoids requests')
  now += 31_000; mode = 'malformed'; calls = []
  const off = data.subscribe('schedule', () => {})
  await data.getSchedule()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert(!calls.some(x => x.startsWith('https://api.invalid')), 'cached visitor must not fall back to Render on malformed snapshot')
  off()
  now += 31_000; mode = 'snapshot'; eventName = 'Updated'
  let notification
  const stop = data.subscribe('schedule', value => { notification = value })
  await data.getSchedule()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(notification[0].name, 'Updated')
  assert.equal(data.qrUrl('e1'), 'https://storage.invalid/snapshots/qr/e1.png')
  stop()
  calls = []
  await assert.rejects(data.getEvent('removed'), e => e.status === 404)
  await assert.rejects(data.getLocation('unknown'), e => e.status === 404)
  assert.equal(calls.length, 0, 'missing IDs in usable public data do not wake Render')
  const currentVersion = data._state().schedule.version
  const admin = await vite.ssrLoadModule('/src/pages/admin/adminShared.js')
  await admin.adminFetch('/api/admin/events/e1', 'PATCH', { name: 'Edited' }, 'dummy-test-token')
  await Promise.resolve()
  assert.equal(data._state().schedule.fetchedAt, 0)
  assert.equal(data._state().schedule.version, currentVersion, 'invalidation retains the known-good version and data')
  assert.equal(data._state().schedule.data[0].name, 'Updated')
  const before = data._state().schedule.fetchedAt
  now += 31_000; fallback = true
  await data.getSchedule()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(data._state().schedule.fetchedAt, before, 'SW fallback must not renew freshness')
  mode = 'offline'; now += 600_000; calls = []
  assert.equal((await data.getSchedule())[0].name, 'Updated')
  assert.deepEqual(await data.getClosures(), closures)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert(!calls.some(x => x.startsWith('https://api.invalid')), 'even very old caches must never wake Render in a refresh')
  await assert.rejects(data.getVenueMenu('main-gate'), /offline/)
  mode = 'absent'
  await assert.rejects(data.getVenueMenu('main-gate'), e => e.status === 404)
  console.log('PASS: baked data, cold live fallback, no cached Render fallback, TTL/subscriptions, admin invalidation, Storage QR, missing IDs, venue enrichment, offline data and menu errors')
} finally {
  globalThis.fetch = realFetch; Date.now = realNow
  await vite.close()
}
