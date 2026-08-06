/**
 * offlineBundle.js — reactive online/offline status for the header badge
 * (OfflineIndicator.jsx via useOnlineStatus.js), plus the actual offline
 * data cache (Task 1 — offline support) that api.js reads from/writes to.
 *
 * Production audit Part 10 (code quality / dead code) had previously
 * trimmed this file down after an earlier "Offline-First Experience" was
 * found to be unreachable (its only caller in api.js had been removed
 * first — see PRODUCTION_AUDIT_REPORT.md §10.1). That earlier removal was
 * the right call at the time: half-built, disconnected code is worse than
 * no code. This re-adds the same idea properly wired end to end: every
 * successful getLocations/getEvents/getRoadSegments/getGraph call in
 * api.js now also writes its result here via cacheBundleResource, and
 * api.js reads it back via getCachedBundleResource whenever the real
 * network call fails — see api.js for the actual fallback logic; this
 * file only owns the storage + status side of it, same division as
 * before.
 *
 * Removing the old dead code separately surfaced a real bug, fixed here
 * and left as-is: this module used to be the ONLY code that registered
 * the browser's `online`/`offline` event listeners, and it was never
 * called from anywhere — so `status` only ever reflected navigator.onLine
 * at the moment this module first loaded, and silently never updated
 * again for the rest of the session. The listeners are registered
 * directly at module load below instead of inside a function nothing
 * calls.
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

// ── Offline data cache (Task 1) ─────────────────────────────────────────
//
// One row per resource name in STORE_BUNDLE_CACHE — 'locations', 'events',
// 'road-segments', 'graph'. api.js is the only caller of either function
// below; this module just owns the storage + the reactive `hasCache`/
// `lastSyncedAt` status so OfflineIndicator.jsx doesn't need to know
// anything changed.
export async function cacheBundleResource(key, data) {
  try {
    await idbPut(STORE_BUNDLE_CACHE, key, { data, cachedAt: Date.now() })
    setStatus({ hasCache: true, lastSyncedAt: Date.now() })
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

// On module load (app start), check whether a previous session already
// cached anything, so a device that opens this app OFFLINE from a cold
// start still shows "Offline" (has cache) rather than "Offline — limited"
// for data it actually already has. 'locations' is used as the presence
// check since api.js always caches it first, before graph/road-segments.
if (typeof indexedDB !== 'undefined') {
  getCachedBundleResource('locations').then((cached) => {
    if (cached) setStatus({ hasCache: true })
  })
}
