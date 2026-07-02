/**
 * VenueMenuInline.jsx — Phase 4.2.3, Priority 9.
 *
 * Compact single-line "Today's Menu" preview for food/dining venues,
 * shown directly inside the Route Preview panel's always-visible
 * COLLAPSED row — so the menu is visible the instant a food court is
 * selected, with no need to drag the sheet open (no "second page").
 *
 * Mirrors VenueMenuCard's fetch/error contract (404 = genuinely no menu
 * uploaded today, anything else = a real backend failure) but renders a
 * single truncated line instead of the full image card, since the
 * collapsed row has very little vertical room.
 */
import { useEffect, useState } from 'react'
import { getVenueMenu } from '../api'

export default function VenueMenuInline({ venueId }) {
  const [menu, setMenu] = useState(null) // null=loading, false=none, 'error', obj=loaded

  useEffect(() => {
    if (!venueId) return
    let cancelled = false
    setMenu(null)
    getVenueMenu(venueId)
      .then((m) => { if (!cancelled) setMenu(m) })
      .catch((err) => { if (!cancelled) setMenu(err.status === 404 ? false : 'error') })
    return () => { cancelled = true }
  }, [venueId])

  if (menu === null) return null // loading — say nothing rather than flash empty state

  if (menu === 'error') {
    return <div className="preview-menu-inline error">⚠️ Menu unavailable right now</div>
  }
  if (menu === false) {
    return <div className="preview-menu-inline empty">🍽 No menu uploaded for today</div>
  }
  return (
    <div className="preview-menu-inline">
      🍽 {menu.description || "Today's menu is up — tap to view"}
    </div>
  )
}
