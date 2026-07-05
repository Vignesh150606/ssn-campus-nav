/**
 * NavCompass — Bug 6: explicit, user-controlled Heading-Up toggle.
 *
 * Previously this hid itself the instant the map was North-Up (or
 * headingUp was off), which was a dead end — there was no other control
 * to get back to Heading-Up, so Recenter had grown a side effect of
 * silently re-enabling it. Now it's a simple, always-visible toggle
 * during navigation:
 *
 *   ON  (headingUp=true)  → rotating needle showing where North actually
 *                           is relative to the (rotated) screen; map
 *                           rotates with the user's direction of travel.
 *   OFF (headingUp=false) → static, non-rotating "N" — map stays
 *                           North-Up, no heading rotation applied.
 *
 * One tap always flips the preference. Recenter (Home.jsx) never touches
 * this — camera position and heading preference are fully independent.
 */
export default function NavCompass({ mapHeading, headingUp, onToggle }) {
  // Needle angle only means something while heading-up is actually
  // rotating the map; pinned to 0 (pointing straight up) otherwise.
  const normalised = mapHeading == null ? 0 : ((mapHeading % 360) + 360) % 360
  const northAngle = headingUp ? -normalised : 0

  return (
    <button
      className={`nav-compass${headingUp ? '' : ' off'}`}
      onClick={onToggle}
      aria-label={headingUp ? 'Heading-Up is on — tap for North-Up' : 'North-Up is on — tap for Heading-Up'}
      aria-pressed={headingUp}
      title={headingUp ? 'Heading-Up (tap for North-Up)' : 'North-Up (tap for Heading-Up)'}
    >
      <svg
        width="30"
        height="30"
        viewBox="0 0 30 30"
        xmlns="http://www.w3.org/2000/svg"
        style={{
          transform: `rotate(${northAngle}deg)`,
          transition: 'transform 0.35s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
          display: 'block',
        }}
      >
        {/* North half — red when active, muted when North-Up/off */}
        <path d="M15 3 L12 15 L15 13 L18 15 Z" fill={headingUp ? '#E53E3E' : '#94A3B8'} />
        {/* South half */}
        <path d="M15 27 L12 15 L15 17 L18 15 Z" fill="#CBD5E0" />
        {/* Centre pivot */}
        <circle cx="15" cy="15" r="2.5" fill="white" stroke={headingUp ? '#E53E3E' : '#94A3B8'} strokeWidth="1.5" />
      </svg>
      <span className="nav-compass-n">N</span>
    </button>
  )
}
