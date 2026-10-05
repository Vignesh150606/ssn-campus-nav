// W3: cold vs warm load measurement (requests + transferred bytes).
//
//   cd scripts
//   npm install
//   npx playwright install chromium
//   node measure-load.mjs https://your-app.vercel.app/            (cold + warm)
//   node measure-load.mjs https://your-app.vercel.app/ --json
//   node measure-load.mjs http://localhost:4173/ --headed         (vite preview)
//
// COLD = brand-new browser profile, no service worker, no HTTP cache.
//        Includes the service worker's install-time precache downloads.
// WARM = same profile, second visit after the SW is active.
//
// "Origin requests" = requests that actually left the browser for the page's
// own origin (what Vercel bills as edge requests; a 304 revalidation counts).
// Requests answered from the SW cache or the HTTP cache are listed separately.
//
// Needs Chromium: service-worker network events are enabled through the
// experimental env var below (set before launch).
process.env.PLAYWRIGHT_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const url = args.find((a) => /^https?:\/\//.test(a))
const asJson = args.includes('--json')
const headed = args.includes('--headed')
if (!url) {
  console.error('Usage: node measure-load.mjs <url> [--json] [--headed]')
  process.exit(1)
}
const origin = new URL(url).origin
const SETTLE_MS = 4000

function newRecorder(context) {
  const rows = []
  const pending = new Map()
  context.on('request', (req) => {
    pending.set(req, { url: req.url(), type: req.resourceType(), fromSWScope: Boolean(req.serviceWorker?.()) })
  })
  context.on('requestfinished', async (req) => {
    const row = pending.get(req)
    if (!row) return
    try {
      const res = await req.response()
      const sizes = await req.sizes()
      row.status = res?.status()
      row.servedBySW = Boolean(res?.fromServiceWorker?.())
      row.bytes = (sizes.responseBodySize || 0) + (sizes.responseHeadersSize || 0)
    } catch { row.bytes = 0 }
    rows.push(row)
  })
  context.on('requestfailed', (req) => { const r = pending.get(req); if (r) rows.push({ ...r, failed: true, bytes: 0 }) })
  return rows
}

function summarize(rows) {
  const sameOrigin = (r) => r.url.startsWith(origin)
  const swCache = rows.filter((r) => r.servedBySW)
  const network = rows.filter((r) => !r.servedBySW && !r.failed && r.bytes > 0)
  const originNet = network.filter(sameOrigin)
  const thirdNet = network.filter((r) => !sameOrigin(r))
  const sum = (a) => a.reduce((n, r) => n + r.bytes, 0)
  const kb = (n) => +(n / 1024).toFixed(1)
  return {
    requestsSeen: rows.length,
    servedFromServiceWorkerCache: swCache.length,
    originRequests: originNet.length,
    originKB: kb(sum(originNet)),
    thirdPartyRequests: thirdNet.length,
    thirdPartyKB: kb(sum(thirdNet)),
    zeroByteOrCached: rows.length - swCache.length - network.length,
    largestOrigin: originNet.sort((a, b) => b.bytes - a.bytes).slice(0, 8)
      .map((r) => `${kb(r.bytes).toString().padStart(7)} KB  ${r.url.replace(origin, '')}`),
    thirdPartyHosts: [...new Set(thirdNet.map((r) => new URL(r.url).host))],
  }
}

const browser = await chromium.launch({ headless: !headed })
const context = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 390, height: 844 } })
const page = await context.newPage()
const rows = newRecorder(context)

// ── COLD ──
await page.goto(url, { waitUntil: 'networkidle' })
await page.evaluate(() => navigator.serviceWorker?.ready).catch(() => {})
await page.waitForTimeout(SETTLE_MS) // let the SW finish precaching + idle-loaded chunks
const cold = summarize(rows.splice(0))

// ── WARM ──
await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForTimeout(SETTLE_MS)
const warm = summarize(rows.splice(0))

await browser.close()

if (asJson) {
  console.log(JSON.stringify({ url, cold, warm }, null, 2))
} else {
  for (const [label, s] of [['COLD (first visit)', cold], ['WARM (repeat visit)', warm]]) {
    console.log(`\n=== ${label} ===`)
    console.log(`origin requests (Vercel edge):   ${s.originRequests}   (${s.originKB} KB)`)
    console.log(`third-party requests:            ${s.thirdPartyRequests}   (${s.thirdPartyKB} KB)  ${s.thirdPartyHosts.join(', ')}`)
    console.log(`served from SW cache:            ${s.servedFromServiceWorkerCache}`)
    console.log(`cached/zero-byte (HTTP cache):   ${s.zeroByteOrCached}`)
    console.log('largest origin responses:')
    s.largestOrigin.forEach((l) => console.log('  ' + l))
  }
  console.log('\nNote: the WARM origin count includes the sw.js update check, and any 304 revalidations.')
}
