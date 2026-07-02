/**
 * useNavCamera — heading fusion + smoothing for premium, Google-Maps-style
 * navigation (Phase 4A, overhauled Phase 4.2.4 Priority 2).
 *
 * Fuses two heading sources and applies several filtering stages before
 * anything reaches the map/marker, instead of reacting to every raw
 * magnetometer sample:
 *
 *   1. GPS course preference — while walking at a real pace, prefers the
 *      Geolocation API's own course-over-ground (coords.heading) over the
 *      phone's magnetometer. GPS course is immune to magnetic
 *      interference and far steadier at walking speed; the compass only
 *      takes over when stationary or GPS course is unavailable.
 *   2. Stationary lock — below walking speed, heading updates freeze
 *      entirely rather than following magnetometer drift from a phone
 *      that's sitting still (or barely moving).
 *   3. Dead-zone filtering — raw deltas under DEAD_ZONE_DEG are ignored
 *      outright. This is also what absorbs ordinary wrist movement while
 *      holding the phone walking — small sub-threshold wobble never
 *      reaches the smoother at all.
 *   4. Magnetic spike rejection — a single compass reading that jumps
 *      further than SPIKE_DEG from the current smoothed value is treated
 *      as interference (lift motors, speaker magnets, a passing vehicle)
 *      and dropped, UNLESS the very next reading confirms the same
 *      direction, in which case it's accepted as a genuine fast turn.
 *      Doesn't apply to GPS course, which isn't susceptible to this.
 *   5. Adaptive low-pass smoothing — small deltas get heavy damping for a
 *      steady, settled feel; larger deltas (real turns) get a snappier
 *      response so the map doesn't feel laggy mid-turn.
 *
 * Returns two heading values:
 *  smoothedHeading — fine-grained (updates > 1.5°), used for the user marker arrow
 *  mapHeading      — coarse-grained (updates > 4°), used for map rotation
 *
 * Animated rotation itself (interpolating between mapHeading updates) is
 * handled by a CSS transition on .leaflet-rotate-pane (index.css) — the
 * pane leaflet-rotate physically rotates — rather than here, so a plain
 * setBearing() call already eases smoothly between values.
 */
import { useEffect, useRef, useState } from 'react'

// Dead-zone — ignore raw deltas smaller than this entirely. Also what
// absorbs ordinary wrist wobble while walking with the phone in hand.
const DEAD_ZONE_DEG = 6

// Adaptive low-pass bounds. Small changes get heavy smoothing (settles a
// full 180° reversal in a few seconds); large/fast changes get a snappier
// response so a genuine turn doesn't feel like the map is lagging behind.
const ALPHA_MIN = 0.08
const ALPHA_MAX = 0.35
const ALPHA_RAMP_DEG = 45 // delta at/above which alpha saturates to ALPHA_MAX

// Magnetic spike rejection (compass path only) — a jump bigger than this
// is assumed to be interference unless a second reading within 1.5s
// confirms roughly the same new direction.
const SPIKE_DEG = 55
const SPIKE_CONFIRM_WINDOW_MS = 1500
const SPIKE_CONFIRM_TOLERANCE_DEG = 20

// Stationary lock — below this speed (m/s), freeze heading updates
// entirely rather than following magnetometer noise from a phone that's
// sitting still or barely moving. ~0.35 m/s is well below walking pace.
const STATIONARY_SPEED_MS = 0.35

// Minimum angular change to push a React state update
const MARKER_UPDATE_DEG = 1.5   // user arrow
const MAP_UPDATE_DEG    = 4     // map rotation (heavier)

/** Signed shortest angular distance from a → b in [-180, +180] */
function circDiff(a, b) {
  let d = ((b - a) % 360 + 360) % 360
  if (d > 180) d -= 360
  return d
}

