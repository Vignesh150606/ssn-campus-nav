import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import MapView from '../components/MapView'
import { getEvent, eventQrUrl, getRoute } from '../api'
import { FEST_META } from '../constants'

const ENTRY_ID = 'main-gate'

export default function EventPage() {
  const { eventId } = useParams()
  const [event, setEvent]           = useState(null)
  const [routePath, setRoutePath]   = useState(null)
  const [eta, setEta]               = useState(null)
  const [distance, setDistance]     = useState(null)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState(null)

  useEffect(() => {
    setEvent(null); setRoutePath(null)
    getEvent(eventId).then(setEvent).catch(e => setError(e.message))
  }, [eventId])

  async function handleDirections() {
    if (!event) return
    setLoading(true)
    try {
      const r = await getRoute(ENTRY_ID, event.location.id)
      setRoutePath(r.path)
      setEta(r.eta_minutes)
      setDistance(r.distance_m)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  if (error) return <div className="state-message">{error}</div>
  if (!event) return <div className="state-message">Loading event…</div>

  const fest = FEST_META[event.fest] || { label: event.fest, color: '#6B7280' }

  return (
    <div className="event-page">
      <div className="pass-card">
        <div className="pass-top">
          <span className="fest-tag" style={{ background: fest.color }}>{fest.label}</span>
          <h1 className="event-title">{event.name}</h1>
          <p className="event-dept">{event.department}</p>
          <div className="event-meta-row">
            <div><span className="meta-label">Date</span>{event.date}</div>
            <div><span className="meta-label">Time</span>{event.start_time} – {event.end_time}</div>
          </div>
          <p className="event-desc">{event.description}</p>
        </div>

        <div className="pass-divider" />

        <div className="pass-bottom">
          <div className="venue-block">
            <div className="meta-label">Venue</div>
            <div className="venue-name">{event.location.name}</div>
            {eta && (
              <div style={{ fontSize:'0.82rem', color:'#2E9E5B', marginBottom:8 }}>
                ~{eta} min · {distance >= 1000 ? `${(distance/1000).toFixed(1)}km` : `${Math.round(distance)}m`} from main gate
              </div>
            )}
            <button className="directions-button" onClick={handleDirections} disabled={loading}>
              {loading ? 'Finding route…' : '↳ Get directions'}
            </button>
          </div>
          <div className="qr-block">
            <img src={eventQrUrl(event.id)} alt={`QR for ${event.name}`} />
            <div className="qr-caption">SCAN TO SHARE</div>
          </div>
        </div>
      </div>

      {routePath && (
        <div className="route-card">
          <div className="route-map">
            <MapView
              locations={[{ ...event.location, category: 'auditorium' }]}
              destinationId={event.location.id}
              routePath={routePath}
              remainingPath={routePath}
              center={[event.location.lat, event.location.lng]}
              zoom={16}
            />
          </div>
          <div className="route-info">
            <div><span className="meta-label">Walking time</span>~{eta} min</div>
            <div><span className="meta-label">Distance</span>{Math.round(distance)}m</div>
            <div><span className="meta-label">From</span>Main Gate</div>
          </div>
        </div>
      )}
    </div>
  )
}
