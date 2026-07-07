/**
 * useNavCamera — heading fusion for premium, STABLE navigation
 * (Phase 4A → overhauled Phase 4.2.6 Priority 2).
 *
 * Phase 4.2.4/4.2.5 versions continuously re-smoothed the map heading
 * toward every new sample (compass or GPS course) — reacting to almost
 * every update made the whole map feel like it was constantly re-settling,
 * even while walking in a straight line. For a campus navigation app,
 * feeling CALM matters more than tracking every sensor twitch.
 *
 * This version separates two very different jobs:
 *
 *  - smoothedHeading (marker arrow): a light, continuous EMA. A small
 *    arrow on the user's own dot subtly correcting itself is normal and
 *    not what "jittery navigation" means — this stays reactive.
 *
 *  - mapHeading (the whole map's rotation): a COMMIT/CONFIDENCE/COOLDOWN
 *    state machine, not a continuous filter. The map only actually
 *    rotates when there's real, sustained evidence of a genuine direction
 *    change — everything short of that leaves the map exactly where it
 *    is, however much the raw sensor wobbles underneath.
 *
 * Pipeline, in order:
 *   1. GPS course preference — while walking at a real pace, the
 *      Geolocation API's own course-over-ground is used instead of the
 *      magnetometer. It isn't just "steadier" than a compass, it's a
 *      fundamentally different, much higher-confidence measurement
 *      (derived from consecutive real positions, immune to magnetic
 *      interference), so it's always treated as high-confidence.
 *   2. Stationary lock — below walking speed, freeze outright.
 *   3. Impossible-jump rejection — a single compass sample that jumps a
 *      huge amount in one tick is interference, not a real turn, unless a
 *      second reading confirms it.
 *   4. Rolling-window confidence — recent samples are kept in a short
 *      time-window buffer; their circular spread IS the confidence
 *      signal. Tight agreement (holding a direction, or smoothly turning)
 *      = confident. Scattered samples (wrist movement, hand shake, noise)
 *      = not confident, and low-confidence readings never move the map,
 *      full stop.
 *   5. Rotation threshold — even a confident estimate only commits once
 *      it has drifted ~18° from the map's CURRENT rotation — small
 *      fluctuations under that never touch the map at all.
 *   6. Cooldown — after any commit, further commits are held off briefly
 *      so one genuine turn can't cause a flurry of re-adjustments.
 *      Bypassed when the route says a turn is imminent (nextTurnDist),
 *      so the map isn't throttled at exactly the moment it needs to
 *      respond.
 *
 * Animated interpolation between committed values is handled by a CSS
 * transition on .leaflet-rotate-pane (index.css) — leaflet-rotate
 * physically rotates that pane, so a plain setBearing() call already
 * eases smoothly between committed headings.
 */
import { useEffect, useRef, useState } from 'react'

// ── Marker arrow (continuous, lightweight) ──────────────────────────────
const MARKER_DEAD_ZONE_DEG   = 6
const MARKER_ALPHA           = 0.15
const MARKER_UPDATE_DEG      = 1.5

// ── Map rotation (commit/confidence/cooldown) ───────────────────────────
// Only commit once the estimate has drifted this far from the map's
// CURRENT rotation — small fluctuations never touch the map at all.
const ROTATE_THRESHOLD_DEG = 18

// Minimum time between two committed rotations, so a single genuine turn
// can't cause a flurry of re-adjustments as it settles.
const COOLDOWN_MS = 1200
// When a turn is this close, bypass the cooldown — the map shouldn't be
// throttled at exactly the moment it needs to respond to a real turn.
const IMMINENT_TURN_M = 12

// Rolling confidence window — recent samples (within this time window)
// must agree within CONFIDENCE_MAX_SPREAD_DEG of each other, or the
// reading is treated as unreliable and never rotates the map.
const CONFIDENCE_WINDOW_MS       = 1800
const CONFIDENCE_MAX_SPREAD_DEG  = 32
const CONFIDENCE_MIN_SAMPLES     = 3

