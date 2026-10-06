/** Shared cache primitives and observed synchronization status.
 * Navigation readiness is set only after graph/destinations/closures hydrate.
 * navigator.onLine is a hint; graph synchronization records backend reachability.
 */
import { idbGet, idbPut, STORE_BUNDLE_CACHE } from './db'

const META_KEY = 'ssn_offline_meta_v1'

// Item 20 (part 2) — the "Offline-First Experience" that used to write
// this key was removed (see the file comment above), so nothing can ever
// set it again — but a user who visited before that removal still has it
// sitting in their browser's localStorage, permanently reporting
// `hasCache: true` (and a frozen, increasingly stale `lastSyncedAt`) to
// OfflineIndicator.jsx forever. That shows "Offline" (implying full
// offline capability) instead of the correct "Offline — limited" for
// exactly the returning users this was supposed to help. Since no code
// path can ever populate this key again, it's removed once here instead
// of read.
try {
  localStorage.removeItem(META_KEY)
} catch {
  /* localStorage unavailable — nothing to clean up */
}

const listeners = new Set()
let lastNetworkSuccessAt = 0
let status = {
  online: typeof navigator !== 'undefined' && navigator.onLine === false ? false : null,
  backendOnline: null,
  graphAvailable: false,
  graphUpdated: false,
  storageError: null,
  hasCache: false,
  lastSyncedAt: null,
}
function setStatus(patch) {
  status = { ...status, ...patch }
  listeners.forEach((fn) => fn(status))
}

export function setNavigationStatus(patch) { setStatus(patch) }
export function reportPublicReachability() {
  lastNetworkSuccessAt = Date.now()
  setStatus({ online: typeof navigator !== 'undefined' && navigator.onLine === false ? false : true })
}
export function reportBackendReachability(online) {
  if (online) lastNetworkSuccessAt = Date.now()
  const reachable = online || Date.now() - lastNetworkSuccessAt < 60_000
  setStatus({ backendOnline: online, online: typeof navigator !== 'undefined' && navigator.onLine === false ? false : reachable })
}
export function reportSynchronizationFailure() {
  if (Date.now() - lastNetworkSuccessAt >= 60_000) setStatus({ online: false })
}

export function subscribeOfflineStatus(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function getOfflineStatus() {
  return status
}

// Browser events are hints; successful/failed synchronization establishes
// reachability. Reconnecting alone must not claim that internet is usable.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => setStatus({ online: null }))
  window.addEventListener('offline', () => setStatus({ online: false }))
}

// Optional public datasets use best-effort caching. Validated graph writes
// bypass this helper and await an atomic transaction in routing/graphData.js.
export async function cacheBundleResource(key, data) {
  try {
    await idbPut(STORE_BUNDLE_CACHE, key, { data, cachedAt: Date.now() })
    // A menu/event cache alone does not make campus navigation offline-ready.
  } catch {
    // IndexedDB unavailable (private browsing, quota, etc.) — caching is
    // best-effort. The in-memory app still works; only the NEXT offline
    // session loses the benefit, not this one.
  }
}

export async function getCachedBundleResource(key) {
  try {
    const entry = await idbGet(STORE_BUNDLE_CACHE, key)
    return entry ? entry.data : undefined
  } catch {
    return undefined
  }
}
