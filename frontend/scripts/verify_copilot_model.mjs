import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { loadModel, predict, featureCounts } from '../src/copilot/model/runtime.mjs'

const runtime = readFileSync(new URL('../src/copilot/model/runtime.mjs', import.meta.url), 'utf8')
assert.equal(runtime, readFileSync(new URL('../../ml/campus_intents/phone-test/runtime.mjs', import.meta.url), 'utf8'), 'Training/browser runtime drift')
const manifest = JSON.parse(readFileSync(new URL('../src/copilot/model/model.json', import.meta.url), 'utf8'))
const bytes = readFileSync(new URL('../src/copilot/model/weights.bin', import.meta.url))
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
const model = await loadModel(manifest, buffer)
assert.equal(manifest.training.prototype, false)
assert.equal(manifest.decision.enabled, false)
assert.equal(manifest.approved_for_production, false)
assert.equal(manifest.labels.length, 39)
assert.equal(manifest.training.missing_labels.length, 0)
const cases = JSON.parse(readFileSync(new URL('./fixtures/campus-model-conformance.json', import.meta.url), 'utf8'))
let delta = 0
for (const sample of cases) {
  assert.deepEqual(Object.fromEntries(featureCounts(sample.text)), sample.counts)
  const prediction = predict(model, sample.text)
  assert.equal(prediction.accepted, false)
  prediction.probabilities.forEach((value, i) => { delta = Math.max(delta, Math.abs(value - sample.probabilities[i])) })
}
assert.ok(delta < 1e-5)
const corrupt = buffer.slice(0)
new Uint8Array(corrupt)[0] ^= 1
await assert.rejects(loadModel(manifest, corrupt), /SHA-256/)

const vite = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, envDir: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
const originals = { Worker: globalThis.Worker, fetch: globalThis.fetch }
const instances = []
let requests = 0, hold = false, fail = false
class FakeWorker {
  constructor() { if (fail) throw new Error('Worker unsupported'); instances.push(this) }
  terminate() { this.terminated = true }
  postMessage(data) {
    if (hold) return
    queueMicrotask(() => {
      if (this.terminated) return
      this.onmessage({ data: data.type === 'init'
        ? { id: data.id, type: 'ready', modelId: manifest.model_id, labels: manifest.labels.length, bytes: bytes.length }
        : { id: data.id, type: 'prediction', result: predict(model, data.text), ms: 1 } })
    })
  }
}
try {
  globalThis.fetch = async () => { requests++; throw new Error('No remote fallback permitted') }
  globalThis.Worker = FakeWorker
  const client = await vite.ssrLoadModule('/src/copilot/intentModelClient.js')
  assert.equal(await client.predictWithIntentModel('hello'), null, 'No work while chat is closed')
  const release = client.retainIntentModel()
  const releaseOther = client.retainIntentModel()
  assert.equal(instances.length, 0, 'Retaining ownership alone must not download the model')
  const results = await Promise.all(Array.from({ length: 20 }, () => client.predictWithIntentModel('hello')))
  assert.equal(instances.length, 1, 'Cold model initialization must coalesce')
  assert.ok(results.filter(Boolean).length <= 8 && results.some(Boolean), 'Bound cold-start waiters')
  const status = client.getIntentModelStatus()
  assert.equal(status.state, 'ready')
  assert.equal(status.lastPrediction.label, predict(model, 'hello').label)
  assert.equal(status.lastPrediction.accepted, false)
  assert.ok(!JSON.stringify(status).includes('hello'), 'Never retain chat text in diagnostics')
  status.lastPrediction.label = 'mutated'
  assert.notEqual(client.getIntentModelStatus().lastPrediction.label, 'mutated')
  release(); release()
  assert.ok(!instances[0].terminated, 'One remaining widget still owns the Worker')
  releaseOther()
  assert.ok(instances[0].terminated)
  assert.equal(client.getIntentModelStatus().lastPrediction, null)

  hold = true
  const cleanup = client.retainIntentModel()
  const pending = client.predictWithIntentModel('library')
  cleanup()
  assert.equal(await pending, null, 'Closing during load resolves pending work')
  hold = false; fail = true
  const cleanupFailure = client.retainIntentModel()
  assert.equal(await client.predictWithIntentModel('hello'), null)
  assert.equal(client.getIntentModelStatus().state, 'unavailable')
  const { classifyOnDevice } = await vite.ssrLoadModule('/src/copilot/onDeviceClassifier.js')
  assert.equal((await classifyOnDevice('hello', [])).intent, 'greeting', 'Worker failure must preserve local replies')
  cleanupFailure()
  assert.equal(requests, 0)
  console.log(`PASS: ${cases.length} Python-JS vectors (delta ${delta}); hash rejection; lazy/coalesced/bounded Worker, cleanup, no chat text storage, disabled model acceptance and local-only failure handling.`)
} finally {
  if (originals.Worker === undefined) delete globalThis.Worker
  else globalThis.Worker = originals.Worker
  globalThis.fetch = originals.fetch
  await vite.close()
}
