import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getEvents } from '../api'
import { FEST_META } from '../constants'

export default function EventsList() {
  const [events, setEvents] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    getEvents()
      .then(setEvents)
      .catch((e) => setError(e.message))
  }, [])

  if (error) return <div className="state-message">{error}</div>
  if (!events) return <div className="state-message">Loading schedule…</div>

  return (
    <div className="schedule-page">
      <h1 className="schedule-heading">Fest Schedule</h1>
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
