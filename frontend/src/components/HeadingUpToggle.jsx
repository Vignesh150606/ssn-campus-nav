/**
 * HeadingUpToggle — dedicated Heading-Up / North-Up mode switch.
 *
 * Phase 4.2.7 (Heading-Up/Compass separation): NavCompass used to do
 * double duty as both this toggle AND a North-indicator needle, which
 * meant the two were forced to share one visibility rule — hiding the
 * optional "compass" display also removed the only control that could
 * switch the map back to North-Up, and showing it as the sole always-on
 * control conflated "which mode is navigation in" with "which way is
 * North", two genuinely separate concepts.
 *
 * This is the primary, ALWAYS-visible-during-navigation control:
 *   ON  (headingUp=true)  → filled/active glyph, map rotates with travel.
 *   OFF (headingUp=false) → outline/muted glyph, map stays North-Up.
 * It never checks a "show compass" setting — there must always be a way
 * to switch modes without hunting through Navigation Settings first.
 *
 * Deliberately NOT a directional needle (no North math here at all) —
 * that's NavCompass's job, and only NavCompass's.
 */
export default function HeadingUpToggle({ headingUp, onToggle }) {
  return (
    <button
      className={`heading-up-toggle${headingUp ? '' : ' off'}`}
      onClick={onToggle}
      aria-label={headingUp ? 'Heading-Up is on — tap for North-Up' : 'North-Up is on — tap for Heading-Up'}
      aria-pressed={headingUp}
      title={headingUp ? 'Heading-Up (tap for North-Up)' : 'North-Up (tap for Heading-Up)'}
    >
      <svg
        width="22" height="22" viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: 'block' }}
      >
        {/* A simple travel-direction glyph — filled red when active,
            outlined/muted for North-Up. This indicates MODE, not
            direction — it never rotates. */}
        <path
          d="M12 2 L19 21 L12 17 L5 21 Z"
          fill={headingUp ? '#E53E3E' : 'none'}
          stroke={headingUp ? '#E53E3E' : '#94A3B8'}
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
      <span className="heading-up-toggle-label">{headingUp ? 'UP' : 'N'}</span>
    </button>
  )
}
