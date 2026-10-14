import { loadModel, predict } from './runtime.mjs'
let model
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      const started = performance.now()
      model = await loadModel(data.manifest, data.buffer)
      self.postMessage({ type: 'loaded', ms: performance.now() - started, id: model.manifest.model_id,
        enabled: model.manifest.decision.enabled, bytes: data.buffer.byteLength })
    } else if (data.type === 'predict') {
      if (!model) throw Error('Load a model first')
      const started = performance.now(), result = predict(model, data.text)
      self.postMessage({ type: 'prediction', result, ms: performance.now() - started })
    } else if (data.type === 'benchmark') {
      if (!model) throw Error('Load a model first')
      const samples = []
      for (let i = 0; i < 10; i++) predict(model, data.text)
      for (let i = 0; i < 100; i++) { const start = performance.now(); predict(model, data.text); samples.push(performance.now() - start) }
      samples.sort((a, b) => a - b)
      self.postMessage({ type: 'benchmark', p50: samples[49], p95: samples[94], max: samples[99] })
    }
  } catch (error) { self.postMessage({ type: 'error', message: error.message }) }
}
