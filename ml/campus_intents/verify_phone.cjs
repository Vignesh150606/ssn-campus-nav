/* Chrome test of the isolated harness, with the artificial smoke artifact.
 * No production requests; timings are desktop-only and not phone evidence. */
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const root = process.env.MODEL_TEST_DIR || path.resolve(__dirname, '../../output/local-nav-check/campus-ml-smoke-model')
const allowed = new Set(['index.html', 'worker.mjs', 'runtime.mjs', 'model.json', 'weights.bin'])
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html'
  if (!allowed.has(name)) { res.writeHead(404); res.end(); return }
  const type = name.endsWith('.mjs') ? 'text/javascript' : name.endsWith('.json') ? 'application/json'
    : name.endsWith('.html') ? 'text/html' : 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': type }); fs.createReadStream(path.join(root, name)).pipe(res)
})
;(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), errors = [], external = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url()) })
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    await page.getByRole('button', { name: 'Load packaged model', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'loaded in' }).waitFor()
    await page.getByRole('textbox', { name: 'Campus question' }).fill('food enga iruku?')
    await page.getByRole('button', { name: 'Classify question', exact: true }).click()
    await page.waitForFunction(() => document.getElementById('result').textContent.includes('prediction'))
    const result = JSON.parse(await page.locator('#result').textContent())
    assert.equal(result.type, 'prediction')
    assert.equal(result.result.accepted, false, 'Smoke artifact must not claim good enough confidence')
    await page.getByRole('button', { name: 'Benchmark 100 predictions', exact: true }).click()
    await page.waitForFunction(() => document.getElementById('result').textContent.includes('benchmark'))
    const timing = JSON.parse(await page.locator('#result').textContent())
    assert(timing.p95 >= 0 && timing.max >= timing.p95)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    const weights = fs.readFileSync(path.join(root, 'weights.bin')); weights[10] ^= 1
    await page.locator('#manifest').setInputFiles(path.join(root, 'model.json'))
    await page.locator('#weights').setInputFiles({ name: 'weights.bin', mimeType: 'application/octet-stream', buffer: weights })
    await page.getByRole('button', { name: 'Load selected files', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'SHA-256 mismatch' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Classify question', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: 'Load packaged model', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'loaded in' }).waitFor()
    assert.deepEqual(external, []); assert.deepEqual(errors, [])
    console.log(`PASS: Worker loading/prediction, 100-run benchmark, 390px layout, corrupt-file rejection/recovery, zero external requests. Desktop p95=${timing.p95.toFixed(2)}ms (NOT phone performance).`)
    await page.close()
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1 })
