import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getEvents } from '../api'
import { FEST_META, displayLocationName } from '../constants'
import { SkeletonScheduleList } from '../components/Skeleton'
import { dlog, dwarn } from '../utils/debugLog'

const POLL_INTERVAL_MS = 20_000  // re-fetch every 20 s so new approved events appear

// P1 — localStorage secondary cache.
// Primary persistence is the backend API. The cache lets approved events
// survive browser refresh / reopening the app even when the server has
// restarted (Render free-tier cold-start or ephemeral-filesystem wipe).
// We only cache non-empty results so a transient empty response never wipes
// a good cache. The cache is intentionally NOT the primary layer — it is
// always superseded by the next successful API fetch.
const EVENTS_CACHE_KEY = 'ssn_campus_events_v1'

function loadEventsCache() {
  try {
    const raw = localStorage.getItem(EVENTS_CACHE_KEY)
    if (!raw) return null
    const { data, ts } = JSON.parse(raw)
    // Expire cache after 48 h so stale events don't linger indefinitely
    if (Date.now() - ts > 48 * 60 * 60 * 1000) return null
    return Array.isArray(data) && data.length ? data : null
  } catch { return null }
}

function saveEventsCache(events) {
  try {
    if (!events?.length) return   // never overwrite cache with empty list
    localStorage.setItem(EVENTS_CACHE_KEY, JSON.stringify({ data: events, ts: Date.now() }))
  } catch { /* storage quota exceeded or private mode — silently ignore */ }
}

// Phase 4.2.1 — P1 fix: format a Supabase `date` column value for display.
// Supabase returns `date` columns as "YYYY-MM-DD" strings via PostgREST.
// We convert to "12 Sep 2026" for readability.
function formatDate(raw) {
  if (!raw) return '—'
  try {
    // Append T00:00:00 so Date() parses it as local midnight, not UTC midnight
    // (which can shift the date by one day in UTC+5:30 zones)
    const d = new Date(`${raw.slice(0, 10)}T00:00:00`)
    if (isNaN(d.getTime())) return raw   // unparseable — show raw
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return raw
  }
}

// Format "HH:MM" or "HH:MM:SS" to "HH:MM AM/PM"
function formatTime(raw) {
  if (!raw) return ''
  const m = /^(\d{1,2}):(\d{2})/.exec(raw)
  if (!m) return raw
  let h = parseInt(m[1], 10)
  const min = m[2]
  const ampm = h < 12 ? 'AM' : 'PM'
  if (h === 0) h = 12
  else if (h > 12) h -= 12
  return `${h}:${min} ${ampm}`
}

// Format the time slot — "10:00 AM – 5:00 PM"
function formatTimeRange(start, end) {
  const s = formatTime(start)
  const e = formatTime(end)
  if (!s && !e) return '—'
  if (!e) return s
  return `${s} – ${e}`
}

function venueName(event) {
  return displayLocationName(event.location || event.location_id)
}

