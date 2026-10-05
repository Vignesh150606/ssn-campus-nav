/**
 * Show the app as soon as cached, baked or snapshot/live data is usable.
 * Render health checks continue in the background until the backend wakes.
 * With no usable data, retain the checking/slow/failed startup screen.
 */
import { useEffect, useState } from 'react'
import { checkHealth, getGraph, getRoadSegments, getLocations } from '../api'
import { getSchedule, hasCachedBootData } from '../data/dataClient'

const SLOW_MESSAGE_AFTER_MS = 22_000
const GIVE_UP_AFTER_MS = 60_000
const RETRY_INTERVAL_MS = 2_500
const ATTEMPT_TIMEOUT_MS = 8_000

// Mirrors EventsList's cache key/writer so the cache can be warmed here
// without importing that page directly (keeps bundles/cleanly separated).
const EVENTS_CACHE_KEY = 'ssn_campus_events_v1'

function seedEventsCache() {
  // W2: schedule snapshot instead of a direct backend call
  return getSchedule()
    .then((data) => {
      if (!Array.isArray(data)) return
      try {
        localStorage.setItem(EVENTS_CACHE_KEY, JSON.stringify({ data, ts: Date.now() }))
      } catch { /* storage quota — silently ignore */ }
    })
}

export default function BootGate({ children }) {
  const [status, setStatus] = useState('checking') // checking | slow | ready | failed
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    let attemptTimer = null

    // The backend may be asleep while same-origin baked data, public snapshots
    // or a previous device cache are already usable. Health keeps polling in
    // the background; lack of backend health alone must not hide usable data.
    hasCachedBootData().then((available) => {
      if (available && !cancelled) setStatus('ready')
    }).catch(() => {})
    function warmData() {
      for (const load of [getGraph, getLocations, getRoadSegments, seedEventsCache]) {
        load().then(() => { if (!cancelled) setStatus('ready') }).catch(() => {})
      }
    }
    warmData()

    async function attempt() {
      if (cancelled) return
      const ok = await checkHealth(ATTEMPT_TIMEOUT_MS)
      if (cancelled) return
      if (ok) {
        // Health alone is not data. Retry initial reads now that the server
        // is awake, and release the gate only when a dataset resolves.
        warmData()
        return
      }
      attemptTimer = setTimeout(attempt, RETRY_INTERVAL_MS)
    }

    const slowTimer = setTimeout(() => {
      if (!cancelled) setStatus((s) => (s === 'ready' ? s : 'slow'))
    }, SLOW_MESSAGE_AFTER_MS)

    const giveUpTimer = setTimeout(() => {
      if (!cancelled) setStatus((s) => (s === 'ready' ? s : 'failed'))
    }, GIVE_UP_AFTER_MS)

    attempt()

    return () => {
      cancelled = true
      clearTimeout(attemptTimer)
      clearTimeout(slowTimer)
      clearTimeout(giveUpTimer)
    }
  }, [retryKey])

  const effectiveStatus = status

  if (effectiveStatus === 'ready') return children

  const failed = effectiveStatus === 'failed'
  const slow = effectiveStatus === 'slow'

  return (
    <div className="boot-gate" role="status" aria-live="polite">
      {/* Phase 4.2 — SSN branding: real logo replaces the placeholder square.
          Item 21 — alt text + aria-hidden was self-contradictory (one says
          "announce this", the other says "skip this" — aria-hidden wins in
          practice, so the alt text was never actually read by anything).
          Decorative here: the adjacent title text already conveys the app
          identity, so alt="" consistently matches aria-hidden instead of
          fighting it. */}
      <img
        src="/ssn-logo.webp"
        alt=""
        className="boot-gate-logo"
        aria-hidden="true"
      />
      <div className="boot-gate-title">SSN Campus Navigator</div>

      {!failed && (
        <>
          <div className="boot-gate-spinner" aria-hidden="true" />
          <div className="boot-gate-message">
            {slow
              ? 'Still waking the server… Almost there.'
              : 'Waking up the server. This usually takes a few seconds.'}
          </div>
        </>
      )}

      {failed && (
        <>
          <div className="boot-gate-message boot-gate-message-error">
            Couldn't reach the server. Please check your connection and try again.
          </div>
          <button
            type="button"
            className="boot-gate-retry-btn"
            onClick={() => {
              setStatus('checking')
              setRetryKey((k) => k + 1)
            }}
          >
            Retry
          </button>
        </>
      )}
    </div>
  )
}
