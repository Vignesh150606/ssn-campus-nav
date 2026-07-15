/**
 * offlineBundle.js — caches everything needed for offline navigation
 * continuity (campus graph, locations, road-segment state) and reuses the
 * events cache EventsList.jsx / BootGate.jsx already maintain in
 * localStorage rather than storing that same data a second time.
 *
 * Phase X (Feature 1 — Offline-First Experience).
 *
 * Storage:
 *  - IndexedDB (`bundle` store, single key) — locations / graph /
 *    road_segments / version. One consolidated key, not one per field, so
 *    there's nothing to individually invalidate: every refresh simply
 *    overwrites the whole thing.
 *  - localStorage (`ssn_offline_meta_v1`) — just {version, cachedAt}, so
 *    BootGate.jsx can synchronously answer "has this device cached campus
 *    data before?" without waiting on an async IndexedDB read while
 *    deciding whether to gate the whole app behind a live health check.
 *
 * Cache invalidation: the backend's version stamp changes whenever the
 * walkway graph file changes (see data_access.get_offline_bundle_version).
 * Every fetch compares versions and simply overwrites the cache on a
 * mismatch — no separate "is this stale?" bookkeeping needed.
 */
import { idbGet, idbSet } from './db'
import { API_BASE } from '../apiBase'

const META_KEY = 'ssn_offline_meta_v1'
const BUNDLE_STORE_KEY = 'bundle'

let memoryBundle = null // in-memory copy once loaded, so api.js doesn't hit IndexedDB on every call
let memoryBundlePromise = null

// ── Reactive status (consumed by useOnlineStatus.js / OfflineIndicator) ────
const listeners = new Set()
function readMeta() {
  try {
    const raw = localStorage.getItem(META_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}
let status = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  hasCache: !!readMeta(),
  lastSyncedAt: readMeta()?.cachedAt ?? null,
  syncing: false,
}
function setStatus(patch) {
  status = { ...status, ...patch }
  listeners.forEach((fn) => fn(status))
}
export function subscribeOfflineStatus(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function getOfflineStatus() {
  return status
}

/** Synchronous — used by BootGate.jsx to decide whether it's safe to skip
 *  the live health-check gate while offline ("the user has already opened
 *  the campus once", straight from the Feature 1 brief). */
export function hasCachedBundleSync() {
  return !!readMeta()
}

function writeMeta(version) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify({ version, cachedAt: Date.now() }))
  } catch {
    /* storage quota / private mode — the IndexedDB write below still succeeded */
  }
}

/** Fetch the offline bundle from the network and cache it. Never throws —
 *  callers (init on startup, refresh on reconnect) are all best-effort. */
export async function fetchAndCacheBundle() {
  setStatus({ syncing: true })
  try {
    const res = await fetch(`${API_BASE}/api/offline/bundle`)
    if (!res.ok) throw new Error(`bundle fetch failed: ${res.status}`)
    const bundle = await res.json()
    await idbSet('bundle', BUNDLE_STORE_KEY, bundle)
    writeMeta(bundle.version)
    memoryBundle = bundle
    setStatus({ syncing: false, hasCache: true, lastSyncedAt: Date.now() })
    return bundle
  } catch {
    setStatus({ syncing: false })
    return null
  }
}

/** Resolves to the cached bundle (memory -> IndexedDB), or null if nothing
 *  has ever been cached on this device. Used by api.js's offline fallbacks. */
export async function getCachedBundle() {
  if (memoryBundle) return memoryBundle
  if (memoryBundlePromise) return memoryBundlePromise
  memoryBundlePromise = idbGet('bundle', BUNDLE_STORE_KEY)
    .then((b) => {
      memoryBundle = b || null
      return memoryBundle
    })
    .catch(() => null)
    .finally(() => {
      memoryBundlePromise = null
    })
  return memoryBundlePromise
}

/** App startup — call once. If online, warms/refreshes the cache in the
 *  background (non-blocking). Registers listeners so reconnecting
 *  automatically refreshes events/locations/metadata without interrupting
 *  anything already on screen — every consumer re-reads the bundle lazily
 *  on its own next call, nothing here pushes state into React directly. */
export function initOfflineSync() {
  if (typeof window === 'undefined') return
  if (navigator.onLine) fetchAndCacheBundle()
  window.addEventListener('online', () => {
    setStatus({ online: true })
    fetchAndCacheBundle()
  })
  window.addEventListener('offline', () => setStatus({ online: false }))
}

// ── Small read helpers used by api.js's offline fallbacks ──────────────────

export function bundleLocationsById(bundle) {
  return new Map((bundle?.locations || []).map((l) => [l.id, l]))
}

/** Mirrors the backend's case-insensitive substring match across
 *  name/department/category (data_access.search_locations). */
export function searchLocationsOffline(bundle, q) {
  const needle = (q || '').trim().toLowerCase()
  if (!needle) return []
  return (bundle?.locations || []).filter((l) =>
    [l.name, l.department, l.category].some((f) => (f || '').toLowerCase().includes(needle))
  )
}

// Reuses EventsList.jsx / BootGate.jsx's existing localStorage events cache
// instead of caching the same data a second time inside the IndexedDB
// bundle — see that cache's own comment in EventsList.jsx for its format.
const EVENTS_CACHE_KEY = 'ssn_campus_events_v1'
export function cachedEventsOffline() {
  try {
    const raw = localStorage.getItem(EVENTS_CACHE_KEY)
    if (!raw) return []
    const { data } = JSON.parse(raw)
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}