export default function EventsList() {
  const [events, setEvents] = useState(() => {
    const cached = loadEventsCache()
    dlog('EventsList/init', 'useState initializer — loadEventsCache() returned:', cached ? `${cached.length} cached events` : 'null (no cache)')
    return cached || null
  })
  const [error, setError] = useState(null)

  dlog('EventsList/render', 'component body executing — events =', events === null ? 'null' : `array(${events.length})`, ' error =', error)

  useEffect(() => {
    dlog('EventsList/effect', 'mount effect started (this should fire exactly once per mount)')
    // Phase 4A.1 fix: fetchEvents now lives entirely inside this effect
    // instead of a useCallback with an empty dependency array. The old
    // version's catch handler decided which error to show by reading the
    // outer `events` variable — a closure frozen at the very first render
    // — instead of the actual current state, which on a fresh visit (no
    // cache yet) is always `null` even after a later fetch succeeds. That
    // combined with a slow/cold backend is what produced "blank/stuck on
    // first load, fine after a refresh": the dashboard wasn't reading its
    // own latest state. `cancelled` also guards against a fetch resolving
    // after this page has been navigated away from.
    let cancelled = false

    function fetchEvents() {
      dlog('EventsList/fetch', 'getEvents() called — GET', '/api/events')
      const startedAt = performance.now()
      getEvents()
        .then((data) => {
          const ms = (performance.now() - startedAt).toFixed(0)
          if (cancelled) {
            dlog('EventsList/fetch', `getEvents() resolved after ${ms}ms with ${data?.length ?? 0} events, but effect was already cancelled (component unmounted/re-ran) — ignoring`)
            return
          }
          dlog('EventsList/fetch', `✅ getEvents() resolved after ${ms}ms with ${data?.length ?? 0} events — calling setEvents()`)
          setEvents(data)
          setError(null)
          saveEventsCache(data)
        })
        .catch((e) => {
          const ms = (performance.now() - startedAt).toFixed(0)
          if (cancelled) {
            dwarn('EventsList/fetch', `getEvents() REJECTED after ${ms}ms (cancelled, ignoring):`, e.message)
            return
          }
          dwarn('EventsList/fetch', `❌ getEvents() REJECTED after ${ms}ms:`, e.message, e)
          // API failed — keep showing whatever's already on screen (cache
          // or a prior successful fetch) and only surface the error if
          // there's genuinely nothing to show. `cur` is the real current
          // state, read through the updater so it's never stale.
          setEvents((cur) => {
            setError(!cur || cur.length === 0 ? e.message : null)
            return cur
          })
        })
    }

    fetchEvents()
    const interval = setInterval(fetchEvents, POLL_INTERVAL_MS)

    // P1 — instantly refresh when admin approves an event from the same browser tab
    const handleAdminApproval = () => fetchEvents()
    window.addEventListener('campus:eventApproved', handleAdminApproval)

    return () => {
      dlog('EventsList/effect', 'cleanup running (unmount or re-run) — setting cancelled=true')
      cancelled = true
      clearInterval(interval)
      window.removeEventListener('campus:eventApproved', handleAdminApproval)
    }
  }, [])

  if (error && (!events || events.length === 0)) {
    dlog('EventsList/render', '→ taking ERROR branch:', error)
    return <div className="state-message">{error}</div>
  }
  if (!events) {
    dlog('EventsList/render', '→ taking SKELETON branch (events is still null)')
    return (
      <div className="schedule-scroll-container">
        <div className="schedule-page">
          <h1 className="schedule-heading">Fest Schedule</h1>
          <SkeletonScheduleList />
        </div>
      </div>
    )
  }

  dlog('EventsList/render', `→ taking REAL CONTENT branch with ${events.length} events`)
  return (
    // P2 — .schedule-scroll-container gives this page its own overflow-y: auto
    // so the full list scrolls naturally on mobile (no clipped cards).
    <div className="schedule-scroll-container">
      <div className="schedule-page">
        <h1 className="schedule-heading">Fest Schedule</h1>
        {events.length === 0 && (
          <div className="state-message" style={{ marginTop: 24 }}>No events posted yet — check back soon!</div>
        )}
        {events.map((event) => {
          const fest = FEST_META[event.fest] || { label: event.fest, color: '#6B7280' }
          return (
            <Link key={event.id} to={`/event/${event.id}`} className="schedule-card">
              <span className="fest-tag" style={{ background: fest.color }}>
                {fest.label}
              </span>
              <div className="event-title">{event.name}</div>
              <div className="event-meta-row">
                <div>
                  <span className="meta-label">Venue</span>
                  {venueName(event)}
                </div>
                <div>
                  <span className="meta-label">Date</span>
                  {formatDate(event.date)}
                </div>
                <div>
                  <span className="meta-label">Time</span>
                  {formatTimeRange(event.start_time, event.end_time)}
                </div>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
