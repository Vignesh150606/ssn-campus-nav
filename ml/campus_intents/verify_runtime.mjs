import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadModel, predict, featureCounts } from './phone-test/runtime.mjs'
const folder = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'model.json')))
const file = fs.readFileSync(path.join(folder, 'weights.bin'))
const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
const model = await loadModel(manifest, buffer)
const cases = JSON.parse(fs.readFileSync(path.join(folder, 'conformance.json')))
let maxDifference = 0
for (const sample of cases) {
  assert.deepEqual(Object.fromEntries(featureCounts(sample.text)), sample.counts, `Feature mismatch: ${sample.text}`)
  const result = predict(model, sample.text)
  for (let i = 0; i < result.probabilities.length; i++) maxDifference = Math.max(maxDifference, Math.abs(result.probabilities[i] - sample.probabilities[i]))
}
assert(maxDifference < 1e-5, `Python/JS probability difference ${maxDifference}`)
assert.equal(predict(model, '').accepted, false)
const damaged = buffer.slice(0)
new Uint8Array(damaged)[10] ^= 1
await assert.rejects(loadModel(manifest, damaged), /SHA-256/)
await assert.rejects(loadModel(manifest, buffer.slice(4)), /weight size/)
await assert.rejects(loadModel({ ...manifest, hidden: 1024 }, buffer), /contract/)
await assert.rejects(loadModel({ ...manifest, decision: { enabled: true, confidence: NaN, margin: 0 } }, buffer), /policy/)
console.log(`PASS: ${cases.length} Python/JavaScript feature and inference cases (max delta ${maxDifference}); empty input, corrupt weights, size/contract/policy rejection`)
