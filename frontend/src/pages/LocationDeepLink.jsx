/**
 * LocationDeepLink.jsx — Phase 4.2 Priority 2
 *
 * Handles URLs like /location/eee-block produced by the Share button.
 * On mount it fetches the location from the API, then redirects to / with
 * state that triggers handleDirections(loc) — opening the route preview
 * sheet exactly as if the user had tapped the card themselves.
 *
 * Keeps the user on the spinner for the fraction of a second the API takes;
 * if the location is unknown it drops them to the home page gracefully.
 */
import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getLocation } from '../api'

export default function LocationDeepLink() {
  const { locationId } = useParams()
  const navigate = useNavigate()
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!locationId) { navigate('/', { replace: true }); return }
    getLocation(locationId)
      .then((loc) => {
        // Navigate to home with the location in router state so Home.jsx
        // can pick it up via useEffect and open the preview sheet.
        navigate('/', { replace: true, state: { deepLinkLocation: loc } })
      })
      .catch(() => {
        setError(true)
        setTimeout(() => navigate('/', { replace: true }), 2000)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId])

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 20,
      background: 'var(--canvas)', color: 'var(--ink)'
    }}>
      <img src="/ssn-logo.png" alt="SSN" style={{ width: 120, height: 'auto', objectFit: 'contain' }} />
      {error
        ? <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>Location not found — redirecting…</p>
        : <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>Opening destination…</p>
      }
    </div>
  )
}
