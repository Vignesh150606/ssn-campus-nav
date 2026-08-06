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
import { checkHealth, getGraph, getRoadSegments, getLocations } from '../api'
import { useOnlineStatus } from '../offline/useOnlineStatus'

const SLOW_MESSAGE_AFTER_MS = 22_000
const GIVE_UP_AFTER_MS = 60_000
const RETRY_INTERVAL_MS = 2_500
const ATTEMPT_TIMEOUT_MS = 8_000

// Mirrors EventsList's cache key/writer so the cache can be warmed here
// without importing that page directly (keeps bundles/cleanly separated).
const EVENTS_CACHE_KEY = 'ssn_campus_events_v1'

function seedEventsCache() {
  const base = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000'
  fetch(`${base}/api/events`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!Array.isArray(data) || data.length === 0) return
      try {
        localStorage.setItem(EVENTS_CACHE_KEY, JSON.stringify({ data, ts: Date.now() }))
      } catch { /* storage quota — silently ignore */ }
    })
    .catch(() => { /* non-fatal — EventsList will fetch normally */ })
}

// Task 1 (offline support) — warms the on-device cache offline routing
// needs (see offline/db.js, offline/offlineBundle.js, api.js) the moment
// the backend is first confirmed reachable, rather than waiting on
// Home.jsx's own mount to call getLocations()/getRoadSegments(). Each of
// these already caches itself on success (see api.js) — this just makes
// sure that happens even if the user's very first session lands on a
// route other than Home (an EventPage deep link, say) or ends before
// Home.jsx gets there itself.
function seedOfflineCache() {
  getGraph().catch(() => {})
  getRoadSegments().catch(() => {})
  getLocations().catch(() => {})
}

export default function BootGate({ children }) {
  const [status, setStatus] = useState('checking') // checking | slow | ready | failed
  const [retryKey, setRetryKey] = useState(0)
  // Task 1 (offline support) — reuses the same online/offline tracking
  // OfflineIndicator.jsx already relies on (see offline/offlineBundle.js),
  // rather than this component polling navigator.onLine itself.
  const { online } = useOnlineStatus()

  useEffect(() => {
    let cancelled = false
    let attemptTimer = null

    async function attempt() {
      if (cancelled) return
      const ok = await checkHealth(ATTEMPT_TIMEOUT_MS)
      if (cancelled) return
      if (ok) {
        seedEventsCache()
        seedOfflineCache()
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

  // Bug fix (Task 1 — offline support) — a device with no network at all
  // can never pass checkHealth() above, so this gate used to leave it
  // stuck polling for a full 60s and then landing on a 'failed' dead-end
  // whose only action (Retry) just repeats the same doomed check —
  // "test app restart while offline" and "test airplane mode" would both
  // hang here with no way into the app at all. The rest of the app now
  // runs without a connection (cached data + offline routing — see
  // api.js and offline/*), so once we already know there's no network —
  // whether that was already true before the very first health check
  // could resolve, or becomes true partway through polling — this gate
  // has nothing left to usefully protect against: let the app straight
  // through and let the header's OfflineIndicator carry the message
  // instead of a second, boot-time one. Derived directly from render
  // (not its own state, not set from inside the effect above) so it
  // reacts the instant `online` changes, from any status this gate is
  // currently in, with no extra state-lifecycle wiring of its own.
  const effectiveStatus = online ? status : 'ready'

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
        src="/ssn-logo.png"
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