// A single compass sample jumping more than this in one tick is treated
// as interference (lift motors, speaker magnets, a passing vehicle), not
// a real turn — unless a second reading confirms roughly the same new
// direction shortly after. GPS course isn't susceptible to this at all.
const IMPOSSIBLE_JUMP_DEG          = 100
const JUMP_CONFIRM_WINDOW_MS       = 1500
const JUMP_CONFIRM_TOLERANCE_DEG   = 20

// Stationary lock — below this speed (m/s), freeze everything rather than
// follow magnetometer noise from a phone that's sitting still.
const STATIONARY_SPEED_MS = 0.35

// How long to wait, right after navigation activates, for real speed/GPS-
// course telemetry before falling back to the confidence-buffer alone.
// Long enough to skip the "phone still settling in your hand" moment right
// after Start Navigation (avoids seeding the very first heading commit
// from a single raw compass sample at exactly the moment phone-orientation
// jitter is most noticeable); short enough that a device which simply
// never reports speed/course doesn't stay frozen on North-Up for the
// whole walk — after this window, it falls through to the same
// confidence-buffer gate every later compass reading already has to pass.
const NO_TELEMETRY_GRACE_MS = 4000

/** Signed shortest angular distance from a → b in [-180, +180] */
export function circDiff(a, b) {
  let d = ((b - a) % 360 + 360) % 360
  if (d > 180) d -= 360
  return d
}

/** Circular mean of a list of headings (degrees) */
function circMean(values) {
  let sumX = 0, sumY = 0
  for (const v of values) {
    const r = v * Math.PI / 180
    sumX += Math.cos(r)
    sumY += Math.sin(r)
  }
  return (Math.atan2(sumY, sumX) * 180 / Math.PI + 360) % 360
}

/** Max circular deviation of any sample in the list from the mean — the
 *  confidence signal. Tight agreement → small spread → confident. */
function circSpread(values, mean) {
  let max = 0
  for (const v of values) {
    const d = Math.abs(circDiff(mean, v))
    if (d > max) max = d
  }
  return max
}

/**
 * @param {number|null} rawHeading  Magnetometer compass heading 0-360 (0 = North)
 * @param {boolean}     active      True during active heading-up navigation
 * @param {{gpsCourse?: number|null, speed?: number|null, nextTurnDist?: number|null}} [fusion]
 *        gpsCourse — Geolocation course-over-ground (LocationProvider
 *        already gates this to "only present while moving at a
 *        trustable pace"). speed — current GPS speed in m/s. nextTurnDist
 *        — metres to the upcoming turn, used to bypass the cooldown when
 *        a turn is imminent.
 */
