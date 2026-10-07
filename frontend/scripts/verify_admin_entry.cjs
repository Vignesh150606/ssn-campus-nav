/* Built-page verification with fake API responses; never uses live credentials
 * or writes production data. Run with NAV_TEST_URL and PLAYWRIGHT_MODULE_PATH. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = process.env.NAV_TEST_URL || 'http://127.0.0.1:4174'
const dist = process.env.NAV_TEST_DIST || path.join(__dirname, '../dist')
const sw = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8')
const adminHTML = fs.readFileSync(path.join(dist, 'admin/index.html'), 'utf8')
const adminEntry = adminHTML.match(/src="\/(assets\/admin-[^"]+\.js)"/)[1]
assert(!sw.includes(`url:"${adminEntry}"`), 'Visitor precache must exclude admin entry')
assert(!sw.includes('url:"admin/index.html"'), 'Visitor precache must exclude admin HTML')
for (const name of ['FestAdminDashboard', 'AccountSettings', 'AdminAnalytics', 'AdminFeedback', 'ManageFestAdmins', 'DevTools']) {
  assert(!new RegExp(`url:"assets/${name}-`).test(sw), `${name} must not be precached`)
}
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../vercel.json'), 'utf8'))
assert.equal(config.rewrites[0].source, '/admin')
assert.equal(config.rewrites[0].destination, '/admin/index.html')
assert.equal(config.rewrites[1].source, '/admin/:path*')

const token = role => `qa.${Buffer.from(JSON.stringify({ role, username: 'qa-admin' })).toString('base64url')}.qa`
const event = { id: 'qa-admin-event', name: 'QA Admin Event', status: 'pending', fest: 'Invente',
  date: '2026-10-07', start_time: '09:00', end_time: '17:00', location_id: 'cse-block', photo_urls: [] }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2iEAAAAASUVORK5CYII=', 'base64')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 320, height: 700 } })
    const requests = [], errors = []
    let role = 'superadmin', rejected = false, approved = false
    await context.addInitScript(() => {
      window.qaGPSRequests = 0
      navigator.geolocation.watchPosition = () => { window.qaGPSRequests++; return 1 }
      navigator.geolocation.getCurrentPosition = () => { window.qaGPSRequests++ }
    })
    await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
    await context.route('https://tile.openstreetmap.org/**', route => route.fulfill({ contentType: 'image/png', body: png }))
    await context.route('https://storage.invalid/**', route => route.fulfill({ json: { schema: 1, version: 1, data: [] } }))
    await context.route('https://api.invalid/**', route => {
      const request = route.request(), pathname = new URL(request.url()).pathname
      if (pathname === '/api/admin/login') return route.fulfill(rejected
        ? { status: 401, json: { detail: 'Invalid credentials' } }
        : { json: { access_token: token(role), role, username: 'qa-admin' } })
      if (pathname.startsWith('/api/admin/')) {
        assert.equal(request.headers().authorization, `Bearer ${token(role)}`)
        if (pathname.endsWith('/verify')) { approved = true; return route.fulfill({ json: { message: 'Approved' } }) }
        if (pathname === '/api/admin/events') return route.fulfill({ json: [{ ...event, status: approved ? 'verified' : 'pending' }] })
      }
      if (pathname === '/api/road-segments' || pathname === '/api/locations') return route.fulfill({ json: [] })
      return route.fulfill({ status: 503, json: { detail: 'Backend unavailable' } })
    })
    context.on('request', request => requests.push(request.url()))
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${base}/admin`)
    await page.getByText('Admin Login', { exact: true }).waitFor()
    assert.equal(await page.locator('.app-header, .install-prompt, .leaflet-container, .dev-panel').count(), 0)
    assert.equal(await page.evaluate(() => window.qaGPSRequests), 0)
    assert.equal(requests.filter(url => /api\.invalid|storage\.invalid|\/data\//.test(url)).length, 0,
      'Login must not request health, snapshots, graph, locations, or API data')
    assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0,
      'Admin entry must not install the visitor PWA')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.getByRole('button', { name: /Switch to .* theme/ }).click()
    await page.screenshot({ path: path.join(dist, '../admin-login-320.png') })
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill('qa-admin')
    await page.getByLabel('Password', { exact: true }).fill('test-only')
    rejected = true
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByText('Invalid credentials', { exact: true }).waitFor()
    rejected = false
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByText('Role: Super Admin', { exact: true }).waitFor()
    await page.getByRole('button', { name: '✓ Approve', exact: true }).click()
    await page.getByText('Approved', { exact: true }).first().waitFor()
    assert(approved, 'Existing event approval must send its authenticated mutation')
    await page.getByRole('button', { name: 'Road Closures', exact: true }).click()
    await page.getByText('Toggle road segments on/off.', { exact: false }).waitFor()
    await page.getByRole('button', { name: '+ Add Event', exact: true }).click()
    await page.getByText('Add New Event', { exact: true }).waitFor()
    await page.getByRole('button', { name: /Account Settings/ }).click()
    await page.getByText('Signed in as', { exact: false }).waitFor()
    await page.reload()
    await page.getByText('Role: Super Admin', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: path.join(dist, '../admin-dashboard-320.png') })
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page.getByText('Admin Login', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => sessionStorage.getItem('ssn_admin_token_v1')), null)
    role = 'festadmin'
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill('qa-admin')
    await page.getByLabel('Password', { exact: true }).fill('test-only')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByText('Role: Fest Admin', { exact: true }).waitFor()
    await page.getByText('QA Admin Event', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Road Closures', exact: true }).count(), 0)
    await page.getByRole('button', { name: '+ Add Fest Schedule', exact: true }).click()
    await page.getByRole('button', { name: 'Submit (pending review)', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    assert.equal(await page.evaluate(() => window.qaGPSRequests), 0)
    console.log('PASS: independent login without visitor bootstrap; rejected login; both roles, approval, tabs, session reload and logout; 320px layout.')

    await page.getByRole('link', { name: 'Open campus app', exact: true }).click()
    await page.getByRole('textbox', { name: 'Search campus' }).waitFor()
    assert.equal(await page.getByRole('link', { name: 'Admin', exact: true }).count(), 0)
    await page.waitForFunction(() => !!navigator.serviceWorker.controller)
    const before = requests.length
    await page.goto(`${base}/admin/`)
    await page.getByText('Admin Login', { exact: true }).waitFor()
    await page.reload()
    await page.getByText('Admin Login', { exact: true }).waitFor()
    assert.equal(requests.slice(before).filter(url => /api\.invalid|storage\.invalid|\/data\//.test(url)).length, 0,
      'A visitor service worker must not turn admin navigation into the visitor shell')
    assert.deepEqual(errors, [])
    await context.close()
    console.log('PASS: hidden visitor admin link; existing visitor PWA active; admin direct navigation/reload bypasses its app-shell fallback.')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
