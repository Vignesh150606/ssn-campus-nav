import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const root = fileURLToPath(new URL('../', import.meta.url))
const vite = await createServer({ root, configFile: false, envDir: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  define: { 'import.meta.env.VITE_API_BASE': JSON.stringify('https://api.invalid') },
  server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
const original = globalThis.fetch
try {
  const { copilotChat } = await vite.ssrLoadModule('/src/copilot/copilotApi.js')
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, body: JSON.parse(options.body) }
    return Response.json({ intent: 'greeting' })
  }
  assert.equal((await copilotChat('hello', { hasPending: true })).intent, 'greeting')
  assert.deepEqual(request, { url: 'https://api.invalid/api/copilot/chat', body: { message: 'hello', context: { hasPending: true } } })
  globalThis.fetch = async () => Response.json({ detail: 'Busy now', error: 'busy', retry_after: 4 }, { status: 503 })
  await assert.rejects(copilotChat('hello'), e => e.name === 'CopilotError' && e.isOverload && e.retryAfter === 4 && e.status === 503)
  globalThis.fetch = async () => Response.json({ detail: 'Wait' }, { status: 429, headers: { 'Retry-After': '6' } })
  await assert.rejects(copilotChat('hello'), e => e.code === 'rate_limited' && e.retryAfter === 6)
  globalThis.fetch = async () => { throw new TypeError('offline') }
  await assert.rejects(copilotChat('hello'), e => e.code === 'network' && e.status === 0)
  globalThis.fetch = async () => { throw new DOMException('timeout', 'AbortError') }
  await assert.rejects(copilotChat('hello'), e => e.code === 'timeout')
  console.log('PASS: Copilot request contract, typed overload, legacy 429/Retry-After, network/timeout errors')
} finally {
  globalThis.fetch = original
  await vite.close()
}
