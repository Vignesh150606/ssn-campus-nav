/**
 * EventPage.jsx — Full-page event details screen.
 *
 * Phase 8:  Directions → Route Preview Panel (no tiny embedded map)
 * Phase 10: Banner, description, photo gallery, contact, registration
 * Phase 11: Room / Floor / Wing displayed; passed to Home.jsx on navigation
 * Phase 12: Fest Schedule Directions → uses same nav flow
 * Phase 13: QR → this page → Details → Navigation
 */
import { useEffect, useState, useMemo, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { getEvent, getRoute, getRouteFromCoords, eventQrUrl } from '../api'
import { useLocationContext } from '../context/LocationContext'
import { useVoiceGuidance } from '../hooks/useVoiceGuidance'
import { haversine } from '../utils/geo'
import { FEST_META } from '../constants'

const ENTRY_ID = 'main-gate'

function fmt(m) {
  if (m == null) return '—'
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`
}

// ── Photo Lightbox ──────────────────────────────────────────────────────────
function PhotoLightbox({ photos, startIdx, onClose }) {
  const [idx, setIdx] = useState(startIdx)
  const prev = useCallback(() => setIdx(i => Math.max(0, i - 1)), [])
  const next = useCallback(() => setIdx(i => Math.min(photos.length - 1, i + 1)), [photos.length])

  useEffect(() => {
    const handler = e => {
      if (e.key === 'Escape')       onClose()
      else if (e.key === 'ArrowLeft')  prev()
      else if (e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, prev, next])

  return (
    <div className="photo-lightbox" onClick={onClose}>
      <button className="photo-lightbox-close" onClick={onClose} aria-label="Close">✕</button>
      <img
        src={photos[idx]}
        alt={`Photo ${idx + 1}`}
        onClick={e => e.stopPropagation()}
        draggable={false}
      />
      {photos.length > 1 && (
        <>
          <button className="lightbox-nav left"  onClick={e => { e.stopPropagation(); prev() }} aria-label="Previous">‹</button>
          <button className="lightbox-nav right" onClick={e => { e.stopPropagation(); next() }} aria-label="Next">›</button>
          <div className="lightbox-counter">{idx + 1} / {photos.length}</div>
        </>
      )}
    </div>
  )
}

// ── Off-route / recalculating banner ───────────────────────────────────────
function OffRouteBanner({ offRoute, recalculating }) {
  if (!offRoute && !recalculating) return null
  return (
    <div className={`off-route-banner ${recalculating ? 'recalculating' : ''}`}>
      {recalculating
        ? '🔄 Recalculating Route…'
        : '⚠ Off Route Detected'}
    </div>
  )
}

export default function EventPage() {
  const { eventId }  = useParams()
  const navigate     = useNavigate()

  const [event,         setEvent]         = useState(null)
  const [loadError,     setLoadError]     = useState(null)
  const [routePreview,  setRoutePreview]  = useState(null)   // {path,dist,eta}
  const [routeLoading,  setRouteLoading]  = useState(false)
  const [routeError,    setRouteError]    = useState(null)
  const [previewOpen,   setPreviewOpen]   = useState(false)
  const [lightboxIdx,   setLightboxIdx]   = useState(null)

  const {
    setRoute, start: startTracking, tracking, position,
    hasRoute, remainingDist, remainingPath, offRoute, recalculating,
  } = useLocationContext()

  const voice = useVoiceGuidance({
    tracking, hasRoute, remainingDist, remainingPath, offRoute,
  })

  useEffect(() => {
    setEvent(null); setLoadError(null)
    setRoutePreview(null); setPreviewOpen(false)
    getEvent(eventId).then(setEvent).catch(e => setLoadError(e.message))
  }, [eventId])

  // ── Route preview (Phase 8) ────────────────────────────────────────────
  const handleGetDirections = useCallback(async () => {
    if (!event) return
    setRouteLoading(true); setRouteError(null)
    try {
      const r = (tracking && position)
        ? await getRouteFromCoords(position.lat, position.lng, event.location.id)
        : await getRoute(ENTRY_ID, event.location.id)
      setRoutePreview({ path: r.path, dist: r.distance_m, eta: r.eta_minutes })
      setPreviewOpen(true)
    } catch (e) {
      setRouteError(e.message)
    } finally {
      setRouteLoading(false)
    }
  }, [event, tracking, position])

  // ── Start Navigation (Phase 11: carry room info to Home) ──────────────
  const handleStartNavigation = useCallback(() => {
    if (!routePreview || !event) return
    voice.resetForNewRoute()
    setRoute(routePreview.path, event.location.lat, event.location.lng, event.location.id)
    if (!tracking) startTracking()
    // Phase 11: pass room/floor/wing via router state → Home.jsx reads it on mount
    const eventInfo = {
      room:     event.room_number  || null,
      floor:    event.floor        || null,
      wing:     event.wing         || null,
      building: event.building     || event.location?.name || null,
      name:     event.name,
    }
    navigate('/', { state: { eventInfo } })
  }, [routePreview, event, voice, setRoute, tracking, startTracking, navigate])

  // ── Distance from user to venue ───────────────────────────────────────
  const distToVenue = useMemo(() => {
    if (!position || !event?.location) return null
    return haversine(position.lat, position.lng, event.location.lat, event.location.lng)
  }, [position, event])

  const photos = event?.photo_urls?.filter(Boolean) || []
  const poster  = event?.poster_url || null

  // ── Loading / error states ────────────────────────────────────────────
  if (loadError) return (
    <div className="event-page-v2" style={{ padding: 24, textAlign: 'center' }}>
      <div className="state-message" style={{ marginBottom: 16 }}>{loadError}</div>
      <Link to="/events" className="event-back-link">← Back to Events</Link>
    </div>
  )
  if (!event) return (
    <div className="event-page-v2">
      <div className="state-message">Loading event…</div>
    </div>
  )

  const fest = FEST_META?.[event.fest] || { label: event.fest || 'Event', color: '#6B7280' }
  const bannerBg = poster
    ? `url(${poster}) center / cover no-repeat`
    : `linear-gradient(135deg, ${fest.color}cc 0%, ${fest.color} 100%)`

  return (
    <div className="event-page-v2">
      {/* Lightbox */}
      {lightboxIdx !== null && (
        <PhotoLightbox
          photos={photos}
          startIdx={lightboxIdx}
          onClose={() => setLightboxIdx(null)}
        />
      )}

      {/* ── Banner ── */}
      <div className="event-banner" style={{ background: bannerBg }}>
        <div className="event-banner-overlay" />
        <div className="event-banner-content">
          <div className="event-banner-tags">
            <span className="event-fest-tag" style={{ background: fest.color }}>
              {fest.label}
            </span>
            {event.category && (
              <span className="event-category-tag">{event.category}</span>
            )}
          </div>
          <h1 className="event-title-large">{event.name}</h1>
          <div className="event-meta-row">
            <span>📅 {event.date}</span>
            <span>⏰ {event.start_time}–{event.end_time}</span>
            {event.department && <span>🏛 {event.department}</span>}
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="event-content">

        {/* Quick detail chips */}
        <div className="event-card event-quick-row">
          {event.organizer && (
            <div className="event-quick-item">
              <div className="event-quick-label">Organiser</div>
              <div className="event-quick-value">{event.organizer}</div>
            </div>
          )}
          <div className="event-quick-item">
            <div className="event-quick-label">Open to</div>
            <div className="event-quick-value">
              {event.open_to_external ? 'All colleges' : 'SSN only'}
            </div>
          </div>
          {event.category && (
            <div className="event-quick-item">
              <div className="event-quick-label">Category</div>
              <div className="event-quick-value">{event.category}</div>
            </div>
          )}
        </div>

        {/* Description */}
        {event.description && (
          <div className="event-card">
            <div className="event-card-title">About This Event</div>
            <div className="event-description-text">{event.description}</div>
          </div>
        )}

        {/* Photo gallery */}
        {photos.length > 0 && (
          <div className="event-card">
            <div className="event-card-title">Photos ({photos.length})</div>
            <div className="event-photo-carousel">
              {photos.map((url, i) => (
                <img
                  key={i}
                  src={url}
                  alt={`Event photo ${i + 1}`}
                  className="event-photo-item"
                  onClick={() => setLightboxIdx(i)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Contact & Registration */}
        {(event.contact_info || event.registration_link) && (
          <div className="event-card">
            <div className="event-card-title">More Info</div>
            {event.contact_info && (
              <div className="event-info-row">
                <span className="event-info-label">Contact</span>
                <span className="event-info-value">{event.contact_info}</span>
              </div>
            )}
            {event.registration_link && (
              <div className="event-info-row">
                <span className="event-info-label">Register</span>
                <a
                  href={event.registration_link}
                  target="_blank"
                  rel="noreferrer"
                  className="event-reg-link"
                >
                  Register Now →
                </a>
              </div>
            )}
          </div>
        )}

        {/* Venue + Room/Floor/Wing (Phase 11) + Navigation */}
        <div className="event-card">
          <div className="event-card-title">Venue & Directions</div>

          {/* Location row */}
          <div className="event-location-row">
            <span className="event-location-icon">📍</span>
            <div>
              <div className="event-location-name">{event.location?.name || event.location_id}</div>
              {distToVenue != null && (
                <div className="event-location-dist">{fmt(distToVenue)} from your location</div>
              )}
            </div>
          </div>

          {/* Phase 11: Room / Floor / Wing */}
          {(event.building || event.room_number || event.floor || event.wing) && (
            <div className="event-room-card">
              {event.building && (
                <div className="event-room-row">
                  <span className="event-room-label">Building</span>
                  <span className="event-room-value">{event.building}</span>
                </div>
              )}
              {event.room_number && (
                <div className="event-room-row">
                  <span className="event-room-label">Room</span>
                  <span className="event-room-value">{event.room_number}</span>
                </div>
              )}
              {event.floor && (
                <div className="event-room-row">
                  <span className="event-room-label">Floor</span>
                  <span className="event-room-value">{event.floor}</span>
                </div>
              )}
              {event.wing && (
                <div className="event-room-row">
                  <span className="event-room-label">Wing</span>
                  <span className="event-room-value">{event.wing}</span>
                </div>
              )}
              {event.floor && (
                <div className="event-room-hint">
                  📍 Proceed to the {event.floor}
                  {event.wing ? ` and take the ${event.wing} corridor` : ''}.
                </div>
              )}
            </div>
          )}

          {/* Route preview panel (Phase 8 — no tiny map) */}
          {!previewOpen ? (
            <div className="event-nav-section" style={{ marginTop: 14 }}>
              <button
                className="event-nav-btn primary"
                onClick={handleGetDirections}
                disabled={routeLoading}
              >
                {routeLoading ? '⏳ Calculating Route…' : '↳ Get Directions'}
              </button>
              {routeError && (
                <div style={{ color: 'var(--danger)', fontSize: '0.82rem', marginTop: 8 }}>
                  {routeError}
                </div>
              )}
            </div>
          ) : (
            <div className="event-route-preview">
              <div className="event-route-info-row">
                <div className="event-route-stat">
                  <div className="event-route-stat-value">{fmt(routePreview?.dist)}</div>
                  <div className="event-route-stat-label">Distance</div>
                </div>
                <div className="event-route-stat">
                  <div className="event-route-stat-value">
                    {routePreview?.eta != null ? `~${routePreview.eta} min` : '—'}
                  </div>
                  <div className="event-route-stat-label">Walking time</div>
                </div>
                <div className="event-route-stat">
                  <div className="event-route-stat-value" style={{ fontSize: '0.85rem' }}>
                    {tracking && position ? 'Your location' : 'Main Gate'}
                  </div>
                  <div className="event-route-stat-label">Starting from</div>
                </div>
              </div>

              <div className="event-nav-section">
                <button className="event-nav-btn primary" onClick={handleStartNavigation}>
                  🧭 Start Navigation
                </button>
                <button className="event-nav-btn secondary" onClick={() => setPreviewOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* QR share card */}
        <div className="event-card event-qr-row">
          <div>
            <div className="event-card-title">Share via QR</div>
            <div style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>
              Scan to open event details
            </div>
          </div>
          <img
            src={eventQrUrl(event.id)}
            alt={`QR for ${event.name}`}
            className="event-qr-img"
          />
        </div>

        {/* Back link */}
        <div style={{ textAlign: 'center', padding: '8px 0 32px' }}>
          <Link to="/events" className="event-back-link">← All Events</Link>
        </div>

      </div>
    </div>
  )
}
