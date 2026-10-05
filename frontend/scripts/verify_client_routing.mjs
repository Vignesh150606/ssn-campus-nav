#!/usr/bin/env node
/**
 * Verifies the real app modules (src/api.js -> routing/clientRouting.js ->
 * offline/offlineRouter.js, loaded through Vite so the '@graph' alias and
 * VITE_ROUTING_MODE behave exactly as in the app) against a counting fetch:
 *
 *   client mode  every route/reroute call — named, GPS, async and sync —
 *                makes ZERO fetch calls; closures fed in via the same
 *                setter api.js uses change the route and add the warning.
 *   server mode  getRoute asks the server (1 fetch per call); when that
 *                fails it falls back to the on-device router and still
 *                returns the same route as client mode.
 *
 *   node scripts/verify_client_routing.mjs            (runs both modes)
 *   node scripts/verify_client_routing.mjs --mode=client|server
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const FRONT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modeArg = process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1]

if (!modeArg) {
  let bad = 0
  for (const mode of ['client', 'server']) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--mode=${mode}`], {
      cwd: FRONT, stdio: 'inherit', env: { ...process.env, VITE_ROUTING_MODE: mode, VITE_API_BASE: 'http://127.0.0.1:1' },
    })
    if (r.status !== 0) bad++
  }
  process.exit(bad ? 1 : 0)
}

const { createServer } = await import('vite')
let fetchCalls = 0
let closureData = []
let routeCalls = 0
globalThis.fetch = async (url) => {
  fetchCalls++
  if (String(url).includes('/api/route?')) { routeCalls++; throw new TypeError('network unreachable (stub)') }
  if (String(url).includes('closures.json')) return Response.json({ schema: 1, version: Date.now(), data: closureData })
  if (String(url).endsWith('/api/road-segments')) return Response.json(closureData)
  if (url === '/data/locations.json') return Response.json([])
  throw new TypeError('network unreachable (stub)')
}

const vite = await createServer({ root: FRONT, logLevel: 'error', server: { middlewareMode: true }, appType: 'custom' })
const checks = []
const check = (name, ok, extra = '') => { checks.push(ok); console.log(`  ${ok ? '✓' : '✗'} [${modeArg}] ${name}${extra ? ' — ' + extra : ''}`) }

try {
  const api = await vite.ssrLoadModule('/src/api.js')
  const cr = await vite.ssrLoadModule('/src/routing/clientRouting.js')
  const data = await vite.ssrLoadModule('/src/data/dataClient.js')
  const mode = (await vite.ssrLoadModule('/src/routing/routingMode.js')).ROUTING_MODE
  check('ROUTING_MODE matches VITE_ROUTING_MODE', mode === modeArg, mode)

  const dests = ['cse-block', 'it-block', 'central-library', 'boys-hostel-gate', 'ssn-fountain']
  const gps = [[12.7513, 80.1971], [12.7522, 80.1975], [12.7509, 80.2001]]

  // Reference: what the pure client router gives, for comparison.
  cr.setRoadSegmentsSnapshot([])
  const ref = cr.routeToLocationSync('main-gate', 'cse-block')

  if (modeArg === 'client') {
    for (const d of dests) await api.getRoute('main-gate', d)
    for (const [la, ln] of gps) for (const d of dests) await api.getRouteFromCoords(la, ln, d, 12, null, { isReroute: true })
    for (const [la, ln] of gps) api.getRouteFromCoordsSync(la, ln, 'cse-block', 12, 'n_2', { isReroute: true })
    api.getRouteSync('main-gate', 'it-block')
    check('15+ named/GPS/sync routes made zero route API calls', routeCalls === 0, `route API calls: ${routeCalls}; static/live input reads: ${fetchCalls}`)

    const r = await api.getRoute('main-gate', 'cse-block')
    check('route has the /api/route response shape', r.path?.length > 1 && 'distance_m' in r && 'eta_minutes' in r && r.source === 'client' && r.warning === null)
    check('path points carry id/junction (turn gating inputs)', r.path.every((p) => 'id' in p && 'junction' in p))

    const base = await api.getRoute('main-gate', 'cse-block')
    closureData = [{ id: 'x', name: 'Test Road', closed: true, bbox: { lat_min: 12.74, lat_max: 12.76, lng_min: 80.18, lng_max: 80.21 } }]
    data._state().closures.fetchedAt = 0
    const closed = await api.getRoute('main-gate', 'cse-block')
    check('expired closures are refreshed through the getter and affect routing', closed.warning === 'Note: Test Road is closed. Using alternate route.' && routeCalls === 0)
    closureData = []
    data._state().closures.fetchedAt = 0
    check('reopening restores the original route', (await api.getRoute('main-gate', 'cse-block')).distance_m === base.distance_m)

    let threw = false
    try { await api.getRoute('main-gate', 'no-such-place') } catch (e) { threw = /No road connection/.test(e.message) }
    check("unknown destination errors client-side (no server fallback)", threw && routeCalls === 0)
  } else {
    const r = await api.getRoute('main-gate', 'cse-block')
    check('server mode asked the server first (1 route API fetch)', routeCalls === 1, `route API calls: ${routeCalls}`)
    check('failed request fell back to on-device route, identical to client mode', r.distance_m === ref.distance_m && JSON.stringify(r.path) === JSON.stringify(ref.path))
    fetchCalls = 0
    routeCalls = 0
    await api.getRouteFromCoords(12.7513, 80.1971, 'cse-block', 12, null)
    check('GPS route in server mode also tries the server once, then falls back', routeCalls === 1)
  }
} finally {
  await vite.close()
}
const ok = checks.every(Boolean)
console.log(ok ? `  PASS (${modeArg})` : `  FAIL (${modeArg})`)
process.exit(ok ? 0 : 1)
