/* Run against a built preview. Playwright is an external verification tool,
 * not a shipped dependency. PLAYWRIGHT_MODULE_PATH selects an installed copy. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = process.env.NAV_TEST_URL || 'http://127.0.0.1:4174'
const data = name => JSON.parse(fs.readFileSync(path.join(__dirname, '../public/data', `${name}.json`), 'utf8'))
const graph = data('graph')
let servedGraph = graph
let routeRequests = 0, healthRequests = 0, graphRequests = 0, chatRequests = 0
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2iEAAAAASUVORK5CYII=', 'base64')

async function configure(context, backendHealthy = false) {
  await context.route('https://api.invalid/**', async route => {
    const url = route.request().url()
    if (url.includes('/api/route?')) routeRequests++
    if (url.includes('/api/health')) healthRequests++
    if (url.includes('/api/graph')) graphRequests++
    if (url.includes('/api/copilot/chat')) chatRequests++
    if (backendHealthy && url.endsWith('/api/graph')) return route.fulfill({ json: servedGraph })
    return route.fulfill({ status: 503, json: { detail: 'Backend unavailable' } })
  })
  await context.route('https://storage.invalid/**', route => route.fulfill({ status: 404, body: '' }))
  await context.route(/^https:\/\/(?:[abc]\.)?tile\.openstreetmap\.org\//, route => route.fulfill({ contentType: 'image/png', body: png, headers: { 'Access-Control-Allow-Origin': '*' } }))
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
}
async function directions(page) {
  const feedback = page.getByRole('dialog', { name: 'Route feedback' })
  if (await feedback.isVisible()) await feedback.getByRole('button', { name: 'Skip', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search campus' }).fill('CSE')
  await page.locator('.location-card').filter({ hasText: 'CSE' }).first().getByRole('button', { name: 'Directions' }).click()
  await page.getByRole('button', { name: 'Start Navigation', exact: true }).first().waitFor()
}
async function graphRecord(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const started = performance.now()
    const request = indexedDB.open('ssn-campus-offline', 3)
    request.onsuccess = () => {
      const db = request.result, read = db.transaction('bundle-cache').objectStore('bundle-cache').get('graph')
      read.onsuccess = () => { resolve({ ...read.result, readMs: performance.now() - started }); db.close() }
      read.onerror = () => reject(read.error)
    }
    request.onerror = () => reject(request.error)
  }))
}

async function headerLayout(page) {
  for (const width of [320, 390, 768]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 844 })
    await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme)
    const fits = await page.evaluate(() => {
      const logo = document.querySelector('.brand-logo').getBoundingClientRect()
      const nav = document.querySelector('.app-header nav').getBoundingClientRect()
      return { fits: logo.right <= nav.left && nav.right <= innerWidth, logoRight: logo.right, navLeft: nav.left, navRight: nav.right }
    })
    assert(fits.fits, `${width}px ${theme} header overlaps/overflows: ${JSON.stringify(fits)}`)
  }
  await page.setViewportSize({ width: 390, height: 844 })
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['geolocation'], geolocation: { latitude: 12.75137, longitude: 80.204085, accuracy: 5 } })
    await configure(context)
    let page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(base)
    await page.locator('.location-card').first().waitFor({ timeout: 20000 })
    const record = await graphRecord(page)
    assert.equal(record.bootstrapVersion, record.hash, 'Production build must embed and persist its graph version')
    assert(record.hash && record.version && record.cachedAt)
    const reads = []
    for (let i = 0; i < 20; i++) reads.push((await graphRecord(page)).readMs)
    reads.sort((a, b) => a - b)
    console.log(`Real IndexedDB graph reads: p50=${reads[10].toFixed(2)}ms p95=${reads[19].toFixed(2)}ms (desktop Chrome)`)
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }))
    })
    await page.waitForFunction(async () => (await (await caches.open('map-tiles-campus-v1')).keys()).length > 0)
    const caches = await page.evaluate(async () => {
      const names = await window.caches.keys()
      return Promise.all(names.map(async name => ({ name, urls: (await (await window.caches.open(name)).keys()).map(r => r.url) })))
    })
    assert(caches.some(c => c.urls.some(u => new URL(u).pathname === '/data/graph.json')))
    assert(caches.some(c => c.urls.some(u => new URL(u).pathname === '/data/closures.json')))
    await page.close()
    await context.setOffline(true)
    page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(base)
    await page.locator('.location-card').first().waitFor({ timeout: 10000 })
    assert.equal((await graphRecord(page)).hash, record.hash)
    await headerLayout(page)
    await page.getByRole('button', { name: 'Open campus assistant' }).click()
    const chat = page.locator('.copilot-input')
    await chat.fill('Does this work offline?'); await chat.press('Enter')
    await page.locator('.copilot-msg-assistant').filter({ hasText: 'Open the app once with internet' }).waitFor()
    await chat.fill('Where is the library?'); await chat.press('Enter')
    await page.locator('.copilot-cards').filter({ hasText: 'Library' }).waitFor()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    assert.equal(chatRequests, 0, 'Offline chatbot must not request backend classification')
    if (!await page.locator('.location-btn.active').count()) await page.locator('.location-btn').click()
    await page.locator('.location-btn.active').waitFor()
    await directions(page)
    await page.getByRole('button', { name: 'Start Navigation', exact: true }).first().click()
    await page.locator('.nav-instruction-card').waitFor()
    // Real Chromium geolocation watcher, deterministic off-route fixes. Same
    // provider pipeline/accuracy filtering as phone GPS; not a mock router.
    for (let i = 0; i < 5; i++) {
      await context.setGeolocation({ latitude: 12.7544 + i * 0.000002, longitude: 80.195, accuracy: 5 })
      await page.waitForTimeout(400)
    }
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('ssn-reroute-debug-log') || '[]').some(e => e.responseSource === 'client'), { timeout: 10000 })
    const reroutes = await page.evaluate(() => JSON.parse(localStorage.getItem('ssn-reroute-debug-log') || '[]').filter(e => e.responseSource === 'client'))
    assert(reroutes.some(r => r.responseDistanceM > 0 && r.responsePathLength > 1))
    await page.getByRole('button', { name: 'Exit navigation' }).click()
    await page.locator('.location-card').first().waitFor()
    await directions(page)
    await page.getByRole('button', { name: 'Start Navigation', exact: true }).first().click()
    const destination = data('locations').find(l => l.id === 'cse-block')
    for (let i = 0; i < 3; i++) {
      await context.setGeolocation({ latitude: destination.lat + i * 0.000001, longitude: destination.lng, accuracy: 5 })
      await page.waitForTimeout(400)
    }
    await page.locator('.arrival-card').waitFor()
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await page.locator('.location-card').first().waitFor()
    await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('ssn-campus-offline', 3)
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('bundle-cache', 'readwrite'), store = tx.objectStore('bundle-cache')
        const get = store.get('graph')
        get.onsuccess = () => store.put({ ...get.result, data: { nodes: [], edges: [], location_edges: [] } }, 'graph')
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onabort = () => reject(tx.error)
      }
    }))
    await page.reload()
    await page.locator('.location-card').first().waitFor()
    assert.equal((await graphRecord(page)).hash, record.hash, 'offline corrupt cache repairs only from validated precached graph')
    assert.equal(errors.length, 0, errors.join('\n'))
    console.log('PASS: real IndexedDB + app-shell/data precache; offline reopen, GPS, destination, local route, instructions, off-route detection, reroute, arrival, exit and corrupt-cache repair; Render unavailable')
    await context.close()

    const updates = await browser.newContext()
    await configure(updates, true)
    let updatedPage = await updates.newPage()
    await updatedPage.goto(base)
    await updatedPage.locator('.location-card').first().waitFor()
    const original = (await graphRecord(updatedPage)).hash
    // Simulate a valid graph saved by an older deployment. The current
    // bundle replaces it from its precached static asset, never Render.
    await updatedPage.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('ssn-campus-offline', 3)
      open.onsuccess = () => {
        const db = open.result
        const read = db.transaction('bundle-cache').objectStore('bundle-cache').get('graph')
        read.onsuccess = async () => {
          const data = { ...read.result.data, revision: 'old-deployment' }
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)))
          const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
          const tx = db.transaction('bundle-cache', 'readwrite')
          tx.objectStore('bundle-cache').put({ ...read.result, data, hash, version: hash, bootstrapVersion: 'old-deployment' }, 'graph')
          tx.oncomplete = () => { db.close(); resolve() }
          tx.onabort = () => reject(tx.error)
        }
      }
    }))
    assert.notEqual((await graphRecord(updatedPage)).hash, original, 'Older deployment fixture must be persisted before testing the upgrade')
    await updatedPage.reload()
    await updatedPage.locator('.location-card').first().waitFor()
    await updatedPage.waitForFunction(previous => new Promise(resolve => {
      const open = indexedDB.open('ssn-campus-offline', 3)
      open.onsuccess = () => {
        const db = open.result, req = db.transaction('bundle-cache').objectStore('bundle-cache').get('graph')
        req.onsuccess = () => { resolve(req.result?.hash === previous); db.close() }
      }
    }), original)
    const latest = (await graphRecord(updatedPage)).hash
    servedGraph = { nodes: [], edges: [], location_edges: [] }
    await updatedPage.reload()
    await updatedPage.locator('.location-card').first().waitFor()
    await updatedPage.waitForTimeout(300)
    assert.equal((await graphRecord(updatedPage)).hash, latest, 'invalid network update must retain real IDB graph')
    await updates.setOffline(true)
    await updatedPage.close(); updatedPage = await updates.newPage()
    await updatedPage.goto(base)
    await updatedPage.locator('.location-card').first().waitFor()
    assert.equal((await graphRecord(updatedPage)).hash, latest, 'offline reopen must use updated IDB graph, not bundled baseline')
    await directions(updatedPage)
    await updatedPage.getByRole('button', { name: 'Start Navigation', exact: true }).first().click()
    await updatedPage.locator('.nav-instruction-card').waitFor()
    servedGraph = { ...graph, revision: 'reconnected-update' }
    await updates.setOffline(false)
    assert.equal((await graphRecord(updatedPage)).hash, latest, 'Reconnection must not poll the static backend graph')
    assert(await updatedPage.locator('.nav-instruction-card').isVisible(), 'Reconnection must not discard active navigation')
    assert.equal(graphRequests, 0)
    await updates.close()
    servedGraph = graph
    console.log('PASS: real IndexedDB deployment graph update; offline chat/cards; reconnect preserves active navigation; ZERO backend graph/chat requests')

    const empty = await browser.newContext()
    await configure(empty)
    await empty.route(`${base}/data/**`, route => route.fulfill({ status: 503, body: '' }))
    const emptyPage = await empty.newPage()
    await emptyPage.goto(base)
    await emptyPage.getByText('No valid campus data is stored yet.', { exact: false }).waitFor({ timeout: 20000 })
    assert.equal(await emptyPage.locator('.location-card').count(), 0)
    await empty.close()
    console.log('PASS: first-run missing graph/data produces clear bootstrap message; no incorrect route')

    const blocked = await browser.newContext()
    await configure(blocked)
    // Hold the old schema in a separate tab BEFORE starting the app. An init
    // script races app opens and doesn't reliably simulate an older open tab.
    await blocked.route(`${base}/__hold-db`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Old database tab</title>' }))
    const holder = await blocked.newPage()
    await holder.goto(`${base}/__hold-db`)
    await holder.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('ssn-campus-offline', 2)
      open.onupgradeneeded = () => open.result.createObjectStore('bundle-cache')
      open.onsuccess = () => { window.heldDB = open.result; window.heldDB.onversionchange = () => {}; resolve() }
      open.onerror = () => reject(open.error)
    }))
    const blockedPage = await blocked.newPage()
    await blockedPage.goto(base)
    await blockedPage.locator('.location-card').first().waitFor({ timeout: 20000 })
    await blockedPage.locator('.offline-indicator').filter({ hasText: 'Cache unavailable' }).waitFor()
    await headerLayout(blockedPage)
    await directions(blockedPage)
    await holder.evaluate(() => window.heldDB.close())
    await blocked.close()
    console.log('PASS: blocked IndexedDB upgrade does not freeze startup; usable local bootstrap with truthful persistence warning')

    const guards = await browser.newContext()
    await configure(guards)
    const guardedPage = await guards.newPage()
    await guardedPage.goto(base)
    await guardedPage.locator('.location-card').first().waitFor()
    await guardedPage.evaluate(async () => {
      await navigator.serviceWorker.ready
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }))
    })
    let reloads = 0
    guardedPage.on('request', request => {
      if (request.isNavigationRequest() && request.frame() === guardedPage.mainFrame()) reloads++
    })
    await directions(guardedPage)
    await guardedPage.getByRole('button', { name: 'Start Navigation', exact: true }).first().click()
    await guardedPage.locator('.nav-instruction-card').waitFor()
    await guardedPage.evaluate(() => {
      window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
      navigator.serviceWorker.dispatchEvent(new Event('controllerchange'))
    })
    assert.equal(reloads, 0)
    assert(await guardedPage.locator('.nav-instruction-card').isVisible())
    await Promise.all([
      guardedPage.waitForEvent('request', { predicate: request => request.isNavigationRequest() && request.frame() === guardedPage.mainFrame() }),
      guardedPage.getByRole('button', { name: 'Exit navigation' }).click(),
    ])
    await guardedPage.locator('.location-card').first().waitFor()
    assert.equal(reloads, 1, 'combined worker/chunk recovery reloads once, only after exit')
    await guards.close()
    console.log('PASS: compiled update guards preserve an active route, then reload once after exit')

    // Snapshot persistence: reset module memory by closing the page. Remove the
    // legacy localStorage event cache so IndexedDB is required for this check.
    const snapshots = await browser.newContext({ viewport: { width: 390, height: 844 } })
    await configure(snapshots)
    await snapshots.unroute('https://storage.invalid/**')
    let snapshotRequests = 0
    const event = { id: 'cache-check', name: 'Saved snapshot event', fest: 'Invente',
      location_id: 'main-gate', location: { id: 'main-gate', name: 'Main Gate' }, date: '2026-10-06' }
    await snapshots.route('https://storage.invalid/**', route => {
      snapshotRequests++
      const closures = route.request().url().endsWith('closures.json')
      return route.fulfill({ json: { schema: 1, version: 10, updated_at: new Date().toISOString(), meta: {},
        data: closures ? data('closures') : [event] }, headers: { 'Access-Control-Allow-Origin': '*' } })
    })
    let snapshotPage = await snapshots.newPage()
    await snapshotPage.goto(`${base}/events`)
    await snapshotPage.getByText(event.name, { exact: true }).waitFor()
    await snapshotPage.waitForFunction(async () => {
      await navigator.serviceWorker.ready
      const request = indexedDB.open('ssn-campus-offline', 3)
      return new Promise(resolve => {
        request.onsuccess = () => {
          const db = request.result, transaction = db.transaction('bundle-cache')
          const rows = ['events', 'road-segments', 'snapshot-meta:schedule', 'snapshot-meta:closures'].map(key => transaction.objectStore('bundle-cache').get(key))
          transaction.oncomplete = () => { resolve(rows.every(row => row.result?.data)); db.close() }
        }
      })
    })
    await snapshotPage.evaluate(() => localStorage.removeItem('ssn_campus_events_v1'))
    await snapshotPage.close()
    const firstFetches = snapshotRequests
    snapshotPage = await snapshots.newPage()
    await snapshotPage.goto(`${base}/events`)
    await snapshotPage.getByText(event.name, { exact: true }).waitFor()
    assert.equal(snapshotRequests, firstFetches, 'Fresh IndexedDB snapshots survive page close with no second request')
    await snapshotPage.evaluate(() => localStorage.removeItem('ssn_campus_events_v1'))
    await snapshotPage.close()
    await snapshots.setOffline(true)
    snapshotPage = await snapshots.newPage()
    await snapshotPage.goto(`${base}/events`)
    await snapshotPage.getByText(event.name, { exact: true }).waitFor()
    await snapshots.close()
    console.log('PASS: public snapshots persist in real IndexedDB; fresh reopen avoids network; offline reopen retains saved events')

    // Independent device profiles, simultaneous startup; no shared IndexedDB
    // or application module state between users. One isolated test at a time.
    const users = Number(process.env.NAV_TEST_USERS || 3)
    // Spread renderer/socket bookkeeping over processes. A single Chrome
    // process exhausted its own resources at 100 incognito profiles locally.
    const loadBrowsers = await Promise.all(Array.from({ length: Math.ceil(users / 20) }, () => chromium.launch({ channel: 'chrome', headless: true })))
    const contexts = await Promise.all(Array.from({ length: users }, (_, i) => loadBrowsers[Math.floor(i / 20)].newContext({ viewport: { width: 360, height: 740 }, permissions: ['geolocation'], geolocation: { latitude: 12.75137, longitude: 80.204085, accuracy: 5 } })))
    await Promise.all(contexts.map(c => configure(c)))
    const pages = await Promise.all(contexts.map(c => c.newPage()))
    const started = Date.now()
    const outcomes = await Promise.allSettled(pages.map(async p => {
      await p.goto(base, { timeout: 120000 })
      await p.locator('.location-card').first().waitFor({ timeout: 120000 })
      await directions(p)
      await p.getByRole('button', { name: 'Start Navigation', exact: true }).first().click()
      await p.locator('.nav-instruction-card').waitFor({ timeout: 120000 })
      assert((await graphRecord(p)).hash)
    }))
    await Promise.all(contexts.map(c => c.close()))
    await Promise.all(loadBrowsers.map(b => b.close()))
    const failed = outcomes.filter(r => r.status === 'rejected')
    assert.equal(failed.length, 0, failed.map(r => r.reason.message).join('\n'))
    assert.equal(routeRequests, 0)
    assert.equal(healthRequests, 0)
    console.log(`PASS: ${users} independent users simultaneously opened the app and calculated local routes in ${Date.now() - started}ms; ZERO Render route/health requests`)
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
