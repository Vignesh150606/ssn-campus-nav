// Real existing Python classifier, no backend dependencies, credentials or .env.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const locations = JSON.parse(readFileSync(new URL('../public/data/locations.json', import.meta.url), 'utf8'))
const vocab = JSON.parse(readFileSync(new URL('../src/copilot/vocabulary.json', import.meta.url), 'utf8'))
const questions = ['', 'HI!', 'ECE 302', 'CSE Lab 4', 'IT-101', 'IT', 'where is it', 'weather', 'cancel navigation',
  'stop navigation', 'take me there', 'preview route', 'how long', 'nearest', 'vegetarian', 'show details',
  'where am I', 'distance from library to ece', 'how far is main gate from cse', 'events near me',
  'events starting in 30 minutes', "what's happening now?", "today's schedule", "what's upcoming?", 'nearby',
  'show main canteen menu', 'what is available', 'i need placement', 'i am hungry', 'wheelchair accessible']
for (const loc of locations) {
  for (const name of [loc.name, ...(vocab.LOCATION_ALIASES[loc.id] || [])]) {
    questions.push(name, `Where is ${name}?`, `take me to ${name} please`, `Tell me about ${name}`, name.slice(0, -1))
  }
}
for (const [key, value] of Object.entries(vocab)) {
  if (Array.isArray(value) && !key.startsWith('_')) questions.push(...value)
  if (key.startsWith('NEED_ALIASES')) for (const phrases of Object.values(value)) questions.push(...phrases)
}
const python = process.env.PYTHON_FOR_TESTS || 'python'
const reference = JSON.parse(execFileSync(python, ['-c', `
import sys,json,ast,pathlib
from utils.copilot import classify
payload=json.load(sys.stdin)
vocab={}
for n in ast.parse(pathlib.Path('utils/copilot.py').read_text(encoding='utf-8')).body:
 if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name):
  try: value=ast.literal_eval(n.value)
  except (ValueError,TypeError): continue
  if isinstance(value,(dict,list,set)): vocab[n.targets[0].id]=sorted(value) if isinstance(value,set) else value
print(json.dumps({'vocabulary':vocab,'results':[classify(q,payload['locations']) for q in payload['questions']]}))
`], { cwd: fileURLToPath(new URL('../../backend/', import.meta.url)), input: JSON.stringify({ questions, locations }), encoding: 'utf8', maxBuffer: 5_000_000 }))
assert.deepEqual(vocab, reference.vocabulary, 'Browser vocabulary drifted from Python')
const vite = await createServer({ root, configFile: false, envDir: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  define: { 'import.meta.env.VITE_API_BASE': JSON.stringify('https://api.invalid') },
  server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
const originalFetch = globalThis.fetch
try {
  const { classifyLocal } = await vite.ssrLoadModule('/src/copilot/localClassifier.js')
  const keys = ['intent', 'need_type', 'direct_location_id', 'resolved_locations', 'resolved_from', 'resolved_to', 'classroom', 'info_mode']
  const project = r => Object.fromEntries(keys.map(k => [k, Array.isArray(r[k])
    ? r[k].map(({ score: _score, ...entity }) => entity) : r[k]]))
  questions.forEach((q, i) => {
    const actual = classifyLocal(q, locations), expected = reference.results[i]
    assert.deepEqual(project(actual), project(expected), q)
    for (const key of ['resolved_locations', 'resolved_from', 'resolved_to']) actual[key].forEach((r, j) => {
      // Python rounds decimal ties differently from Math.round; this cannot
      // change intent, candidate ordering, cutoff or selected navigation action.
      assert.ok(Math.abs(r.score - expected[key][j].score) < 0.00101, `${q}: confidence`)
    })
  })
  for (const q of ['ECE302', 'CSE101']) assert.equal(classifyLocal(q, locations).intent, 'classroom_finder')
  const { runTurn } = await vite.ssrLoadModule('/src/copilot/copilotEngine.js')
  let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error('No internet') }
  const deps = { locations, position: { lat: 12.751, lng: 80.196 } }
  const building = await runTurn('Where is the library?', {}, deps)
  assert.equal(building.cards[0].id, 'central-library')
  const followUp = await runTurn('Navigate there', building.newState, deps)
  assert.deepEqual(followUp.action, { type: 'start_navigation', locationId: 'central-library' })
  const interlude = await runTurn('Does this work offline?', building.newState, deps)
  assert.deepEqual((await runTurn('Navigate there', interlude.newState, deps)).action, followUp.action, 'FAQ must preserve the selected destination')
  assert.equal((await runTurn('cancel navigation', {}, deps)).action.type, 'cancel_navigation')
  assert.ok((await runTurn('ECE302', {}, deps)).cards[0].meta.floor.includes('estimated'))
  const start = performance.now()
  await Promise.all(Array.from({ length: 100 }, async () => {
    for (const q of ['Does this work offline?', 'GPS not working', 'how to get directions', 'canteen opening hours', 'are routes wheelchair accessible']) {
      const answer = await runTurn(q, {}, deps)
      assert.equal(answer.newState.lastIntent, 'faq')
      assert.ok(answer.replyText.length > 40)
    }
  }))
  assert.equal(requests, 0, 'Local chat made a network request')
  const elapsed = performance.now() - start
  const data = await vite.ssrLoadModule('/src/data/dataClient.js')
  const status = await vite.ssrLoadModule('/src/offline/offlineBundle.js')
  status.setNavigationStatus({ online: false })
  const today = new Date().toISOString().slice(0, 10)
  const venue = locations.find(l => l.id === 'main-canteen')
  data._state().schedule = { data: [{ id: 'fixture-event', name: 'Fixture Event', date: today,
    start_time: '09:00', end_time: '17:00', location: venue, location_id: venue.id }], fetchedAt: Date.now(), meta: {}, version: 1 }
  data._state().menus = { data: { [venue.id]: { [today]: { image_url: 'https://static.invalid/menu.webp' } } },
    fetchedAt: Date.now(), meta: { date_from: today, date_to: today }, version: 1 }
  const events = await runTurn('fest schedule', {}, deps)
  assert.equal(events.cards[0].id, 'fixture-event')
  assert.match(events.replyText, /Using saved data/)
  const menus = await runTurn('show main canteen menu', {}, deps)
  assert.equal(menus.cards[0].menuImageUrl, 'https://static.invalid/menu.webp')
  assert.match(menus.replyText, /Using saved data/)
  assert.equal(requests, 0, 'Cached event/menu answers must not require a chat endpoint or live API')
  delete data._state().schedule
  await assert.rejects(runTurn('fest schedule', {}, deps), /No internet/, 'Missing data must not be presented as an empty schedule')
  console.log(`PASS: ${questions.length} classifier/entity parity cases; compact rooms; library/follow-up/cancel actions; cached offline event/menu cards and missing-data errors; 500 concurrent FAQ turns without network (${elapsed.toFixed(1)}ms desktop).`)
} finally { globalThis.fetch = originalFetch; await vite.close() }
