/**
 * NavCompass — Navigation-mode compass rose.
 *
 * Appears automatically when the map is in heading-up mode (rotated away from North).
 * Renders a proper compass needle that shows where North is relative to the screen.
 *
 * Single tap  → snap map back to North-Up  (rotation resets)
 * Double-tap  → return to Heading-Up       (rotation resumes)
 *
 * Hidden when map heading ≈ 0 (already North-Up) to avoid a redundant button.
 */
import { useRef } from 'react'

const DOUBLE_TAP_MS = 380

export default function NavCompass({ mapHeading, headingUp, onNorthUp, onHeadingUp }) {
  const lastTapRef = useRef(0)

  // Only show when map is meaningfully rotated away from North
  if (!headingUp || mapHeading == null) return null
  const normalised = ((mapHeading % 360) + 360) % 360
  if (normalised < 5 || normalised > 355) return null

  function handleTap() {
    const now = Date.now()
    if (now - lastTapRef.current < DOUBLE_TAP_MS) {
      onHeadingUp?.()   // double-tap: resume heading-up
    } else {
      onNorthUp?.()     // single tap: north-up
    }
    lastTapRef.current = now
  }

  // The compass needle should point toward geographic North.
  // If the map has been rotated by `mapHeading` degrees (heading-up),
  // North is now at -mapHeading degrees from "up" on screen.
  const northAngle = -normalised

  return (
    <button
      className="nav-compass"
      onClick={handleTap}
      aria-label="Tap for North-Up. Double-tap to resume Heading-Up."
      title="Tap: North-Up  ·  Double-tap: Heading-Up"
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
        {/* North half — red */}
        <path d="M15 3 L12 15 L15 13 L18 15 Z" fill="#E53E3E" />
        {/* South half — light grey */}
        <path d="M15 27 L12 15 L15 17 L18 15 Z" fill="#CBD5E0" />
        {/* Centre pivot */}
        <circle cx="15" cy="15" r="2.5" fill="white" stroke="#E53E3E" strokeWidth="1.5" />
      </svg>
      <span className="nav-compass-n">N</span>
    </button>
  )
}
