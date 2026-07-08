/**
 * NavCompass — Phase 4.2.7, Priority 1: purely decorative compass needle.
 *
 * Previously this was ALSO the heading-up on/off control, gated behind
 * "Show Compass" (default OFF) — which meant the control disappeared
 * unless that setting was on. The two responsibilities are split:
 *
 *   - The on/off control lives on the native Leaflet rotate button now
 *     (Phase 4.3 — see the L.Control.Rotate override in MapView.jsx),
 *     always visible during navigation regardless of this setting.
 *   - NavCompass (this file): shown ONLY when "Show Compass" is on, purely
 *     informational, no click handler, no control over heading-up at all.
 *     Disabling "Show Compass" only hides this needle — it can never hide
 *     or disable heading-up itself, and never did the reverse either.
 *
 *   ON  (headingUp=true)  → rotating needle showing where North actually
 *                           is relative to the (rotated) screen; map
 *                           rotates with the user's direction of travel.
 *   OFF (headingUp=false) → static, non-rotating "N" — map stays
 *                           North-Up, no heading rotation applied.
 */
export default function NavCompass({ mapHeading, headingUp }) {
  // Needle angle only means something while heading-up is actually
  // rotating the map; pinned to 0 (pointing straight up) otherwise.
  const normalised = mapHeading == null ? 0 : ((mapHeading % 360) + 360) % 360
  const northAngle = headingUp ? -normalised : 0

  return (
    <div
      className={`nav-compass${headingUp ? '' : ' off'}`}
      role="img"
      aria-label={headingUp ? 'Compass: heading-up active' : 'Compass: north-up'}
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
    </div>
  )
}
