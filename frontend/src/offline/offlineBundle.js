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
let status = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  hasCache: false,
  lastSyncedAt: null,
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
