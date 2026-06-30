/**
 * BootGate.jsx — Phase 4A.1 stability work.
 *
 * Renders a polished full-screen startup screen until the backend (Render
 * free-tier cold start can take 20-50s) and Supabase are both confirmed
 * reachable, then mounts the real app. This is the root-cause fix for
 * "Fest Schedule / Admin Dashboard sometimes blank on first load, refresh
 * fixes it": every route used to mount immediately and race the very
 * first API call against a server that might still be waking up. Gating
 * the whole app behind one confirmed-healthy check means every page's
 * first real fetch happens against a server that's already awake.
 *
 * Phase 4A.1 addition: after the health check passes we fire a background
 * prefetch of /api/events and write it into the same localStorage key that
 * EventsList reads on mount (`ssn_campus_events_v1`). This ensures the Fest
 * Schedule has data the instant it first renders — even if the user navigates
 * there before EventsList's own useEffect has a chance to complete its first
 * request. Prefetch failures are silently swallowed; the page still works,
 * it just shows the skeleton while re-fetching normally.
 *
 * States:
 *   checking → polling normally, friendly "starting up" message
 *   slow     → still polling, ~20-30s elapsed, message escalates
 *   ready    → health check succeeded — render children, unmount this
 *   failed   → ~60s of continuous failure — show a Retry screen
 */
import { useEffect, useState } from 'react'
import { checkHealth } from '../api'

const SLOW_MESSAGE_AFTER_MS = 22_000
const GIVE_UP_AFTER_MS = 60_000
const RETRY_INTERVAL_MS = 2_500
const ATTEMPT_TIMEOUT_MS = 8_000

// Mirror of EventsList's cache key + writer so BootGate can seed the cache
// without importing EventsList (which would defeat code-splitting).
const EVENTS_CACHE_KEY = 'ssn_campus_events_v1'

function seedEventsCache() {
  // Fire-and-forget: errors are silently ignored.
  // The backend URL resolves the same way as api.js's getJSON.
  const base = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000'
  fetch(`${base}/api/events`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!Array.isArray(data) || data.length === 0) return
      try {
        localStorage.setItem(
          EVENTS_CACHE_KEY,
          JSON.stringify({ data, ts: Date.now() }),
        )
      } catch { /* storage quota — silently ignore */ }
    })
    .catch(() => { /* network error — EventsList will retry on its own */ })
}

export default function BootGate({ children }) {
  const [status, setStatus] = useState('checking') // checking | slow | ready | failed
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    let attemptTimer = null

    async function attempt() {
      if (cancelled) return
      const ok = await checkHealth(ATTEMPT_TIMEOUT_MS)
      if (cancelled) return
      if (ok) {
        // Seed the events cache in the background so EventsList has data
        // available the moment it first mounts (no skeleton / blank phase).
        seedEventsCache()
        setStatus('ready')
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

  if (status === 'ready') return children

  const failed = status === 'failed'
  const slow = status === 'slow'

  return (
    <div className="boot-gate" role="status" aria-live="polite">
      <div className="boot-gate-mark" aria-hidden="true" />
      <div className="boot-gate-title">Starting SSN Campus Navigator…</div>

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
