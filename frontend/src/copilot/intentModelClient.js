/** One lazy Worker while chat is open. Preview inference never delays answers,
 * stores conversations, or falls back to a remote service on failure. */
import { normalize } from './model/runtime.mjs'

let worker = null, ready = null, sequence = 0, users = 0, evaluations = 0
let status = { state: 'idle', mode: 'evaluation', lastPrediction: null }
const pending = new Map()
const MAX_PENDING = 8

export function getIntentModelStatus() { return structuredClone(status) }

function stop(state = 'idle') {
  worker?.terminate()
  worker = null
  ready = null
  for (const request of pending.values()) {
    clearTimeout(request.timer)
    request.resolve(null)
  }
  pending.clear()
  status = { state, mode: 'evaluation', lastPrediction: null }
}

export function retainIntentModel() {
  users++
  let released = false
  return () => {
    if (released) return
    released = true
    if (--users === 0) stop()
  }
}

function request(type, payload, timeoutMs) {
  if (!worker || pending.size >= MAX_PENDING) return Promise.resolve(null)
  return new Promise(resolve => {
    const id = ++sequence
    const timer = setTimeout(() => stop('unavailable'), timeoutMs)
    pending.set(id, { resolve, timer })
    try { worker.postMessage({ id, type, ...payload }) }
    catch { stop('unavailable') }
  })
}

function initialize() {
  if (ready) return ready
  if (typeof Worker === 'undefined' || status.state === 'unavailable' || users === 0) return Promise.resolve(false)
  try {
    const instance = new Worker(new URL('./intentModel.worker.js', import.meta.url), { type: 'module' })
    worker = instance
    status = { state: 'loading', mode: 'evaluation', lastPrediction: null }
    instance.onmessage = ({ data }) => {
      if (worker !== instance) return
      const entry = pending.get(data.id)
      if (!entry) return
      if (data.type === 'unavailable') { stop('unavailable'); return }
      clearTimeout(entry.timer)
      pending.delete(data.id)
      entry.resolve(data)
    }
    instance.onerror = () => { if (worker === instance) stop('unavailable') }
    instance.onmessageerror = instance.onerror
    ready = request('init', {}, 16000).then(response => {
      if (worker !== instance || !response) return false
      status = { state: 'ready', mode: 'evaluation', modelId: response.modelId,
        labels: response.labels, bytes: response.bytes, lastPrediction: null }
      return true
    })
    return ready
  } catch { stop('unavailable'); return Promise.resolve(false) }
}

export async function predictWithIntentModel(text) {
  if (typeof text !== 'string' || !text.trim() || evaluations >= MAX_PENDING) return null
  evaluations++
  try {
    // Bound both cold-start waiters and normalized Worker inputs.
    const input = normalize(text)
    if (!input || !await initialize()) return null
    const instance = worker
    const response = await request('predict', { text: input }, 5000)
    if (worker !== instance || !response) return null
    const result = response.result
    // Keep a single diagnostic prediction, never the question or conversation.
    status = { ...status, lastPrediction: { label: result.label, confidence: result.confidence,
      margin: result.margin, accepted: false, ms: response.ms } }
    return status.lastPrediction
  } finally { evaluations-- }
}
