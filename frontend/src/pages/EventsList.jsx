import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { getEvents } from '../api'
import { FEST_META } from '../constants'

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

// P8 — frontend display-name overrides (mirrors AdminDashboard LOCATION_DISPLAY_NAMES)
const VENUE_NAME_OVERRIDES = {
  'tcs-auditorium': 'Main Auditorium',
  'mini-hall-1':    'Mini Auditorium',
  'main-canteen':   'Main Canteen',
}

function venueName(event) {
  const id = event.location?.id || event.location_id
  return VENUE_NAME_OVERRIDES[id] || event.location?.name || id || '—'
}

export default function EventsList() {
  const [events, setEvents] = useState(() => loadEventsCache() || null)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  const fetchEvents = useCallback(() => {
    getEvents()
      .then(data => {
        setEvents(data)
        setError(null)
        setLastUpdated(Date.now())
        saveEventsCache(data)   // persist for cold-start recovery
      })
      .catch(e => {
        // API failed — keep showing whatever we already have (cache or prior fetch).
        // Only surface the error if we have nothing at all to show.
        setError(prev => {
          setEvents(cur => {
            if (!cur || cur.length === 0) {
              // nothing to show — surface the error
              // (setError handled below via the outer return)
              return cur
            }
            return cur   // keep showing stale data silently
          })
          return (events == null || events?.length === 0) ? e.message : null
        })
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // If we already have cache, it's already in state — fetch fresh in background
    fetchEvents()
    const interval = setInterval(fetchEvents, POLL_INTERVAL_MS)

    // P1 — instantly refresh when admin approves an event from the same browser tab
    const handleAdminApproval = () => fetchEvents()
    window.addEventListener('campus:eventApproved', handleAdminApproval)

    return () => {
      clearInterval(interval)
      window.removeEventListener('campus:eventApproved', handleAdminApproval)
    }
  }, [fetchEvents])

  if (error && (!events || events.length === 0)) {
    return <div className="state-message">{error}</div>
  }
  if (!events) return <div className="state-message">Loading schedule…</div>

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
                  {event.date}
                </div>
                <div>
                  <span className="meta-label">Time</span>
                  {event.start_time}
                </div>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
