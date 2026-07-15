/**
 * analyticsClient.js — anonymized product analytics.
 *
 * Phase X (Feature 2 — Navigation Analytics).
 *
 * - `session_id` is random, minted fresh per app open (sessionStorage —
 *   cleared when the tab closes, never persisted across visits, never
 *   tied to identity). It exists only so a burst of events from one visit
 *   can be grouped together server-side.
 * - Events are queued in memory and flushed in small batches
 *   (POST /api/analytics/events) rather than one request per event.
 * - Offline: a failed flush is persisted to IndexedDB (../offline/db.js)
 *   instead of dropped, then resent once connectivity returns.
 * - A tab closing/hiding does one last best-effort send via
 *   navigator.sendBeacon, which (unlike fetch) doesn't need the page to
 *   stay alive to complete.
 *
 * Every call site treats `track()` as fire-and-forget — it never throws
 * and never awaits network I/O, so it can never block or fail the user
 * action that triggered it.
 */
import { idbAdd, idbGetAllEntries, idbDeleteKeys, STORE_ANALYTICS_QUEUE } from '../offline/db'
import { API_BASE } from '../apiBase'

const SESSION_KEY = 'ssn_analytics_session_v1'
const FLUSH_INTERVAL_MS = 8000
const MAX_BATCH = 40

function sessionId() {
  try {
    let id = sessionStorage.getItem(SESSION_KEY)
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
      sessionStorage.setItem(SESSION_KEY, id)
    }
    return id
  } catch {
    return null // private-mode sessionStorage — events still send, just ungrouped
  }
}

let queue = []
let flushTimer = null

function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, FLUSH_INTERVAL_MS)
}

/** Record one anonymized event. */
export function track(eventType, payload = {}) {
  queue.push({ event_type: eventType, payload })
  if (queue.length >= MAX_BATCH) flush()
  else scheduleFlush()
}

async function sendBatch(events) {
  if (!events.length) return true
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  try {
    const res = await fetch(`${API_BASE}/api/analytics/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId(), events }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Flush the in-memory queue. On failure, persist to IndexedDB rather than
 *  drop the events — flushQueuedOffline() resends them on reconnect. */
export async function flush() {
  if (!queue.length) return
  const batch = queue
  queue = []
  const ok = await sendBatch(batch)
  if (!ok) {
    for (const e of batch) idbAdd(STORE_ANALYTICS_QUEUE, e).catch(() => {})
  }
}

/** Called on reconnect (see offlineBundle.js's 'online' handling, wired up
 *  in main.jsx) — resends anything queued to IndexedDB while offline, in
 *  small batches so one large backlog can't become one huge request. */
export async function flushQueuedOffline() {
  let entries
  try {
    entries = await idbGetAllEntries(STORE_ANALYTICS_QUEUE)
  } catch {
    return
  }
  const { keys, values } = entries
  for (let i = 0; i < values.length; i += MAX_BATCH) {
    const batchKeys = keys.slice(i, i + MAX_BATCH)
    const batchValues = values.slice(i, i + MAX_BATCH)
    const ok = await sendBatch(batchValues)
    if (!ok) break // still unreachable — stop, the next reconnect will retry the rest
    await idbDeleteKeys(STORE_ANALYTICS_QUEUE, batchKeys).catch(() => {})
  }
}

// Best-effort last flush when the tab is hidden/closed — sendBeacon
// doesn't need the page to stay alive, unlike a normal fetch.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' || !queue.length) return
    const body = JSON.stringify({ session_id: sessionId(), events: queue })
    queue = []
    if (navigator.sendBeacon) {
      navigator.sendBeacon(`${API_BASE}/api/analytics/events`, new Blob([body], { type: 'application/json' }))
    }
  })
}
