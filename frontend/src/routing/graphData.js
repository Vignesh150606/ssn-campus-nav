/** IndexedDB is authoritative across sessions; baked JSON is bootstrap only. */
import { API_BASE } from '../apiBase'
import { idbGet, idbPut, STORE_BUNDLE_CACHE } from '../offline/db'
import { reportBackendReachability, setNavigationStatus } from '../offline/offlineBundle'
import { validateGraph, graphHash } from './validateGraph'

let record = null, loading = null, syncing = null, bootstrapSyncing = null
let destinations = []
const bundledVersion = import.meta.env.CAMPUS_GRAPH_VERSION

export function currentGraph() {
  if (!record) throw new Error('Campus map is not downloaded. Connect once to prepare offline navigation.')
  return record.data
}
export function graphMetadata() {
  return record && { hash: record.hash, version: record.version, cachedAt: record.cachedAt, checkedAt: record.checkedAt }
}

async function readJSON(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-cache' })
    if (!response.ok) throw new Error(`Campus map download failed (${response.status})`)
    const text = await response.text()
    if (text.length > 5_000_000) throw new Error('Campus map is too large')
    return JSON.parse(text)
  } finally { clearTimeout(timer) }
}

async function accept(data, source, checkedAt = 0, bootstrapVersion = record?.bootstrapVersion) {
  const graph = validateGraph(data, destinations, record?.data.nodes.map(n => n.id) || [])
  const hash = await graphHash(graph)
  if (record?.hash === hash) {
    record = { ...record, bootstrapVersion, checkedAt: checkedAt || record.checkedAt }
    await idbPut(STORE_BUNDLE_CACHE, 'graph', record).catch(() => {})
    return record.data
  }
  const next = { data: graph, hash, version: hash, bootstrapVersion, cachedAt: Date.now(), checkedAt, source, schema: 1 }
  const previous = record
  setNavigationStatus({ updateAvailable: !!previous })
  try {
    // Commit graph and its hash in ONE transaction before replacing memory.
    await idbPut(STORE_BUNDLE_CACHE, 'graph', next)
    record = next
    setNavigationStatus({ graphAvailable: true, graphUpdated: !!previous, updateAvailable: false, storageError: null, lastSyncedAt: checkedAt || next.cachedAt })
  } catch {
    setNavigationStatus({ updateAvailable: false, storageError: 'Offline storage is unavailable. Close older app tabs or free device storage before reopening offline.' })
    if (previous) return previous.data
    record = next // first visit still works, without claiming persistence
    setNavigationStatus({ graphAvailable: true })
  }
  return record.data
}

export function loadGraph(locations = []) {
  if (locations.length) destinations = locations
  if (record) {
    validateGraph(record.data, destinations)
    return Promise.resolve(record.data)
  }
  if (loading) return loading
  loading = (async () => {
    try {
      const cached = await idbGet(STORE_BUNDLE_CACHE, 'graph')
      if (cached) {
        const graph = validateGraph(cached.data, destinations)
        const hash = await graphHash(graph)
        if (cached.hash && cached.hash !== hash) throw new Error('Cached campus map is corrupt')
        record = { ...cached, data: graph, hash, version: hash }
        setNavigationStatus({ graphAvailable: true, lastSyncedAt: cached.checkedAt || cached.cachedAt })
        if (!cached.hash) await idbPut(STORE_BUNDLE_CACHE, 'graph', record)
        return graph
      }
    } catch { /* Keep invalid cache until a validated replacement exists. */ }
    try {
      const data = await readJSON('/data/graph.json')
      if (bundledVersion && await graphHash(data) !== bundledVersion) throw new Error('Campus map does not match this app deployment')
      return await accept(data, 'bootstrap', 0, bundledVersion)
    }
    catch { throw new Error('No valid campus map is stored on this device. Connect to download campus data, then retry.') }
  })().finally(() => { loading = null })
  return loading
}

export function syncGraph() {
  if (syncing) return syncing
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(false)
  syncing = (async () => {
    let data
    try {
      data = await readJSON(`${API_BASE}/api/graph`)
      reportBackendReachability(true)
    } catch { reportBackendReachability(false); return false }
    try { await accept(data, 'backend', Date.now()); return true }
    catch { return false } // reachable server can still send an invalid graph
  })().finally(() => { syncing = null })
  return syncing
}

export function startGraphSync() {
  // Static graph updates ship with the app. A cached graph renders immediately;
  // only a new bundled graph version needs a same-origin download/validation.
  // Explicit syncGraph() remains available, but normal visits never poll Render.
  if (bundledVersion && record?.bootstrapVersion !== bundledVersion && !bootstrapSyncing) {
    // Shared repository work, independent of any mounted screen. Strict Mode
    // remounts reuse the download rather than starting another request.
    bootstrapSyncing = readJSON('/data/graph.json').then(async data => {
      if (await graphHash(data) !== bundledVersion) return
      await accept(data, 'bootstrap', 0, bundledVersion)
    }).catch(() => { /* Keep the known-good graph; retry on the next app open. */ })
      .finally(() => { bootstrapSyncing = null })
  }
  return () => {} // no timers or event listeners to remove
}
