/**
 * HeadingUpToggle — Phase 4.2.7, Priority 1.
 *
 * Root cause of "the Heading-Up button disappears": NavCompass used to be
 * BOTH the heading-up on/off control AND the compass needle indicator in
 * one component, gated behind the "Show Compass" Navigation Setting
 * (default OFF) — so the only way to reach the control at all was to dig
 * into Settings first. That's backwards: heading-up is the core nav
 * feature and must always be reachable; the compass rose is a purely
 * optional, informational extra.
 *
 * This component is ONLY the feature control now:
 *   - Always rendered during active navigation, regardless of the
 *     "Show Compass" setting — it must never disappear because of that
 *     setting, and the setting must never disable heading-up itself.
 *   - Reflects the current headingUp state (filled/highlighted = on).
 *   - One tap flips the preference, same as before (Home.jsx's
 *     handleToggleHeadingUp — no state-management changes here).
 *
 * NavCompass.jsx remains a separate, purely decorative compass needle,
 * shown only when "Show Compass" is on — it no longer has an onClick or
 * any control responsibility at all.
 */
export default function HeadingUpToggle({ active, onToggle }) {
  return (
    <button
      className={`heading-up-toggle${active ? ' active' : ''}`}
      onClick={onToggle}
      aria-label={active ? 'Heading-Up is on — tap to switch to North-Up' : 'North-Up is on — tap for Heading-Up'}
      aria-pressed={active}
      title={active ? 'Heading-Up (tap for North-Up)' : 'North-Up (tap for Heading-Up)'}
    >
      {/* Modern filled navigation-arrow glyph — distinct from the compass
          needle in NavCompass.jsx so the two are never visually confused. */}
      <svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M12 2 L19.5 20 L12 16.2 L4.5 20 Z"
          fill={active ? '#2563EB' : 'none'}
          stroke={active ? '#2563EB' : '#94A3B8'}
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
      <span className="heading-up-toggle-label">{active ? 'Heading-Up' : 'North-Up'}</span>
    </button>
  )
}
