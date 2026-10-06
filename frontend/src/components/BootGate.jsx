/**
 * Show the app as soon as cached, baked or snapshot/live data is usable.
 * New deployed graph versions load from the app shell after navigation is ready.
 * With no usable data, retain the checking/failed bootstrap screen.
 */
import { useEffect, useState } from 'react'
import { prepareClientRouting } from '../routing/clientRouting'
import { startGraphSync } from '../routing/graphData'
import { getSchedule } from '../data/dataClient'

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
  const [status, setStatus] = useState('checking') // checking | ready | failed
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    let stopSync = null
    prepareClientRouting().then(() => {
      if (cancelled) return
      setStatus('ready')
      stopSync = startGraphSync()
      seedEventsCache().catch(() => {}) // optional schedule never gates navigation
    }).catch(() => { if (!cancelled) setStatus('failed') })
    return () => { cancelled = true; stopSync?.() }
  }, [retryKey])

  const effectiveStatus = status

  if (effectiveStatus === 'ready') return children

  const failed = effectiveStatus === 'failed'

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
            Preparing campus data for local navigation…
          </div>
        </>
      )}

      {failed && (
        <>
          <div className="boot-gate-message boot-gate-message-error">
            No valid campus data is stored yet. Connect once to download the map, then retry.
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
