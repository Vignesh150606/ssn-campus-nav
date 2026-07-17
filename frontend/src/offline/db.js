/**
 * db.js — minimal promise-based IndexedDB wrapper.
 *
 * One small database (`ssn-campus-offline`) with one store:
 *   - `analytics-queue` auto-incrementing — analytics events captured while
 *                        offline, flushed once connectivity returns (see
 *                        ../analytics/analyticsClient.js).
 *
 * The offline-routing bundle store this database used to also hold has
 * been removed (this app no longer caches the walkway graph for offline
 * navigation — see main.jsx / api.js). DB_VERSION is bumped so a returning
 * device with that old store still on disk gets it dropped via
 * onupgradeneeded rather than left as orphaned dead storage.
 *
 * No dependency is added for this (avoids the bundle-size cost of a
 * wrapper library like idb) — IndexedDB's callback API is small enough to
 * wrap directly in ~60 lines.
 */

const DB_NAME = 'ssn-campus-offline'
const DB_VERSION = 2
const LEGACY_STORE_BUNDLE = 'bundle'
export const STORE_ANALYTICS_QUEUE = 'analytics-queue'

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
      if (db.objectStoreNames.contains(LEGACY_STORE_BUNDLE)) {
        db.deleteObjectStore(LEGACY_STORE_BUNDLE)
      }
      if (!db.objectStoreNames.contains(STORE_ANALYTICS_QUEUE)) {
        db.createObjectStore(STORE_ANALYTICS_QUEUE, { autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
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
