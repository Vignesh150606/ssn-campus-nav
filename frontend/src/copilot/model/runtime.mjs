// Pure CPU inference. No imports, external APIs, or navigation actions.
export function normalize(text) {
  return Array.from(String(text).normalize('NFKC').toLowerCase()
    .replace(/[?!.,;:'"]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 200).join('')
}
const encoder = new TextEncoder()
export function hash32(text) {
  let hash = 2166136261
  for (const byte of encoder.encode(text)) hash = Math.imul(hash ^ byte, 16777619) >>> 0
  return hash
}
export function featureCounts(text) {
  text = normalize(text)
  const counts = new Map()
  if (!text) return counts
  const add = part => { const index = hash32(part) % 2048; counts.set(index, (counts.get(index) || 0) + 1) }
  const chars = Array.from(` ${text} `)
  for (let n = 3; n <= 5; n++) for (let i = 0; i <= chars.length - n; i++) add(`c:${chars.slice(i, i + n).join('')}`)
  const words = text.split(' ')
  for (const word of words) add(`w:${word}`)
  for (let i = 0; i < words.length - 1; i++) add(`b:${words[i]} ${words[i + 1]}`)
  return counts
}
function features(text) {
  const x = new Float32Array(2048)
  let squared = 0
  for (const [index, count] of featureCounts(text)) { x[index] = Math.log1p(count); squared += x[index] ** 2 }
  const norm = Math.sqrt(squared) || 1
  for (let i = 0; i < x.length; i++) x[i] /= norm
  return x
}
export async function loadModel(manifest, buffer) {
  if (manifest.schema !== 1 || manifest.hidden !== 64 || manifest.features?.bins !== 2048
    || manifest.features?.min_n !== 3 || manifest.features?.max_n !== 5 || manifest.features?.max_chars !== 200
    || manifest.features?.hash !== 'fnv1a32-utf8'
    || manifest.features?.normalization !== 'nfkc-lower-punctuation-whitespace-v1') throw Error('Unsupported model contract')
  const labels = manifest.labels
  if (!Array.isArray(labels) || labels.length < 2 || labels.length > 128
    || !labels.every(l => typeof l === 'string') || new Set(labels).size !== labels.length) throw Error('Invalid labels')
  const expected = (2048 * 64 + 64 + 64 * labels.length + labels.length) * 4
  if (buffer.byteLength !== expected || buffer.byteLength > 1_000_000 || manifest.weights?.bytes !== expected) throw Error('Invalid weight size')
  if (!globalThis.crypto?.subtle) throw Error('Serve this test over HTTPS or localhost to verify model integrity')
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const sha = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  if (sha !== manifest.weights.sha256) throw Error('Weight SHA-256 mismatch')
  const view = new DataView(buffer), values = new Float32Array(expected / 4)
  for (let i = 0; i < values.length; i++) {
    values[i] = view.getFloat32(i * 4, true)
    if (!Number.isFinite(values[i])) throw Error('Non-finite weights')
  }
  const policy = manifest.decision
  if (!policy || typeof policy.enabled !== 'boolean' || !Number.isFinite(policy.confidence)
    || !Number.isFinite(policy.margin) || policy.confidence < 0 || policy.confidence > 1.01
    || policy.margin < 0 || policy.margin > 1.01) throw Error('Invalid decision policy')
  return { manifest, values }
}
export function predict(model, text) {
  const { values, manifest } = model, labels = manifest.labels, count = labels.length
  const x = features(text), hidden = new Float64Array(64), logits = new Float64Array(count)
  const bias1 = 2048 * 64, weight2 = bias1 + 64, bias2 = weight2 + 64 * count
  for (let h = 0; h < 64; h++) {
    let value = values[bias1 + h]
    for (let i = 0; i < x.length; i++) if (x[i]) value += x[i] * values[i * 64 + h]
    hidden[h] = Math.max(0, value)
  }
  for (let c = 0; c < count; c++) {
    let value = values[bias2 + c]
    for (let h = 0; h < 64; h++) value += hidden[h] * values[weight2 + h * count + c]
    logits[c] = value
  }
  const max = Math.max(...logits), probabilities = [...logits].map(v => Math.exp(v - max))
  const total = probabilities.reduce((a, b) => a + b, 0)
  for (let i = 0; i < count; i++) probabilities[i] /= total
  const ranked = labels.map((label, i) => ({ label, score: probabilities[i] })).sort((a, b) => b.score - a.score)
  const confidence = ranked[0].score, margin = confidence - ranked[1].score
  return { label: ranked[0].label, confidence, margin,
    accepted: !!normalize(text) && manifest.decision.enabled && !['unknown', 'out_of_scope'].includes(ranked[0].label)
      && confidence >= manifest.decision.confidence && margin >= manifest.decision.margin,
    top: ranked.slice(0, 3), probabilities }
}
