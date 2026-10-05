import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import tiles, { isCampusTile } from '../pwa/runtimeCaching.tiles.js'
import snapshots from '../pwa/runtimeCaching.snapshots.js'

// Workbox serializes the callback without its surrounding module bindings.
const serialized = vm.runInNewContext(`(${tiles[0].urlPattern.toString()})`)
for (let z = 14; z <= 19; z++) {
  const n = 2 ** z
  const x = Math.floor((80.198 + 180) / 360 * n)
  const rad = 12.752 * Math.PI / 180
  const y = Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n)
  for (let dx = -5; dx <= 5; dx++) for (let dy = -5; dy <= 5; dy++) {
    const url = new URL(`https://tile.openstreetmap.org/${z}/${x + dx}/${y + dy}.png`)
    assert.equal(serialized({ url }), isCampusTile(url))
  }
}
assert.equal(serialized({ url: new URL('https://other.invalid/17/1/1.png') }), false)
const snapshotURL = new URL('https://project.supabase.co/storage/v1/object/public/snapshots/closures.json')
assert(snapshots[0].urlPattern({ url: snapshotURL }))
const fallbackPlugin = snapshots[0].options.plugins.find(p => p.cachedResponseWillBeUsed)
const fallback = await fallbackPlugin.cachedResponseWillBeUsed({ cachedResponse: Response.json({ schema: 1, data: [] }) })
assert.equal(fallback.headers.get('X-SSN-Snapshot-Source'), 'sw-cache')
assert.equal(snapshots[0].options.expiration.maxAgeSeconds, 60)

const handlers = {}, store = new Map()
let reloads = 0, prevented = 0
const context = { window: { addEventListener: (name, cb) => { handlers[name] = cb },
  location: { reload: () => reloads++ } }, navigator: {}, Date,
  sessionStorage: { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value) } }
vm.runInNewContext(readFileSync(new URL('../src/pwa/updateGuards.js', import.meta.url), 'utf8'), context)
handlers['vite:preloadError']({ preventDefault: () => prevented++ })
assert.equal(reloads, 1); assert.equal(prevented, 1)
handlers['vite:preloadError']({ preventDefault: () => prevented++ })
assert.equal(reloads, 1); assert.equal(prevented, 1, 'second failure must reach the error boundary')
context.sessionStorage.getItem = () => { throw new Error('storage blocked') }
handlers['vite:preloadError']({ preventDefault: () => prevented++ })
assert.equal(reloads, 1); assert.equal(prevented, 1)
console.log('PASS: self-contained serialized tile matcher (726 cases), snapshot fallback provenance/TTL, guarded preload recovery')
