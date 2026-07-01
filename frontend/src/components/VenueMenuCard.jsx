/**
 * VenueMenuCard.jsx — Phase 4.2 / 4.2.1
 *
 * Structured menu preview for food/dining venues in the route preview panel.
 * Displays: today's menu image + description + updated time + navigate.
 * Fetches lazily on mount; shows nothing if no menu is available today.
 */
import { useEffect, useState } from 'react'
import { getVenueMenu } from '../api'

function formatUpdatedAt(raw) {
  if (!raw) return null
  try {
    const d = new Date(raw)
    if (isNaN(d.getTime())) return null
    const now = new Date()
    const diffMs = now - d
    const diffMins = Math.floor(diffMs / 60000)
    if (diffMins < 1)   return 'Just now'
    if (diffMins < 60)  return `${diffMins} min ago`
    const diffHrs = Math.floor(diffMins / 60)
    if (diffHrs < 24 && d.toDateString() === now.toDateString()) {
      return `Today ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
    }
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  } catch { return null }
}

export default function VenueMenuCard({ venueId, venueName }) {
  const [menu,    setMenu]    = useState(null)   // null=loading, false=not available, obj=loaded
  const [open,    setOpen]    = useState(false)  // lightbox

  useEffect(() => {
    if (!venueId) return
    let cancelled = false
    getVenueMenu(venueId)
      .then((m) => { if (!cancelled) setMenu(m) })
      .catch(() => { if (!cancelled) setMenu(false) })
    return () => { cancelled = true }
  }, [venueId])

  // Not yet loaded or no menu today — show nothing
  if (menu === null || menu === false) return null

  const updatedAt = formatUpdatedAt(menu.updated_at || menu.created_at)

  return (
    <div className="venue-menu-card">
      {/* Header row */}
      <div className="venue-menu-header">
        <span className="venue-menu-label">🍽 Today&apos;s Menu</span>
        <span className="venue-menu-open-tag">Open Today</span>
      </div>

      {/* Menu image */}
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

      {/* Description row */}
      {menu.description && (
        <div className="venue-menu-desc-row">
          <span className="venue-menu-desc-text">{menu.description}</span>
        </div>
      )}

      {/* Updated timestamp */}
      {updatedAt && (
        <div className="venue-menu-updated">Updated: {updatedAt}</div>
      )}

      {/* Lightbox */}
      {open && (
        <div
          className="venue-menu-lightbox"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Menu image"
        >
          <button className="venue-menu-lightbox-close" onClick={() => setOpen(false)} aria-label="Close menu">✕</button>
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
