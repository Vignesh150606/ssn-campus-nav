// Full rendered apps. Share browser process resources, not navigation state or
// IndexedDB: each tab receives a distinct database namespace before app load.
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = process.env.NAV_TEST_URL || 'http://127.0.0.1:4174'
const count = Number(process.env.NAV_TEST_USERS || 100)

;(async () => {
  // Block external origins at Chrome's resolver. Playwright interception
  // disables HTTP caching and serializes thousands of image/API callbacks
  // through one laptop, distorting a 100-page cold-start test.
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--renderer-process-limit=4',
    '--host-resolver-rules=MAP api.invalid ~NOTFOUND, MAP storage.invalid ~NOTFOUND, MAP *.openstreetmap.org ~NOTFOUND, MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND'] })
  try {
    // SW/offline install is tested separately. Here every tab is a cold-start
    // app with its own persistent data, while avoiding 100 SW installations.
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 },
      permissions: ['geolocation'], geolocation: { latitude: 12.75137, longitude: 80.204085, accuracy: 5 } })
    let routeRequests = 0, healthRequests = 0
    const errors = []
    context.on('request', request => {
      if (request.url().includes('/api/route?')) routeRequests++
      if (request.url().includes('/api/health')) healthRequests++
    })
    const pages = await Promise.all(Array.from({ length: count }, async (_, id) => {
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.addInitScript(user => {
        const nativeOpen = indexedDB.open.bind(indexedDB)
        indexedDB.open = (name, version) => nativeOpen(`${name}-user-${user}`, version)
      }, id)
      return page
    }))
    const started = Date.now()
    let completed = 0
    const results = await Promise.allSettled(pages.map(async (page, id) => {
      await page.goto(base, { timeout: 120000 })
      await page.locator('.location-card').first().waitFor({ timeout: 120000 })
      await page.getByRole('textbox', { name: 'Search campus' }).fill('CSE')
      await page.locator('.location-card').filter({ hasText: 'CSE' }).first().getByRole('button', { name: 'Directions' }).click({ timeout: 120000 })
      const start = page.getByRole('button', { name: 'Start Navigation', exact: true }).first()
      await start.waitFor({ timeout: 120000 }); await start.click({ timeout: 120000 })
      await page.locator('.nav-instruction-card').waitFor({ timeout: 120000 })
      const stored = await page.evaluate(() => new Promise(resolve => {
        const open = indexedDB.open('ssn-campus-offline', 3)
        open.onsuccess = () => {
          const db = open.result, get = db.transaction('bundle-cache').objectStore('bundle-cache').get('graph')
          get.onsuccess = () => { resolve({ database: db.name, hash: get.result?.hash }); db.close() }
        }
      }))
      assert.equal(stored.database, `ssn-campus-offline-user-${id}`)
      assert(stored.hash)
      completed++
      if (completed % 20 === 0) console.log(`${completed}/${count} rendered apps navigating`)
    }))
    assert.equal(results.filter(r => r.status === 'rejected').length, 0, results.filter(r => r.status === 'rejected').map(r => r.reason.message).join('\n'))
    assert.equal(errors.length, 0, errors.join('\n'))
    assert.equal(routeRequests, 0); assert.equal(healthRequests, 0)
    console.log(`PASS: ${count} complete app pages opened simultaneously, ${count} independent real IndexedDB graphs, GPS + route + turn instructions; ZERO Render route/health requests; ${Date.now() - started}ms. Shared browser processes/app assets; independent navigation/data state.`)
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
