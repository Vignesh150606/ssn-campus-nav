/**
 * NavCompass — optional North indicator ("Compass").
 *
 * Phase 4.2.7 (Heading-Up/Compass separation) root-cause fix: this used
 * to ALSO be the Heading-Up toggle (it took headingUp/onToggle props and
 * flipped the preference on tap). That conflated two separate concepts:
 * "which way is North" and "which navigation mode am I in" ended up
 * sharing one visibility rule and one interaction, so hiding the compass
 * also removed the only way to switch modes, and showing it implied it
 * WAS the mode switch. The brief is explicit these must be independent.
 *
 * This is now purely a decorative North indicator:
 *   • No click handler, no headingUp prop, no effect on navigation mode.
 *   • The needle always points to true North on screen, whatever the
 *     map's current rotation (mapHeading) is — including 0 while
 *     North-Up, where "pointing up" and "pointing North" are the same
 *     thing anyway.
 *   • Visibility is entirely independent, controlled by the "Show
 *     Compass" Navigation Setting (default OFF, see NavSettingsPanel).
 *     Turning it on/off never touches Heading-Up; turning Heading-Up
 *     off never hides it.
 *
 * HeadingUpToggle.jsx is the separate, always-visible-during-navigation
 * mode switch this used to double as.
 */
export default function NavCompass({ mapHeading }) {
  const normalised = mapHeading == null ? 0 : ((mapHeading % 360) + 360) % 360
  const northAngle = -normalised

  return (
    <div className="nav-compass" aria-hidden="true" title="North">
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
        {/* North half */}
        <path d="M15 3 L12 15 L15 13 L18 15 Z" fill="#E53E3E" />
        {/* South half */}
        <path d="M15 27 L12 15 L15 17 L18 15 Z" fill="#CBD5E0" />
        {/* Centre pivot */}
        <circle cx="15" cy="15" r="2.5" fill="white" stroke="#E53E3E" strokeWidth="1.5" />
      </svg>
      <span className="nav-compass-n">N</span>
    </div>
  )
}
