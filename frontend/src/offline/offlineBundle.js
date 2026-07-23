/**
 * offlineBundle.js — reactive online/offline status for the header badge
 * (OfflineIndicator.jsx via useOnlineStatus.js).
 *
 * Production audit Part 10 (code quality / dead code): this file used to
 * be much larger — an "Offline-First Experience" that cached the whole
 * campus graph/locations/road-segments bundle in IndexedDB for offline
 * navigation continuity. That feature's other half (the fallback logic in
 * api.js that would have read the cache) was removed at some point — see
 * api.js's own comment — leaving fetchAndCacheBundle/getCachedBundle/
 * initOfflineSync/bundleLocationsById/searchLocationsOffline/
 * cachedEventsOffline/hasCachedBundleSync all unreachable from anywhere
 * in the app. Confirmed via a full grep across frontend/src before
 * removing them, same standard as every other dead-code removal in this
 * project's history.
 *
 * Removing initOfflineSync surfaced a real, separate bug while auditing
 * it, now fixed here: it was the ONLY code that registered the browser's
 * `online`/`offline` event listeners, and it was never called from
 * anywhere — so the status below only ever reflected navigator.onLine at
 * the moment this module first loaded, and silently never updated again
 * for the rest of the session. The listeners are now registered directly
 * below instead of inside a function nothing calls.
 */

const META_KEY = 'ssn_offline_meta_v1'

function readMeta() {
  try {
    const raw = localStorage.getItem(META_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

const listeners = new Set()
let status = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  hasCache: !!readMeta(),
  lastSyncedAt: readMeta()?.cachedAt ?? null,
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

// The actual bug fix: register these unconditionally at module load
// (this module is only ever imported by useOnlineStatus.js, which every
// page mounts via OfflineIndicator, so "module loads" and "app starts"
// happen together) instead of inside a dead function.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => setStatus({ online: true }))
  window.addEventListener('offline', () => setStatus({ online: false }))
}
