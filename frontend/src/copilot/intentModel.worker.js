// Static, same-origin model only. Uploaded HTML/JavaScript is never executed.
import manifest from './model/model.json'
import weightsUrl from './model/weights.bin?url'
import { loadModel, predict } from './model/runtime.mjs'

let model, loading
async function initialize() {
  if (model) return
  if (!loading) loading = (async () => {
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(weightsUrl, { signal: controller.signal, cache: 'force-cache' })
      if (!response.ok) throw new Error('Local model asset unavailable')
      model = await loadModel(manifest, await response.arrayBuffer())
    } finally { clearTimeout(deadline) }
  })()
  await loading
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      await initialize()
      self.postMessage({ id: data.id, type: 'ready', modelId: manifest.model_id,
        mode: 'confirmation', labels: manifest.labels.length, bytes: manifest.weights.bytes })
    } else if (data.type === 'predict') {
      if (!model || typeof data.text !== 'string') throw new Error('Model is not ready')
      const start = performance.now()
      const result = predict(model, data.text)
      // This integration is explicitly evaluation-only. Never promote a
      // prototype, bypass rejection thresholds or issue actions from a label.
      self.postMessage({ id: data.id, type: 'prediction', result: { ...result, accepted: false }, ms: performance.now() - start })
    }
  } catch {
    // No message text, stack, URLs or credentials in diagnostics.
    self.postMessage({ id: data.id, type: 'unavailable' })
  }
}