export function useNavCamera(rawHeading, active, fusion = {}) {
  const { gpsCourse = null, speed = null, nextTurnDist = null } = fusion
  const [smoothedHeading, setSmoothedHeading] = useState(null)
  const [mapHeading,      setMapHeading]      = useState(null)

  // Marker (continuous EMA) internals
  const markerRef        = useRef(null)
  const markerDisplayRef = useRef(null)

  // Map rotation (commit/confidence/cooldown) internals
  const committedRef   = useRef(null)   // last value actually sent to the map
  const bufferRef       = useRef([])     // [{ value, at }] recent samples for confidence
  const lastCommitAtRef = useRef(0)
  const pendingJumpRef  = useRef(null)   // { value, at } — a rejected impossible jump awaiting confirmation
  const navActivatedAtRef = useRef(0)    // when this activation began — for the no-telemetry grace window

  useEffect(() => {
    if (!active) {
      markerRef.current = null
      markerDisplayRef.current = null
      committedRef.current = null
      bufferRef.current = []
      lastCommitAtRef.current = 0
      pendingJumpRef.current = null
      navActivatedAtRef.current = 0
      setSmoothedHeading(null)
      setMapHeading(null)
      return
    }

    const now = Date.now()

    // ── Stationary lock ────────────────────────────────────────────────
    if (speed != null && speed < STATIONARY_SPEED_MS) return

    // Priority 2 (Phase 4.2.7) — right after navigation starts, hold off
    // seeding the very first heading commit from a bare, unconfirmed
    // compass sample for a short grace window while waiting to see if
    // real speed/GPS-course telemetry shows up (see NO_TELEMETRY_GRACE_MS
    // above for why). Only applies before anything has been committed
    // yet, and only for that short window — never re-freezes an already-
    // established orientation, and never blocks permanently on a device
    // that simply doesn't report speed.
    if (navActivatedAtRef.current === 0) navActivatedAtRef.current = now
    if (
      committedRef.current == null &&
      speed == null && gpsCourse == null &&
      now - navActivatedAtRef.current < NO_TELEMETRY_GRACE_MS
    ) return

    const usingGpsCourse = gpsCourse != null
    const source = usingGpsCourse ? gpsCourse : rawHeading
    if (source == null) return

    // ═══ Marker arrow — light continuous smoothing (unchanged philosophy,
    //     this is NOT the thing that made navigation feel jittery) ═══════
    {
      const prev = markerRef.current
      if (prev == null) {
        markerRef.current = source
        markerDisplayRef.current = source
        setSmoothedHeading(source)
      } else {
        const diff = circDiff(prev, source)
        if (Math.abs(diff) >= MARKER_DEAD_ZONE_DEG) {
          const cur = ((prev + MARKER_ALPHA * diff) + 360) % 360
          markerRef.current = cur
          if (Math.abs(circDiff(markerDisplayRef.current, cur)) >= MARKER_UPDATE_DEG) {
            markerDisplayRef.current = cur
            setSmoothedHeading(cur)
          }
        }
      }
    }

    // ═══ Map rotation — commit/confidence/cooldown ═════════════════════

    // Impossible-jump rejection (compass path only — GPS course can't
    // suffer magnetic interference the same way).
    if (!usingGpsCourse && committedRef.current != null) {
      const jump = Math.abs(circDiff(committedRef.current, source))
      if (jump > IMPOSSIBLE_JUMP_DEG) {
        const pending = pendingJumpRef.current
        const confirmed = pending &&
          now - pending.at < JUMP_CONFIRM_WINDOW_MS &&
          Math.abs(circDiff(pending.value, source)) < JUMP_CONFIRM_TOLERANCE_DEG
        if (!confirmed) {
          pendingJumpRef.current = { value: source, at: now }
          return // discard — treat as interference until confirmed
        }
        pendingJumpRef.current = null
      } else {
        pendingJumpRef.current = null
      }
    }

    // Roll the confidence window forward: drop stale samples, add this one.
    const buffer = bufferRef.current.filter(s => now - s.at < CONFIDENCE_WINDOW_MS)
    buffer.push({ value: source, at: now })
    bufferRef.current = buffer

    if (committedRef.current == null) {
      // First-ever reading — seed immediately so the map isn't blank
      // waiting for a confidence window to fill.
      committedRef.current = source
      lastCommitAtRef.current = now
      setMapHeading(source)
      return
    }

    // GPS course readings are inherently high-confidence (derived from
    // real consecutive positions, not a noisy instantaneous sensor) — skip
    // the agreement check. Compass readings need the buffer to agree.
    let confident = usingGpsCourse
    let estimate = source
    if (!usingGpsCourse) {
      if (buffer.length < CONFIDENCE_MIN_SAMPLES) return // not enough data yet — wait
      const mean = circMean(buffer.map(s => s.value))
      const spread = circSpread(buffer.map(s => s.value), mean)
      confident = spread <= CONFIDENCE_MAX_SPREAD_DEG
      estimate = mean
    }
    if (!confident) return // scattered readings — never rotates the map

    const driftFromCommitted = Math.abs(circDiff(committedRef.current, estimate))
    if (driftFromCommitted < ROTATE_THRESHOLD_DEG) return // hasn't genuinely changed enough yet

    const turnImminent = nextTurnDist != null && nextTurnDist <= IMMINENT_TURN_M
    const cooldownElapsed = now - lastCommitAtRef.current >= COOLDOWN_MS
    if (!turnImminent && !cooldownElapsed) return // genuine change, but let the last rotation settle first

    committedRef.current = estimate
    lastCommitAtRef.current = now
    setMapHeading(estimate)
  }, [rawHeading, active, gpsCourse, speed, nextTurnDist])

  return { smoothedHeading, mapHeading }
}
