import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { loadModel, predict } from '../src/copilot/model/runtime.mjs'
import { modelSuggestedQueries } from '../src/copilot/modelSuggestions.js'

const manifest = JSON.parse(fs.readFileSync(new URL('../src/copilot/model/model.json', import.meta.url)))
const bytes = fs.readFileSync(new URL('../src/copilot/model/weights.bin', import.meta.url))
const model = await loadModel(manifest, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/campus-model-conformance.json', import.meta.url)))
const locations = JSON.parse(fs.readFileSync(new URL('../public/data/locations.json', import.meta.url)))
const vite = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, envDir: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  define: { 'import.meta.env.VITE_API_BASE': JSON.stringify('https://api.invalid') },
  server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
const originalFetch = globalThis.fetch
try {
  let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error('Network forbidden') }
  const { classifyEnglish } = await vite.ssrLoadModule('/src/copilot/englishConversation.js')
  const { runTurn } = await vite.ssrLoadModule('/src/copilot/copilotEngine.js')
  const state = { lastLocationId: 'cse-block', lastCandidates: [{ kind: 'location', id: 'cse-block' }] }
  assert.deepEqual(modelSuggestedQueries({ label: 'unknown', confidence: 1, top: [] }, state), [])
  assert.deepEqual(modelSuggestedQueries({ label: 'out_of_scope', confidence: 1, top: [] }, state), [])
  assert.deepEqual(modelSuggestedQueries({ label: 'need.restroom', confidence: 0.2, top: [{ label: 'need.restroom', score: 0.2 }] }, state), [])
  for (const label of ['follow_up_cancel_nav', 'follow_up_navigate', 'follow_up_preview', 'building_finder', 'distance_query', 'classroom_finder']) {
    assert.deepEqual(modelSuggestedQueries({ label, confidence: 0.99, top: [{ label, score: 0.99 }] }, state), [], 'Never synthesize a command or a destination')
  }
  const candidates = []
  for (const fixture of fixtures) {
    const baseline = classifyEnglish(fixture.text, locations, state)
    const p = predict(model, fixture.text)
    assert.equal(p.accepted, false, 'Automatic acceptance remains disabled')
    if (['unknown', 'out_of_scope'].includes(baseline.intent) && !baseline.preserve_context) {
      const choices = modelSuggestedQueries(p, state, fixture.text)
      if (choices.length) {
        candidates.push({ question: fixture.text, expected: fixture.label, predicted: p.label, choices })
        for (const choice of choices) {
          const response = await runTurn(choice, state, { locations, position: null }).catch(error => ({ missingData: error.status === 503 }))
          assert.equal(response.action || null, null, `Suggestion must not directly execute navigation: ${choice}`)
        }
      }
    }
  }
  assert.ok(candidates.length > 0, 'Model must assist real unsupported phrasing rather than just run invisibly')
  assert.equal(requests, 0)
  console.log(JSON.stringify({ modelAssistedQuestions: candidates.length,
    matchingTopIntent: candidates.filter(c => c.expected === c.predicted).length,
    examples: candidates.slice(0, 10) }, null, 2))
  console.log('PASS: rejected predictions provide explicit, non-action confirmation choices only; unknown/OOS/low scores and commands are excluded; no network requests.')
} finally { globalThis.fetch = originalFetch; await vite.close() }
