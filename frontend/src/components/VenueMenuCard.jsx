/**
 * VenueMenuCard.jsx — Phase 4.2 Priority 3
 *
 * Displays today's menu image for a food/dining venue.
 * Used on the LocationCard and route preview panel when the selected
 * venue is a food court (category: food | dining).
 * Fetches lazily on mount; shows nothing if no menu is available today.
 */
import { useEffect, useState } from 'react'
import { getVenueMenu } from '../api'

export default function VenueMenuCard({ venueId, venueName }) {
  const [menu, setMenu]     = useState(null)   // null = loading, false = not available
  const [open, setOpen]     = useState(false)  // lightbox

  useEffect(() => {
    if (!venueId) return
    let cancelled = false
    getVenueMenu(venueId)
      .then((m) => { if (!cancelled) setMenu(m) })
      .catch(() => { if (!cancelled) setMenu(false) })
    return () => { cancelled = true }
  }, [venueId])

  // Not a food venue or no menu today
  if (menu === null || menu === false) return null

  return (
    <div className="venue-menu-card">
      <div className="venue-menu-header">
        <span className="venue-menu-label">🍽 Today&apos;s Menu</span>
        {menu.description && (
          <span className="venue-menu-desc">{menu.description}</span>
        )}
      </div>
      <button
        className="venue-menu-thumb-btn"
        onClick={() => setOpen(true)}
        aria-label={`View today's menu at ${venueName}`}
      >
        <img
          src={menu.image_url}
          alt={`Today's menu at ${venueName}`}
          className="venue-menu-thumb"
          loading="lazy"
        />
        <span className="venue-menu-tap-hint">Tap to enlarge</span>
      </button>

      {/* Lightbox */}
      {open && (
        <div
          className="venue-menu-lightbox"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Menu image"
        >
          <button
            className="venue-menu-lightbox-close"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
          >✕</button>
          <img
            src={menu.image_url}
            alt={`Today's menu at ${venueName}`}
            className="venue-menu-lightbox-img"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}
