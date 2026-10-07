/* Rendered production build, isolated fixtures only. No real admin writes,
 * load test, external map requests, credentials or shipped dependencies. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = process.env.NAV_TEST_URL || 'http://127.0.0.1:4174'
const roads = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/data/closures.json'), 'utf8'))
const event = { id: 'qa-event', name: 'QA Original', fest: 'Invente', location_id: 'cse-block',
  location: { id: 'cse-block', name: 'CSE Block', lat: 12.752, lng: 80.198 },
  date: '2026-10-07', start_time: '09:00', end_time: '17:00', description: 'Isolated QA fixture', photo_urls: [] }
let events = [], closures = roads, version = 1, unavailable = false
let renderRequests = [], storageRequests = 0

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
    await context.route('https://api.invalid/**', route => {
      renderRequests.push(route.request().url())
      return route.fulfill({ status: 503, json: { detail: 'Render asleep' } })
    })
    await context.route('https://storage.invalid/**', route => {
      storageRequests++
      if (unavailable) return route.abort('failed')
      const name = new URL(route.request().url()).pathname.split('/').at(-1)
      const data = name === 'schedule.json' ? events : name === 'closures.json' ? closures : name === 'menus.json' ? {} : []
      if (name.endsWith('.png')) return route.fulfill({ status: 404, body: '' })
      return route.fulfill({ json: { schema: 1, version, updated_at: '2026-10-07T04:00:00Z',
        meta: name === 'menus.json' ? { date_from: '2026-10-06', date_to: '2026-10-21' } : { qr_ids: [] }, data } })
    })
    // Do not generate traffic to community tile servers in automated tests.
    await context.route('https://tile.openstreetmap.org/**', route => route.abort('failed'))
    await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
    const page = await context.newPage(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.clock.install({ time: new Date('2026-10-07T04:00:00Z') })
    await page.goto(`${base}/event/qa-event`)
    await page.getByText('This event is not in the published schedule.', { exact: false }).waitFor()
    assert.equal(renderRequests.length, 0, 'A valid empty schedule must not cause live event lookups')
    // Models pending -> approved publication, without altering any live data.
    events = [event]; version++
    await page.clock.fastForward(31_000)
    await page.getByRole('heading', { name: 'QA Original', exact: true }).waitFor()
    assert.equal(await page.getByText('This event is not in the published schedule.', { exact: false }).count(), 0,
      'Successful publication must clear the initial error screen')
    events = [{ ...event, name: 'QA Edited' }]; version++
    await page.clock.fastForward(31_000)
    await page.getByRole('heading', { name: 'QA Edited', exact: true }).waitFor()
    events = []; version++
    await page.clock.fastForward(31_000)
    await page.getByText('This event is not in the published schedule.', { exact: false }).waitFor()
    assert.equal(await page.getByRole('heading', { name: 'QA Edited' }).count(), 0, 'Deletion removes the old event detail')
    events = [{ ...event, name: 'QA Reapproved' }]; version++
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.getByRole('heading', { name: 'QA Reapproved', exact: true }).waitFor()
    console.log('PASS: missing/pending event -> approval recovery -> edit -> deletion -> explicit retry, without Render.')

    await page.goto(`${base}/events`)
    await page.getByText('QA Reapproved', { exact: true }).waitFor()
    events = [{ ...event, name: 'QA Schedule Update' }]; version++
    await page.clock.fastForward(31_000)
    await page.getByText('QA Schedule Update', { exact: true }).waitFor()
    unavailable = true
    await page.clock.fastForward(60_000)
    await page.getByText('QA Schedule Update', { exact: true }).waitFor()
    await page.reload()
    await page.getByText('QA Schedule Update', { exact: true }).waitFor()
    assert.equal(renderRequests.length, 0, 'Old real IndexedDB data must protect Render during Storage outage/reopen')
    unavailable = false; events = []; version++
    await page.clock.fastForward(31_000)
    await page.getByText('No events posted yet', { exact: false }).waitFor()
    console.log('PASS: schedule refresh, Storage outage, real IndexedDB reload, recovery and confirmed-empty deletion.')

    await page.goto(base)
    await page.getByRole('textbox', { name: 'Search campus' }).fill('CSE')
    await page.locator('.location-card').filter({ hasText: 'CSE' }).first().getByRole('button', { name: 'Directions' }).click()
    await page.getByRole('button', { name: 'Start Navigation', exact: true }).first().waitFor()
    async function waitForRoad(closed) {
      await page.waitForFunction(expected => new Promise(resolve => {
        const open = indexedDB.open('ssn-campus-offline', 3)
        open.onsuccess = () => {
          const db = open.result, read = db.transaction('bundle-cache').objectStore('bundle-cache').get('road-segments')
          read.onsuccess = () => { resolve(read.result?.data?.[0]?.closed === expected); db.close() }
        }
      }), closed)
    }
    async function cancelPreview() {
      const cancel = page.getByRole('button', { name: 'Cancel', exact: true })
      if (!await cancel.count()) await page.getByRole('button', { name: 'Drag or tap to resize route preview' }).click()
      await cancel.click()
    }
    closures = [{ ...roads[0], name: 'QA Closed Road', closed: true,
      bbox: { lat_min: 12.74, lat_max: 12.76, lng_min: 80.18, lng_max: 80.21 } }]; version++
    await page.clock.fastForward(31_000)
    await waitForRoad(true)
    await cancelPreview()
    await page.locator('.location-card').filter({ hasText: 'CSE' }).first().getByRole('button', { name: 'Directions' }).click()
    await page.locator('.closure-banner').filter({ hasText: 'QA Closed Road' }).waitFor()
    closures = roads; version++
    await page.clock.fastForward(31_000)
    await waitForRoad(false)
    await cancelPreview()
    await page.locator('.location-card').filter({ hasText: 'CSE' }).first().getByRole('button', { name: 'Directions' }).click()
    await page.getByRole('button', { name: 'Start Navigation', exact: true }).first().waitFor()
    assert.equal(await page.locator('.closure-banner').filter({ hasText: 'QA Closed Road' }).count(), 0)
    console.log('PASS: published closure/reopening changes the next local route; no frozen closure copy or Render requests.')
    // Cross the analytics flush interval, hide and reconnect: still no telemetry.
    await page.clock.fastForward(61_000)
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('online'))
    })
    assert.equal(renderRequests.length, 0)
    assert.deepEqual(errors, [])
    console.log(`PASS: route preview with tile server unavailable; zero Render requests including analytics/QR; ${storageRequests} isolated Storage requests.`)
    await context.close()
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