/**
 * @param {number|null} rawHeading  Magnetometer compass heading 0-360 (0 = North)
 * @param {boolean}     active      True during active heading-up navigation
 * @param {{gpsCourse?: number|null, speed?: number|null}} [fusion]
 *        gpsCourse — Geolocation course-over-ground, already gated to
 *        "only present while moving at a trustable pace" by LocationProvider.
 *        speed — current GPS speed in m/s, drives the stationary lock.
 */
export function useNavCamera(rawHeading, active, fusion = {}) {
  const { gpsCourse = null, speed = null } = fusion
  const [smoothedHeading, setSmoothedHeading] = useState(null)
  const [mapHeading,      setMapHeading]      = useState(null)

  // Internal refs — live in between renders without causing re-renders
  const smoothRef       = useRef(null)  // current smoothed value
  const displayRef      = useRef(null)  // last value pushed to setSmoothedHeading
  const mapRef           = useRef(null)  // last value pushed to setMapHeading
  const pendingSpikeRef  = useRef(null)  // { value, at } — a rejected reading awaiting confirmation

  useEffect(() => {
    if (!active) {
      // Clear everything when heading-up navigation is inactive
      smoothRef.current      = null
      displayRef.current     = null
      mapRef.current         = null
      pendingSpikeRef.current = null
      setSmoothedHeading(null)
      setMapHeading(null)
      return
    }

    // ── Stationary lock ─────────────────────────────────────────────────
    // Freeze at whatever heading we already have rather than following
    // compass drift from a phone that isn't really moving.
    if (speed != null && speed < STATIONARY_SPEED_MS) return

    // ── Source fusion: prefer GPS course while walking ─────────────────
    const usingGpsCourse = gpsCourse != null
    const source = usingGpsCourse ? gpsCourse : rawHeading
    if (source == null) return

    const prev = smoothRef.current

    if (prev == null) {
      // Seed both outputs immediately so the marker/map don't sit blank
      // waiting for a second sample.
      smoothRef.current  = source
      displayRef.current = source
      mapRef.current     = source
      setSmoothedHeading(source)
      setMapHeading(source)
      return
    }

    const diff    = circDiff(prev, source)
    const absDiff = Math.abs(diff)

    // ── Dead-zone (also covers ordinary wrist movement) ─────────────────
    if (absDiff < DEAD_ZONE_DEG) return

    // ── Magnetic spike rejection (compass path only — GPS course isn't
    //    susceptible to magnetic interference) ──────────────────────────
    if (!usingGpsCourse && absDiff > SPIKE_DEG) {
      const pending = pendingSpikeRef.current
      const now = Date.now()
      const confirmed = pending &&
        now - pending.at < SPIKE_CONFIRM_WINDOW_MS &&
        Math.abs(circDiff(pending.value, source)) < SPIKE_CONFIRM_TOLERANCE_DEG
      if (confirmed) {
        pendingSpikeRef.current = null // genuine fast turn — fall through and accept it
      } else {
        pendingSpikeRef.current = { value: source, at: now }
        return // treat as interference — wait for a confirming second reading
      }
    } else {
      pendingSpikeRef.current = null
    }

    // ── Adaptive low-pass (EMA on the unit circle) ──────────────────────
    const t     = Math.min(1, absDiff / ALPHA_RAMP_DEG)
    const alpha = ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * t
    const cur   = ((prev + alpha * diff) + 360) % 360
    smoothRef.current = cur

    // ── Marker update (fine) ────────────────────────────────────────────
    const mDiff = displayRef.current == null
      ? 999
      : Math.abs(circDiff(displayRef.current, cur))
    if (mDiff >= MARKER_UPDATE_DEG) {
      displayRef.current = cur
      setSmoothedHeading(cur)
    }

    // ── Map rotation update (coarse) ─────────────────────────────────────
    const rDiff = mapRef.current == null
      ? 999
      : Math.abs(circDiff(mapRef.current, cur))
    if (rDiff >= MAP_UPDATE_DEG) {
      mapRef.current = cur
      setMapHeading(cur)
    }
  }, [rawHeading, active, gpsCourse, speed])

  return { smoothedHeading, mapHeading }
}
