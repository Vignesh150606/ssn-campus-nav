#!/usr/bin/env node
/**
 * Routing parity test — backend/utils/router.py (Python) vs
 * frontend/src/offline/offlineRouter.js (the browser router, run in Node).
 *
 *   node scripts/routing_parity/parity.mjs [--quick] [--grid-step=25]
 *        [--max-print=25] [--json=<mismatches.json>] [--py-cache=<file>] [--count-only] [--keep]
 *
 * Both routers are fed the SAME cases, built here:
 *   pairs/open        every ordered pair of locations (find_route)
 *   pairs/closures    every ordered pair under each single-road closure
 *                     and under "everything closed"
 *   gps/grid          fine grid of live GPS points over the whole campus
 *                     (+ margin) x every destination, accuracy unknown/12m
 *   gps/accuracy      coarser grid x destination subset x accuracy sweep
 *   gps/prefer-node   coarser grid x destination subset x prefer_node
 *                     (3 nearest nodes, capped nodes, far node, bogus id)
 *   gps/closures      coarser grid x destination subset x closure scenarios
 *   gps/on-nodes      exactly on, and 1m north of, every graph node
 *   gps/cap-rings     rings of points (several distances/bearings) around
 *                     every UNVERIFIED_CONNECTOR_CAP_M node, plus the exact
 *                     coordinates router.py's comments cite as regressions
 *                     — this is what reaches the capped-node fallback branch
 *   unit/round1       JS round1() vs Python round(x, 1) on tie/near-tie values
 *   unit/pointDist    JS pointDist() vs Python _point_dist(), exact equality
 * and the results are compared field by field: node path, junction flags,
 * path geometry, distance, ETA, snapped node, snap distance, closure
 * warning, and error messages. Exits non-zero if anything differs.
 *
 * Python is run unmodified (py_router_runner.py). The graph is loaded from
 * the single canonical file backend/data/walkway_graph.json, which is the
 * same file Python reads and the frontend bundles.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const GRAPH_FILE = path.join(ROOT, 'backend', 'data', 'walkway_graph.json')
const SEGS_FILE = path.join(ROOT, 'backend', 'data', 'road_segments.json')

// ── args ──────────────────────────────────────────────────────────────────
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=')
  return [k, rest.length ? rest.join('=') : true]
}))
// --router=<file> swaps in another build of the JS router. Used only to
// mutation-test this harness (break a rule on purpose, confirm it's caught).
const ROUTER_FILE = args.router
  ? path.resolve(args.router)
  : path.join(ROOT, 'frontend', 'src', 'offline', 'offlineRouter.js')
const {
  findRoute, findRouteFromPoint, pointDist, round1,
  HOSTEL_DEST, HOSTEL_PENALTY, CLOSURE_PENALTY, WALKING_MPS,
  NEAREST_NODE_CANDIDATES, SNAP_MARGIN_M, STICKY_MIN_MARGIN_M, UNVERIFIED_CONNECTOR_CAP_M,
} = await import(pathToFileURL(ROUTER_FILE).href)
const QUICK = !!args.quick
const GRID_STEP_M = Number(args['grid-step'] || (QUICK ? 75 : 25))
const MAX_PRINT = Number(args['max-print'] || 25)

const failures = [] // pre-check failures (not per-case mismatches)

// ── 1. one graph data source ──────────────────────────────────────────────
function findGraphCopies(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist') continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) findGraphCopies(p, out)
    else if (ent.name === 'walkway_graph.json') out.push(path.relative(ROOT, p))
  }
  return out
}
const copies = findGraphCopies(ROOT)
if (copies.length !== 1 || copies[0] !== path.join('backend', 'data', 'walkway_graph.json')) {
  failures.push(`expected exactly one walkway_graph.json (backend/data/), found: ${copies.join(', ') || 'none'}`)
}
// The frontend imports it through the '@graph' alias in vite.config.js.
const viteCfg = fs.readFileSync(path.join(ROOT, 'frontend', 'vite.config.js'), 'utf8')
if (!/'@graph'/.test(viteCfg) || !/\.\.\/backend\/data/.test(viteCfg)) {
  failures.push("frontend/vite.config.js does not alias '@graph' to ../backend/data")
}

const graph = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'))
const baseSegs = JSON.parse(fs.readFileSync(SEGS_FILE, 'utf8'))

// ── 2. inputs ─────────────────────────────────────────────────────────────
const isNode = (id) => /^n_\d+$/.test(id)
const locationIds = [...new Set(graph.location_edges.flatMap((e) => [e.from, e.to]).filter((id) => !isNode(id)))].sort()

const scenarios = [] // [{name, segs}]
const scenarioIdx = {}
function addScenario(name, closedIds) {
  scenarioIdx[name] = scenarios.length
  scenarios.push({ name, segs: baseSegs.map((s) => ({ ...s, closed: closedIds.has(s.id) })) })
}
addScenario('open', new Set())
for (const s of baseSegs) addScenario(`close:${s.id}`, new Set([s.id]))
addScenario('close:all', new Set(baseSegs.map((s) => s.id)))
const closureScenarioNames = scenarios.map((s) => s.name).filter((n) => n !== 'open')

const wantedDests = ['main-gate', 'cse-block', 'it-block', 'boys-hostel-gate', 'boys-hostel-office',
  'central-library', 'food-aswins', 'ssn-fountain', 'girls-hostel', 'parking']
const destSubset = (QUICK ? wantedDests.slice(0, 4) : wantedDests).filter((d) => locationIds.includes(d))
const allDests = QUICK ? destSubset : locationIds

function gridPoints(stepM, marginM = 30) {
  const lats = graph.nodes.map((n) => n.lat)
  const lngs = graph.nodes.map((n) => n.lng)
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2
  const dLat = stepM / 111320
  const dLng = stepM / (111320 * Math.cos((midLat * Math.PI) / 180))
  const mLat = marginM / 111320
  const mLng = marginM / (111320 * Math.cos((midLat * Math.PI) / 180))
  const pts = []
  for (let lat = Math.min(...lats) - mLat; lat <= Math.max(...lats) + mLat; lat += dLat) {
    for (let lng = Math.min(...lngs) - mLng; lng <= Math.max(...lngs) + mLng; lng += dLng) {
      pts.push([Number(lat.toFixed(7)), Number(lng.toFixed(7))])
    }
  }
  return pts
}

function nearestNodeIds(lat, lng, k) {
  return graph.nodes
    .map((n) => ({ id: n.id, d: pointDist(lat, lng, n.lat, n.lng) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, k)
    .map((x) => x.id)
}

// ── 3. cases ──────────────────────────────────────────────────────────────
// case = [scenarioIdx, 'r', from, to]  |  [scenarioIdx, 'p', lat, lng, to, accuracy|null, prefer|null]
const cases = []
const groupOf = [] // parallel to cases
function add(group, c) { cases.push(c); groupOf.push(group) }

for (const a of locationIds) for (const b of locationIds) if (a !== b) add('pairs/open', [0, 'r', a, b])
for (const name of closureScenarioNames) {
  if (QUICK && name !== 'close:all' && name !== closureScenarioNames[0]) continue
  for (const a of locationIds) for (const b of locationIds) if (a !== b) add('pairs/closures', [scenarioIdx[name], 'r', a, b])
}

const fine = gridPoints(GRID_STEP_M)
const coarse = gridPoints(GRID_STEP_M * 2)
for (const [lat, lng] of fine) {
  for (const to of allDests) for (const acc of [null, 12]) add('gps/grid', [0, 'p', lat, lng, to, acc, null])
}
for (const [lat, lng] of coarse) {
  for (const to of destSubset) for (const acc of [3, 8, 20, 40, 80]) add('gps/accuracy', [0, 'p', lat, lng, to, acc, null])
}
const cappedPrefs = ['n_193', 'n_194', 'n_136', 'n_137']
for (const [lat, lng] of coarse) {
  const prefs = [...nearestNodeIds(lat, lng, 3), ...cappedPrefs, 'n_2', 'n_does_not_exist']
  for (const to of destSubset) for (const acc of [null, 15]) for (const pref of prefs) {
    add('gps/prefer-node', [0, 'p', lat, lng, to, acc, pref])
  }
}
for (const name of closureScenarioNames) {
  if (QUICK && name !== 'close:all' && name !== closureScenarioNames[0]) continue
  for (const [lat, lng] of coarse) for (const to of destSubset) add('gps/closures', [scenarioIdx[name], 'p', lat, lng, to, null, null])
}
for (const n of graph.nodes) {
  const north = Number((n.lat + 1 / 111320).toFixed(7))
  for (const to of allDests) {
    add('gps/on-nodes', [0, 'p', n.lat, n.lng, to, null, null])
    add('gps/on-nodes', [0, 'p', north, n.lng, to, 10, null])
  }
}

// Rings around every capped node: distances straddle the 15m cap and the
// 30m snap margin so the shortlist is empty / capped-out in some of them.
const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
const ringDists = QUICK ? [16, 32, 45] : [5, 16, 20, 32, 45, 70]
const ringBearings = QUICK ? [0, 90, 180, 270] : [0, 45, 90, 135, 180, 225, 270, 315]
for (const id of Object.keys(UNVERIFIED_CONNECTOR_CAP_M)) {
  const n = nodeById.get(id)
  if (!n) continue
  const cosLat = Math.cos((n.lat * Math.PI) / 180)
  for (const d of ringDists) for (const brg of ringBearings) {
    const lat = Number((n.lat + (d * Math.cos((brg * Math.PI) / 180)) / 111320).toFixed(7))
    const lng = Number((n.lng + (d * Math.sin((brg * Math.PI) / 180)) / (111320 * cosLat)).toFixed(7))
    for (const to of destSubset) for (const acc of [null, 12]) add('gps/cap-rings', [0, 'p', lat, lng, to, acc, null])
  }
}
// Coordinates router.py's comments cite from field tests / regressions.
for (const [lat, lng] of [[12.75169801107917, 80.19762395087547], [12.752222, 80.197111]]) {
  for (const to of locationIds) for (const acc of [null, 12, 40]) add('gps/cap-rings', [0, 'p', lat, lng, to, acc, null])
}

// Unit-level: values where round(x, 1) and Math.round(x * 10) / 10 disagree
// (0.35, 2.675-style binary-below-half values) and exact binary ties (x.25,
// x.75), plus a pseudo-random sweep.
const unitValues = []
for (let k = 0; k <= 4000; k++) unitValues.push(k / 20, k / 4, k / 20 + 1e-9, k / 20 - 1e-9)
let seed = 12345
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
for (let k = 0; k < 4000; k++) unitValues.push(rnd() * 1500)
for (const v of unitValues) add('unit/round1', [0, 'x', v])
// Distances between arbitrary campus-scale point pairs.
for (let k = 0; k < 6000; k++) {
  const a = graph.nodes[Math.floor(rnd() * graph.nodes.length)]
  const b = graph.nodes[Math.floor(rnd() * graph.nodes.length)]
  const jitter = () => (rnd() - 0.5) * 0.004
  add('unit/pointDist', [0, 'd', a.lat + jitter(), a.lng + jitter(), b.lat + jitter(), b.lng + jitter()])
}

if (args['count-only']) {
  console.log(`${cases.length} cases`)
  process.exit(0)
}

// ── 4. Python side ────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'routing_parity_'))
const casesFile = path.join(tmp, 'cases.json')
const pyOutFile = path.join(tmp, 'py_results.json')
fs.writeFileSync(casesFile, JSON.stringify({ scenarios: scenarios.map((s) => s.segs), cases }))

console.log(`Routing parity: ${cases.length.toLocaleString()} cases` +
  ` (${locationIds.length} locations, ${graph.nodes.length} nodes, ${graph.edges.length} edges,` +
  ` grid ${GRID_STEP_M}m${QUICK ? ', --quick' : ''})`)
let t0 = Date.now()
// --py-cache=<file>: reuse Python's results when the case list is unchanged
// (they only depend on router.py + the data, never on the JS side). Handy
// when iterating on the JS router; leave it off for a real verification run.
const casesSha = crypto.createHash('sha1').update(fs.readFileSync(casesFile)).digest('hex')
const routerPySha = crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, 'backend', 'utils', 'router.py')))
  .update(fs.readFileSync(GRAPH_FILE)).digest('hex')
let pyPayload = null
if (args['py-cache'] && fs.existsSync(args['py-cache'])) {
  const cached = JSON.parse(fs.readFileSync(args['py-cache'], 'utf8'))
  if (cached.casesSha === casesSha && cached.routerPySha === routerPySha) pyPayload = cached.payload
}
if (pyPayload) {
  console.log('  python router: using --py-cache')
} else {
  const py = spawnSync('python3', [path.join(HERE, 'py_router_runner.py'), casesFile, pyOutFile], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, PYTHONUTF8: '1' } })
  if (py.status !== 0) {
    console.error('Python runner failed (exit ' + py.status + ')')
    process.exit(2)
  }
  console.log(`  python router: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  pyPayload = JSON.parse(fs.readFileSync(pyOutFile, 'utf8'))
  if (args['py-cache']) fs.writeFileSync(args['py-cache'], JSON.stringify({ casesSha, routerPySha, payload: pyPayload }))
}
const { meta: pyMeta, results: pyResults } = pyPayload

if (fs.realpathSync(GRAPH_FILE) !== pyMeta.graph_path) {
  failures.push(`Python reads ${pyMeta.graph_path}, JS parity run reads ${fs.realpathSync(GRAPH_FILE)}`)
}

// ── 5. constants must match ───────────────────────────────────────────────
const jsConstants = {
  HOSTEL_DEST: [...HOSTEL_DEST].sort(),
  HOSTEL_PENALTY, CLOSURE_PENALTY, WALKING_MPS, NEAREST_NODE_CANDIDATES, SNAP_MARGIN_M, STICKY_MIN_MARGIN_M,
  UNVERIFIED_CONNECTOR_CAP_M,
}
for (const k of Object.keys(pyMeta.constants)) {
  if (JSON.stringify(pyMeta.constants[k]) !== JSON.stringify(jsConstants[k])) {
    failures.push(`constant ${k} differs: python=${JSON.stringify(pyMeta.constants[k])} js=${JSON.stringify(jsConstants[k])}`)
  }
}

// ── 6. JS side ────────────────────────────────────────────────────────────
function digest(r) {
  const sig = crypto.createHash('sha1')
  for (const p of r.path) sig.update(`${p.lat.toFixed(9)},${p.lng.toFixed(9)};`)
  return {
    ok: true,
    nodes: r.path.filter((p) => p.id !== null).map((p) => p.id),
    n: r.path.length,
    junc: r.path.map((p) => (p.junction ? '1' : '0')).join(''),
    sig: sig.digest('hex').slice(0, 16),
    dist: r.distance_m,
    eta: r.eta_minutes,
    snap: r.snapped_to ?? null,
    snapd: r.snap_distance_m ?? null,
    warn: r.warning,
    jn: r.junctions,
  }
}
t0 = Date.now()
const jsResults = cases.map((c) => {
  const segs = scenarios[c[0]].segs
  try {
    if (c[1] === 'x') return { ok: true, v: round1(c[2]) }
    if (c[1] === 'd') return { ok: true, v: pointDist(c[2], c[3], c[4], c[5]) }
    if (c[1] === 'r') return digest(findRoute(graph, segs, c[2], c[3]))
    return digest(findRouteFromPoint(graph, segs, c[2], c[3], c[4], { accuracyM: c[5], preferNodeId: c[6] }))
  } catch (e) {
    return { ok: false, err: e.message }
  }
})
console.log(`  js router:     ${((Date.now() - t0) / 1000).toFixed(1)}s`)

// ── 7. compare ────────────────────────────────────────────────────────────
const FIELDS = ['nodes', 'n', 'junc', 'sig', 'dist', 'eta', 'snap', 'snapd', 'warn', 'jn']
let ulpNoise = 0 // pointDist results that differ from Python only in the last bits (<= 1e-9 m)
let maxUlpM = 0
const stats = new Map() // group -> {total, bad}
const byKind = new Map()
const mismatches = []

function describe(c) {
  const sc = scenarios[c[0]].name
  if (c[1] === 'x') return `round(${c[2]}, 1)`
  if (c[1] === 'd') return `_point_dist(${c.slice(2).join(', ')})`
  return c[1] === 'r'
    ? `find_route(${c[2]} -> ${c[3]}) [${sc}]`
    : `find_route_from_point(${c[2]}, ${c[3]} -> ${c[4]}, acc=${c[5]}, prefer=${c[6]}) [${sc}]`
}

for (let i = 0; i < cases.length; i++) {
  const g = groupOf[i]
  const s = stats.get(g) || { total: 0, bad: 0 }
  s.total++
  const a = pyResults[i]
  const b = jsResults[i]
  let kind = null
  const diffs = []
  if (cases[i][1] === 'x' || cases[i][1] === 'd') {
    // Unit comparisons: exact equality for round1; for pointDist, V8's and
    // glibc's sin/cos/asin may differ in the last bit — tolerated (and
    // counted separately) up to 1e-9 m, since the route-level groups above
    // are what prove it never changes a node path or a rounded distance.
    if (a.v !== b.v) {
      const delta = Math.abs(a.v - b.v)
      if (cases[i][1] === 'd' && delta <= 1e-9) { ulpNoise++; maxUlpM = Math.max(maxUlpM, delta) }
      else kind = cases[i][1] === 'x' ? 'round1 differs from Python round(x, 1)' : 'pointDist differs beyond 1e-9 m'
    }
    if (kind) { diffs.push('v') }
  } else if (a.ok !== b.ok) kind = 'ok/error status'
  else if (!a.ok) { if (a.err !== b.err) kind = 'error message' }
  else {
    for (const f of FIELDS) if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) diffs.push(f)
    if (diffs.length) {
      if (diffs.includes('nodes') || diffs.includes('snap')) kind = 'node path / snapped node'
      else if (diffs.includes('sig') || diffs.includes('n') || diffs.includes('junc')) kind = 'path geometry / junction flags'
      else if (diffs.every((f) => ['dist', 'eta', 'snapd'].includes(f)) &&
               ['dist', 'eta', 'snapd'].every((f) => a[f] == null || b[f] == null || Math.abs(a[f] - b[f]) <= 0.1000001)) {
        kind = 'last-digit rounding (<=0.1)'
      } else kind = 'distance / eta / other'
    }
  }
  if (kind) {
    s.bad++
    byKind.set(kind, (byKind.get(kind) || 0) + 1)
    mismatches.push({ group: g, kind, case: describe(cases[i]), diffs, python: a, js: b })
  }
  stats.set(g, s)
}

// ── 8. report ─────────────────────────────────────────────────────────────
console.log('\nGroup                 cases    mismatches')
let totalBad = 0
for (const [g, s] of stats) {
  totalBad += s.bad
  console.log(`  ${g.padEnd(18)} ${String(s.total).padStart(8)}  ${String(s.bad).padStart(8)}`)
}
console.log(`  ${'TOTAL'.padEnd(18)} ${String(cases.length).padStart(8)}  ${String(totalBad).padStart(8)}`)

if (ulpNoise) {
  console.log(`\nNote: ${ulpNoise} of the unit/pointDist results differ from Python in the last bits only ` +
    `(max ${maxUlpM.toExponential(2)} m) — libm vs V8 sin/cos/asin; no route-level output was affected.`)
}
if (failures.length) {
  console.log('\nPRE-CHECK FAILURES:')
  for (const f of failures) console.log('  ✗ ' + f)
}
if (totalBad) {
  console.log('\nMismatches by kind:')
  for (const [k, n] of byKind) console.log(`  ${String(n).padStart(7)}  ${k}`)
  console.log(`\nFirst ${Math.min(MAX_PRINT, mismatches.length)} mismatches:`)
  for (const m of mismatches.slice(0, MAX_PRINT)) {
    console.log(`\n  [${m.kind}] ${m.case}`)
    if (m.python.ok && m.js.ok) {
      for (const f of m.diffs) {
        const show = (v) => (Array.isArray(v) && v.length > 12 ? `[${v.slice(0, 4).join(',')} … ${v.slice(-4).join(',')}] (${v.length})` : JSON.stringify(v))
        console.log(`      ${f}: python=${show(m.python[f])}  js=${show(m.js[f])}`)
      }
    } else {
      console.log(`      python=${JSON.stringify(m.python)}  js=${JSON.stringify(m.js)}`)
    }
  }
}
if (args.json) {
  fs.writeFileSync(args.json, JSON.stringify(mismatches, null, 2))
  console.log(`\nWrote ${mismatches.length} mismatches to ${args.json}`)
}
if (!args.keep) fs.rmSync(tmp, { recursive: true, force: true })

const ok = !totalBad && !failures.length
console.log(`\n${ok ? 'PASS' : 'FAIL'} — ${cases.length.toLocaleString()} cases, ${totalBad} mismatches, ${failures.length} pre-check failures`)
process.exit(ok ? 0 : 1)
