/**
 * db.js — minimal promise-based IndexedDB wrapper.
 *
 * One small database (`ssn-campus-offline`) with two stores:
 *   - `analytics-queue` auto-incrementing — analytics events captured while
 *                        offline, flushed once connectivity returns (see
 *                        ../analytics/analyticsClient.js).
 *   - `bundle-cache`    explicit-key (locations / events / road-segments /
 *                        graph) — the last successful response for each,
 *                        refreshed opportunistically whenever the real
 *                        network call succeeds. Re-added for Task 1
 *                        (offline support): a previous "Offline-First
 *                        Experience" used to keep a version of this same
 *                        idea (see git history / PRODUCTION_AUDIT_REPORT.md
 *                        §10.1) but was removed as dead code because its
 *                        only caller (api.js's fallback logic) had already
 *                        been removed first — the store itself was never
 *                        the problem. See offlineBundle.js and api.js for
 *                        the read/write side of this.
 *
 * No dependency is added for this (avoids the bundle-size cost of a
 * wrapper library like idb) — IndexedDB's callback API is small enough to
 * wrap directly in ~100 lines.
 */

const DB_NAME = 'ssn-campus-offline'
const DB_VERSION = 3
const LEGACY_STORE_BUNDLE = 'bundle'
export const STORE_ANALYTICS_QUEUE = 'analytics-queue'
export const STORE_BUNDLE_CACHE = 'bundle-cache'

let dbPromise = null

function openDB() {
  if (dbPromise) return dbPromise
  if (typeof indexedDB === 'undefined') {
    // Private-browsing / very old browser — callers treat a rejected
    // promise as "offline caching unavailable", not a hard failure.
    return Promise.reject(new Error('IndexedDB is not available in this browser.'))
  }
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      // The old store this same name/version once held had a different
      // shape (see the file header) — drop it rather than reuse it, so a
      // device that visited before this was removed/re-added never trips
      // over a stale schema.
      if (db.objectStoreNames.contains(LEGACY_STORE_BUNDLE)) {
        db.deleteObjectStore(LEGACY_STORE_BUNDLE)
      }
      if (!db.objectStoreNames.contains(STORE_ANALYTICS_QUEUE)) {
        db.createObjectStore(STORE_ANALYTICS_QUEUE, { autoIncrement: true })
      }
      // Explicit (out-of-line) keys — one row per resource name
      // ('locations' / 'events' / 'road-segments' / 'graph'), not
      // auto-incrementing like the queue above.
      if (!db.objectStoreNames.contains(STORE_BUNDLE_CACHE)) {
        db.createObjectStore(STORE_BUNDLE_CACHE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }).catch((err) => {
    // Item 19 — previously a failed open cached this rejected promise in
    // dbPromise forever: every future call returned the same permanent
    // failure with no way to recover, even from a transient error (a
    // momentary storage-quota hiccup, private-browsing mode toggling
    // mid-session, etc). Clearing dbPromise back to null lets the NEXT
    // call retry a fresh indexedDB.open() instead of being stuck replaying
    // one failure for the rest of the page's life.
    dbPromise = null
    throw err
  })
  return dbPromise
}

function tx(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName))
}

export async function idbAdd(storeName, value) {
  const store = await tx(storeName, 'readwrite')
  return new Promise((resolve, reject) => {
    const req = store.add(value)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function idbGetAllEntries(storeName) {
  const store = await tx(storeName, 'readonly')
  return new Promise((resolve, reject) => {
    const keys = []
    const values = []
    const keyReq = store.openCursor()
    keyReq.onsuccess = () => {
      const cursor = keyReq.result
      if (cursor) {
        keys.push(cursor.primaryKey)
        values.push(cursor.value)
        cursor.continue()
      } else {
        resolve({ keys, values })
      }
    }
    keyReq.onerror = () => reject(keyReq.error)
  })
}

export async function idbClear(storeName) {
  const store = await tx(storeName, 'readwrite')
  return new Promise((resolve, reject) => {
    const req = store.clear()
    req.onsuccess = () => resolve(true)
    req.onerror = () => reject(req.error)
  })
}

/** Explicit-key write — used by STORE_BUNDLE_CACHE (one row per resource
 *  name), unlike idbAdd's auto-incrementing keys for the analytics queue. */
export async function idbPut(storeName, key, value) {
  const store = await tx(storeName, 'readwrite')
  return new Promise((resolve, reject) => {
    const req = store.put(value, key)
    req.onsuccess = () => resolve(true)
    req.onerror = () => reject(req.error)
  })
}

/** Explicit-key read — resolves `undefined` for a missing key (a cache
 *  miss), same as a plain Map, rather than rejecting. */
export async function idbGet(storeName, key) {
  const store = await tx(storeName, 'readonly')
  return new Promise((resolve, reject) => {
    const req = store.get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function idbDeleteKeys(storeName, keys) {
  const store = await tx(storeName, 'readwrite')
  await Promise.all(
    keys.map(
      (k) =>
        new Promise((resolve, reject) => {
          const req = store.delete(k)
          req.onsuccess = () => resolve(true)
          req.onerror = () => reject(req.error)
        })
    )
  )
  return true
}
