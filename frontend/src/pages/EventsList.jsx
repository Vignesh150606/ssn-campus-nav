import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { getEvents } from '../api'
import { FEST_META } from '../constants'

const POLL_INTERVAL_MS = 20_000  // re-fetch every 20 s so new approved events appear

export default function EventsList() {
  const [events, setEvents] = useState(null)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  const fetchEvents = useCallback(() => {
    getEvents()
      .then(data => { setEvents(data); setLastUpdated(Date.now()) })
      .catch(e => setError(e.message))
  }, [])

  useEffect(() => {
    fetchEvents()
    const interval = setInterval(fetchEvents, POLL_INTERVAL_MS)

    // Task 2 — instantly refresh when admin approves an event from the same browser tab
    const handleAdminApproval = () => fetchEvents()
    window.addEventListener('campus:eventApproved', handleAdminApproval)

    return () => {
      clearInterval(interval)
      window.removeEventListener('campus:eventApproved', handleAdminApproval)
    }
  }, [fetchEvents])

  if (error) return <div className="state-message">{error}</div>
  if (!events) return <div className="state-message">Loading schedule…</div>

  return (
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
                {event.location?.name}
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
  )
}
