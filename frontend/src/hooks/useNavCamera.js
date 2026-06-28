/**
 * useNavCamera — heading smoothing for Phase 4A premium navigation.
 *
 * Applies exponential moving average on the unit circle to eliminate
 * compass jitter while remaining responsive to genuine direction changes.
 *
 * Returns two heading values:
 *  smoothedHeading — fine-grained (updates > 1.5°), used for the user marker arrow
 *  mapHeading      — coarse-grained (updates > 4°), used for map rotation to avoid
 *                    micro-oscillations that make the map feel unstable
 */
import { useEffect, useRef, useState } from 'react'

// EMA factor — lower = smoother + slower to respond
// 0.10 settles a 90° turn in ~2 s which feels natural at walking speed
const ALPHA = 0.10

// Minimum angular change to push a React state update
const MARKER_UPDATE_DEG = 1.5   // user arrow
const MAP_UPDATE_DEG    = 4     // map rotation (heavier)

// Ignore raw readings smaller than this to suppress stationary jitter
const JITTER_DEG = 0.8

/** Signed shortest angular distance from a → b in [-180, +180] */
function circDiff(a, b) {
  let d = ((b - a) % 360 + 360) % 360
  if (d > 180) d -= 360
  return d
}

/**
 * @param {number|null} rawHeading  Compass heading 0-360 (0 = North)
 * @param {boolean}     active      True during active heading-up navigation
 */
export function useNavCamera(rawHeading, active) {
  const [smoothedHeading, setSmoothedHeading] = useState(null)
  const [mapHeading,      setMapHeading]      = useState(null)

  // Internal refs — live in between renders without causing re-renders
  const smoothRef  = useRef(null)  // current smoothed value
  const displayRef = useRef(null)  // last value pushed to setSmoothedHeading
  const mapRef     = useRef(null)  // last value pushed to setMapHeading

  useEffect(() => {
    if (!active) {
      // Clear everything when heading-up navigation is inactive
      smoothRef.current  = null
      displayRef.current = null
      mapRef.current     = null
      setSmoothedHeading(null)
      setMapHeading(null)
      return
    }

    if (rawHeading == null) return

    // ── EMA on unit circle ─────────────────────────────────────────────
    const prev = smoothRef.current
    let cur

    if (prev == null) {
      cur = rawHeading                        // seed: no smoothing
    } else {
      const diff = circDiff(prev, rawHeading)
      if (Math.abs(diff) < JITTER_DEG) return // suppress noise
      cur = ((prev + ALPHA * diff) + 360) % 360
    }
    smoothRef.current = cur

    // ── Marker update (fine) ───────────────────────────────────────────
    const mDiff = displayRef.current == null
      ? 999
      : Math.abs(circDiff(displayRef.current, cur))
    if (mDiff >= MARKER_UPDATE_DEG) {
      displayRef.current = cur
      setSmoothedHeading(cur)
    }

    // ── Map rotation update (coarse) ───────────────────────────────────
    const rDiff = mapRef.current == null
      ? 999
      : Math.abs(circDiff(mapRef.current, cur))
    if (rDiff >= MAP_UPDATE_DEG) {
      mapRef.current = cur
      setMapHeading(cur)
    }
  }, [rawHeading, active])

  return { smoothedHeading, mapHeading }
}
