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
 * States:
 *   checking → polling normally, friendly "starting up" message
 *   slow     → still polling, ~20-30s elapsed, message escalates
 *   ready    → health check succeeded — render children, unmount this
 *   failed   → ~60s of continuous failure — show a Retry screen
 *              (polling keeps running silently in the background even
 *              here, so it still recovers on its own the moment the
 *              backend wakes up — Retry is just a way to nudge it sooner
 *              and give the user something to do).
 */
import { useEffect, useState } from 'react'
import { checkHealth } from '../api'

const SLOW_MESSAGE_AFTER_MS = 22_000
const GIVE_UP_AFTER_MS = 60_000
const RETRY_INTERVAL_MS = 2_500
const ATTEMPT_TIMEOUT_MS = 8_000

export default function BootGate({ children }) {
  const [status, setStatus] = useState('checking') // checking | slow | ready | failed
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    // `cancelled` is a variable local to *this* effect invocation, not a
    // shared ref — under StrictMode's dev-only mount→cleanup→mount,
    // each invocation gets its own independent flag, so a stale first
    // invocation's in-flight request can't get "un-cancelled" by the
    // second invocation resetting a shared ref back to false (which
    // would have let two polling loops run concurrently).
    let cancelled = false
    let attemptTimer = null

    async function attempt() {
      if (cancelled) return
      const ok = await checkHealth(ATTEMPT_TIMEOUT_MS)
      if (cancelled) return
      if (ok) {
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
