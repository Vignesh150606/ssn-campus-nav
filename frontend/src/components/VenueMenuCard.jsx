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
  const [menu,    setMenu]    = useState(null)   // null=loading, false=not available, 'error'=backend failure, obj=loaded
  const [errorMsg, setErrorMsg] = useState(null)
  const [open,    setOpen]    = useState(false)  // lightbox

  useEffect(() => {
    if (!venueId) return
    let cancelled = false
    setMenu(null)
    setErrorMsg(null)
    getVenueMenu(venueId)
      .then((m) => { if (!cancelled) setMenu(m) })
      .catch((err) => {
        if (cancelled) return
        if (err.status === 404) {
          setMenu(false) // genuinely no menu uploaded today — not an error
        } else {
          // A real backend/DB failure (e.g. 503) must stay visible, not get
          // silently disguised as "no menu today" — that's exactly the kind
          // of masked error this phase's Bug 1 fix is about.
          setMenu('error')
          setErrorMsg(err.message || 'Could not load the menu right now.')
        }
      })
    return () => { cancelled = true }
  }, [venueId])

  // Still loading — show nothing (parent already renders its own skeleton/loading state)
  if (menu === null) return null

  if (menu === 'error') {
    return (
      <div className="venue-menu-card">
        <div className="venue-menu-header">
          <span className="venue-menu-label">🍽 Today&apos;s Menu</span>
        </div>
        <div className="venue-menu-empty venue-menu-error">⚠️ {errorMsg}</div>
      </div>
    )
  }

  // Priority 3 fix: a food/dining venue's preview must always surface a menu
  // section — either the real menu or an explicit "no menu" empty state —
  // rather than silently rendering nothing, which made the whole menu
  // section disappear as if it were never built.
  if (menu === false) {
    return (
      <div className="venue-menu-card">
        <div className="venue-menu-header">
          <span className="venue-menu-label">🍽 Today&apos;s Menu</span>
        </div>
        <div className="venue-menu-empty">No menu uploaded for today.</div>
      </div>
    )
  }

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
