import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const root = fileURLToPath(new URL('../', import.meta.url))
const vite = await createServer({ root, configFile: false, envDir: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  define: { 'import.meta.env.VITE_API_BASE': JSON.stringify('https://api.invalid') },
  server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
const original = { fetch: globalThis.fetch, caches: globalThis.caches }
try {
  const { savedImageUrl } = await vite.ssrLoadModule('/src/copilot/savedImage.js')
  let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error('Network forbidden') }
  delete globalThis.caches
  assert.equal(await savedImageUrl('https://static.invalid/image.png'), null)
  globalThis.caches = { match: async () => undefined }
  assert.equal(await savedImageUrl('https://static.invalid/image.png'), null)
  globalThis.caches = { match: async () => Response.json({ message: 'not an image' }) }
  assert.equal(await savedImageUrl('https://static.invalid/image.png'), null)
  globalThis.caches = { match: async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } }) }
  const url = await savedImageUrl('https://static.invalid/image.png')
  assert.ok(url.startsWith('blob:'))
  URL.revokeObjectURL(url)
  globalThis.caches = { match: async () => { throw new Error('Storage unavailable') } }
  assert.equal(await savedImageUrl('https://static.invalid/image.png'), null)
  assert.equal(requests, 0)
  console.log('PASS: saved chat images use CacheStorage only; absent/unavailable cache and non-image responses never fetch.')
} finally {
  globalThis.fetch = original.fetch
  if (original.caches === undefined) delete globalThis.caches
  else globalThis.caches = original.caches
  await vite.close()
}
