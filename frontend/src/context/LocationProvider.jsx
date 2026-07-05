/**
 * LocationProvider — single source of truth for "where is the user" across
 * the whole app.
 *
 * This replaces the old `hooks/useUserLocation.js`. The public API it
 * exposes (position, accuracy, tracking, error, remainingPath, remainingDist,
 * liveEta, guidance, offRoute, start, stop, setRoute, clearRoute) is
 * unchanged from that hook, so production behaviour and every consuming
 * component (Home.jsx, MapView.jsx) work exactly as before.
 *
 * What's new is a second, parallel input source: simulated coordinates,
 * used by <DevLocationPanel />. Both the real GPS watcher and the simulated
 * source feed the *same* processPosition() pipeline below, so off-route
 * detection, ETA, remaining distance and arrival announcements behave
 * identically regardless of where the coordinates came from — there is no
 * separate "fake" copy of this logic to maintain or get out of sync.
 *
 * Dev mode itself (the panel, and the simulation controls below) is only
 * ever active when `devModeAvailable` is true: VITE_DEV_MODE=true, or the
 * app is running on localhost/127.0.0.1. It has no effect in a normal
 * production deployment.
 *
 * (The context object + useLocationContext() hook live in
 * LocationContext.js, not here, so this file only exports a component —
 * that keeps Vite's Fast Refresh happy.)
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { LocationContext } from './LocationContext'
import { pathLength, nearestIndex, destinationPoint, pointAtDistanceAlongPath } from '../utils/geo'
import { getRouteFromCoords } from '../api'

const ANNOUNCE_THRESHOLDS = [200, 100, 50, 20] // metres from destination
// Hysteresis on off-route detection: flag off-route only once past
// OFF_ROUTE_ENTER_M, and don't clear it again until back within
// OFF_ROUTE_CLEAR_M. A single shared threshold meant GPS jitter right at
// that boundary could flip the flag back and forth on every tick, which
// would re-trigger the off-route voice announcement repeatedly even
// though the user hadn't really left and rejoined the route.
// Phase 2 — corrected thresholds per spec:
// Deviation < 15m → stay on route  |  Deviation > 20m → recalculate
const OFF_ROUTE_ENTER_M = 20
const OFF_ROUTE_CLEAR_M = 15
const AUTO_WALK_STEP_M = 15      // metres advanced per auto-walk tick
const AUTO_WALK_INTERVAL_MS = 1000
const OFF_ROUTE_TEST_DISTANCE_M = 80
const DEFAULT_SIM_POSITION = { lat: 12.75137, lng: 80.204085 } // main-gate
const SIMULATED_ACCURACY_M = 5

// --- Feature 1: automatic route recalculation ---
// ── GPS accuracy policy ──────────────────────────────────────────────────
// HARD_REJECT_M : any reading worse than this is thrown away entirely —
//   never updates position or accuracy state.  ±1000m means the browser
//   is still on cell-tower triangulation and has no idea where the user is.
const GPS_HARD_REJECT_M       = 1000
// SOFT_REPLACE_M : once we have a position with accuracy better than this,
//   we only replace it with a reading that is ALSO better than this AND
//   not significantly worse than the current best.
//   Prevents a good 12m fix being overwritten by a 500m "regression" reading.
const GPS_SOFT_REPLACE_M      = 150
// ACQUIRING_THRESHOLD_M : below this the dot turns green and route logic activates.
const GPS_ACCURACY_THRESHOLD_M = 50
// POSITION_AGE_MS : after this many ms without any update we consider the
//   position stale and re-enter acquiring mode even if accuracy was good.
const GPS_POSITION_MAX_AGE_MS = 30000

const RECALC_COOLDOWN_MS = 4000      // Phase 2: 3-5 second cooldown per spec
const RECALC_MIN_REMAINING_M = 15    // don't bother rerouting if basically already there

// Priority 2 (Phase 4.2.4) — Geolocation's `coords.heading` (course over
// ground) is only meaningful once you're actually moving; standing still
// it's frequently null or wildly noisy. ~1.1 m/s is a slow-walk pace —
// comfortably below normal walking speed (~1.4 m/s) so it engages
// promptly on setting off, but well above GPS jitter noise while
// stationary (a stationary phone can show spurious "drift" of a few
// cm/s between fixes, never sustained above this).
const GPS_COURSE_MIN_SPEED_MS = 1.1

function isDevModeAvailable() {
  if (import.meta.env.VITE_DEV_MODE === 'true') return true
  if (typeof window !== 'undefined') {
    const host = window.location.hostname
    if (host === 'localhost' || host === '127.0.0.1') return true
  }
  return false
}

export function LocationProvider({ children }) {
  // --- Public, pre-existing state (unchanged shape from useUserLocation) ---
  const [position, setPosition]           = useState(null)
  const [accuracy, setAccuracy]            = useState(null)
  // Priority 2 (Phase 4.2.4) — Geolocation API's own speed/course-over-
  // ground, previously read from watchPosition() but discarded entirely.
  // useNavCamera prefers `gpsCourse` over the magnetometer while walking
  // (far more stable at walking pace than a phone's compass), falling
  // back to the compass when stationary or course is unavailable.
  const [speed, setSpeed]                 = useState(null)   // m/s, null = unknown
  const [gpsCourse, setGpsCourse]         = useState(null)   // degrees 0-360, null = not moving fast enough to trust it
  // Phase 9 (Q7): dynamic arrival radius — max(15m, GPS_accuracy)
  const [arrivalRadius, setArrivalRadius]  = useState(20)
  const [acquiringGps, setAcquiringGps]     = useState(false) // true until first accurate fix
  const [tracking, setTracking]            = useState(false)
  const [error, setError]                  = useState(null)
  // Priority 11 (Phase 4.2.7): distinguishes "permission denied" from any
  // other GPS error (timeout, position unavailable, etc.) so the UI can
  // show a specific, actionable prompt instead of a generic error string.
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [remainingPath, setRemainingPath]  = useState(null)
  const [remainingDist, setRemainingDist]  = useState(null)
  const [liveEta, setLiveEta]              = useState(null)
  const [guidance, setGuidance]            = useState(null)
  const [offRoute, setOffRoute]            = useState(false)
  const [hasRoute, setHasRoute]            = useState(false)

  // --- Feature 1: automatic recalculation state ---
  // fullPath/fullDistance/fullEta mirror routeRef.current — the *current*
  // full route (not the remaining slice). They start out equal to whatever
  // was passed to setRoute(), and are replaced wholesale whenever a
  // recalculation succeeds, so any consumer (e.g. Home.jsx's background
  // route line) that wants "the route as it stands right now" can read
  // these instead of keeping its own now-stale copy of the original path.
  const [fullPath, setFullPath]           = useState(null)
  const [fullDistance, setFullDistance]   = useState(null)
  const [fullEta, setFullEta]             = useState(null)
  const [recalculating, setRecalculating] = useState(false)
  const [recalcVersion, setRecalcVersion] = useState(0)
  const [activeDestination, setActiveDestination] = useState(null) // {lat,lng,id} — state mirror of destRef, safe to read during render

  // --- Dev-mode-only state ---
  const [useSimulatedGPS, setUseSimulatedGPS] = useState(false)
  const [simPosition, setSimPosition]         = useState(null)
  const [autoWalking, setAutoWalking]         = useState(false)
  const devModeAvailable = isDevModeAvailable()

  const watchId         = useRef(null)
  const routeRef         = useRef(null)  // full path for the current route
  const destRef           = useRef(null) // {lat,lng,id} of current destination
  const announced        = useRef(new Set())
  const autoWalkTimer    = useRef(null)
  const walkedMetersRef  = useRef(0)
  const simPositionRef   = useRef(null)  // mirrors simPosition for sync reads
  const recalculatingRef = useRef(false) // guards against overlapping reroute requests
  const lastRecalcAtRef  = useRef(0)     // Date.now() of the last reroute attempt (cooldown)
  // Mirrors `offRoute` state for synchronous reads inside processPosition,
  // which is a stable useCallback (deps: [maybeRecalculate]) — reading the
  // `offRoute` state variable directly there would close over a stale
  // value instead of the current one, since recreating processPosition on
  // every offRoute change would also cascade into recreating
  // startRealWatch/start/etc. Kept in sync everywhere setOffRoute(...) is
  // called.
  const offRouteRef      = useRef(false)
  // Latches true once accuracy < GPS_ACCURACY_THRESHOLD_M. Never resets mid-session
  // so a temporary accuracy dip doesn't re-enter "acquiring" and suppress off-route detection.
  const goodFixReceivedRef  = useRef(false)
  // Tracks the best accuracy value seen this session (lower = better).
  // Used to reject readings that are much worse than what we already have.
  const bestAccuracyRef     = useRef(null)
  // Timestamp of the last accepted GPS fix — used to detect stale positions.
  const lastPositionAtRef   = useRef(null)

  // ---------------------------------------------------------------------
  // Feature 1 — automatic route recalculation when off-route.
  // ---------------------------------------------------------------------
  // Deliberately takes the live GPS point + the freshly-computed remaining
  // distance as plain arguments (rather than reading state) so this stays
  // a stable, dependency-free callback — it never needs to be recreated,
  // which in turn keeps processPosition's identity stable too.
  const maybeRecalculate = useCallback((lat, lng, currentRemainingM) => {
    if (!destRef.current?.id) return                 // need a routable destination id
    if (recalculatingRef.current) return              // a reroute is already in flight
    if (currentRemainingM != null && currentRemainingM < RECALC_MIN_REMAINING_M) return
    const now = Date.now()
    if (now - lastRecalcAtRef.current < RECALC_COOLDOWN_MS) return // avoid recalculation loops

    recalculatingRef.current = true
    lastRecalcAtRef.current  = now
    setRecalculating(true)

    getRouteFromCoords(lat, lng, destRef.current.id)
      .then((r) => {
        routeRef.current  = r.path
        announced.current = new Set() // fresh route -> distance thresholds can fire again
        setRemainingPath(r.path)
        setRemainingDist(Math.round(r.distance_m))
        setLiveEta(r.eta_minutes)
        setFullPath(r.path)
        setFullDistance(r.distance_m)
        setFullEta(r.eta_minutes)
        setRecalcVersion((v) => v + 1)
        offRouteRef.current = false
        setOffRoute(false)
        setGuidance('✅ Route recalculated')
        setTimeout(() => setGuidance(null), 2500)
      })
      .catch(() => {
        // Couldn't reach the routing API — leave the off-route state as is;
        // the next GPS tick will retry automatically once the cooldown passes.
      })
      .finally(() => {
        recalculatingRef.current = false
        setRecalculating(false)
      })
  }, [])

  // ---------------------------------------------------------------------
  // Shared processing pipeline — both real and simulated positions land
  // here. This is identical to the old useUserLocation's onPosition().
  // ---------------------------------------------------------------------
  const processPosition = useCallback((lat, lng, acc, speedMS = null, courseDeg = null) => {
    const accuracyM = acc ?? null
    const now = Date.now()

    // ── HARD REJECT ────────────────────────────────────────────────────────
    // Throw away any reading that is wildly inaccurate (e.g. ±50 000m).
    // These come from cell-tower or cached network positioning and tell us
    // nothing useful. We never update state from them.
    if (accuracyM !== null && accuracyM > GPS_HARD_REJECT_M) {
      // Still update the accuracy display so the user sees "Low GPS signal"
      setAccuracy(accuracyM)
      setAcquiringGps(true)
      return  // ← discard the coordinates entirely
    }

    // ── SOFT REJECT ────────────────────────────────────────────────────────
    // If we already have a good position and this reading is significantly
    // worse, keep the existing position.  Prevents a 12m fix being
    // overwritten by a 500m regression from a momentary network blip.
    const currentBest = bestAccuracyRef.current
    if (
      accuracyM !== null &&
      accuracyM > GPS_SOFT_REPLACE_M &&       // new reading is coarse
      currentBest !== null &&
      currentBest < GPS_SOFT_REPLACE_M &&     // existing fix is good
      accuracyM > currentBest * 2             // and noticeably worse
    ) {
      // Update displayed accuracy so the pill shows the regression,
      // but DO NOT move the dot.
      setAccuracy(accuracyM)
      setAcquiringGps(true)
      return  // ← keep existing position
    }

    // ── ACCEPT ─────────────────────────────────────────────────────────────
    if (accuracyM !== null) {
      if (bestAccuracyRef.current === null || accuracyM < bestAccuracyRef.current) {
        bestAccuracyRef.current = accuracyM
      }
    }
    lastPositionAtRef.current = now

    const isAcquiring = !goodFixReceivedRef.current &&
                        accuracyM !== null &&
                        accuracyM > GPS_ACCURACY_THRESHOLD_M
    if (!isAcquiring) goodFixReceivedRef.current = true

    // Store TRUE GPS coordinate — never snapped, never adjusted.
    setPosition({ lat, lng })
    setAccuracy(accuracyM)
    setAcquiringGps(isAcquiring)

    // Priority 2 — only trust course-over-ground while actually walking;
    // a valid-looking `heading` at near-zero speed is usually stale/noise
    // from the last time the device was moving, not a real bearing.
    setSpeed(speedMS)
    setGpsCourse(
      speedMS != null && speedMS > GPS_COURSE_MIN_SPEED_MS &&
      courseDeg != null && !Number.isNaN(courseDeg)
        ? courseDeg
        : null
    )

    if (!routeRef.current?.length) return

    // Suppress route logic while GPS is still acquiring to avoid false
    // off-route detection and reroutes from a bad initial cell/WiFi fix.
    if (isAcquiring) return

    // Internal routing calculations can use the snapped position if needed,
    // but the public `position` state must remain the raw GPS coordinate.
    const { index, distance: distFromPath } = nearestIndex(lat, lng, routeRef.current)
    // Hysteresis: which threshold applies depends on the *current* state,
    // read from the ref (not the `offRoute` state value, which would be
    // stale inside this stable callback).
    const isOffRoute = offRouteRef.current
      ? distFromPath > OFF_ROUTE_CLEAR_M  // already off-route: stay off-route until back within 40m
      : distFromPath > OFF_ROUTE_ENTER_M  // currently on-route: only flag once beyond 60m
    offRouteRef.current = isOffRoute

    if (isOffRoute) {
      setOffRoute(true)
      setGuidance('⚠️ Off route detected — recalculating route…')
    } else {
      setOffRoute(false)
    }

    const remaining = routeRef.current.slice(index)
    setRemainingPath(remaining)

    const remDist = pathLength(remaining)
    setRemainingDist(Math.round(remDist))
    setLiveEta(Math.round((remDist / 1.4 / 60) * 10) / 10)

    if (isOffRoute) {
      maybeRecalculate(lat, lng, remDist)
    }

    // Phase 9 (Q7): dynamic arrival — uses max(15m, GPS accuracy)
    const arrivalM = Math.max(15, Math.min(acc ?? 15, 50))
    const dynamicThresholds = [200, 100, 50, arrivalM]
    for (const threshold of dynamicThresholds) {
      if (remDist <= threshold && !announced.current.has(threshold)) {
        announced.current.add(threshold)
        const isArrival = threshold <= 20 || threshold === arrivalM && remDist <= arrivalM
        const msg = isArrival ? '🎯 You have arrived!' : `📍 ${Math.round(threshold)}m from destination`
        setGuidance(msg)
        setTimeout(() => setGuidance(null), 4000)
        if (isArrival) setArrivalRadius(arrivalM)  // expose for Home.jsx
        break
      }
    }
  }, [maybeRecalculate])

  /** Set the simulated position AND run it through the shared pipeline,
   *  in one synchronous call — not via a watching effect, so there's no
   *  extra render cycle and no risk of effect-ordering surprises. */
  const applySimulatedPosition = useCallback((pos) => {
    simPositionRef.current = pos
    setSimPosition(pos)
    processPosition(pos.lat, pos.lng, SIMULATED_ACCURACY_M)
  }, [processPosition])

  // ---------------------------------------------------------------------
  // Real GPS
  // ---------------------------------------------------------------------
  const startRealWatch = useCallback(() => {
    if (!navigator.geolocation) {
      setError('Geolocation not supported on this device.')
      return
    }
    setError(null)
    setPermissionDenied(false)
    setTracking(true)
    goodFixReceivedRef.current = false  // reset so acquiring state fires for new session
    bestAccuracyRef.current   = null      // reset best-accuracy tracking
    lastPositionAtRef.current = null
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => processPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, pos.coords.speed, pos.coords.heading),
      (err) => {
        setError(`GPS: ${err.message}`)
        setTracking(false)
        // code 1 === GeolocationPositionError.PERMISSION_DENIED
        setPermissionDenied(err.code === 1)
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    )
  }, [processPosition])

  const stopRealWatch = useCallback(() => {
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current)
      watchId.current = null
    }
  }, [])

  // ---------------------------------------------------------------------
  // Public start/stop — picks real vs simulated source automatically
  // ---------------------------------------------------------------------
  const start = useCallback(() => {
    if (useSimulatedGPS) {
      setError(null)
      setTracking(true)
      if (!simPositionRef.current) applySimulatedPosition(DEFAULT_SIM_POSITION)
    } else {
      startRealWatch()
    }
  }, [useSimulatedGPS, startRealWatch, applySimulatedPosition])

  const stopAutoWalkInternal = useCallback(() => {
    if (autoWalkTimer.current !== null) {
      clearInterval(autoWalkTimer.current)
      autoWalkTimer.current = null
    }
    setAutoWalking(false)
  }, [])

  const stop = useCallback(() => {
    stopRealWatch()
    stopAutoWalkInternal()
    setTracking(false)
    setPosition(null)
    setAccuracy(null)
    setAcquiringGps(false)
    goodFixReceivedRef.current = false
    bestAccuracyRef.current    = null
    lastPositionAtRef.current  = null
    routeRef.current = null
    destRef.current = null
    setActiveDestination(null)
    announced.current = new Set()
    setRemainingPath(null)
    setRemainingDist(null)
    setLiveEta(null)
    setGuidance(null)
    offRouteRef.current = false
    setOffRoute(false)
    setHasRoute(false)
    setFullPath(null)
    setFullDistance(null)
    setFullEta(null)
    setRecalculating(false)
  }, [stopRealWatch, stopAutoWalkInternal])

  const setRoute = useCallback((path, destLat, destLng, destId) => {
    stopAutoWalkInternal()
    routeRef.current  = path
    destRef.current   = { lat: destLat, lng: destLng, id: destId ?? null }
    setActiveDestination(destRef.current)
    announced.current = new Set()
    walkedMetersRef.current = 0
    const dist = pathLength(path)
    setRemainingPath(path)
    setRemainingDist(dist)
    setFullPath(path)
    setFullDistance(dist)
    setFullEta(Math.round((dist / 1.4 / 60) * 10) / 10)
    offRouteRef.current = false
    setOffRoute(false)
    setHasRoute(true)
    setGuidance('Navigation started. Follow the orange path.')
    setTimeout(() => setGuidance(null), 3000)
  }, [stopAutoWalkInternal])

  const clearRoute = useCallback(() => {
    stopAutoWalkInternal()
    routeRef.current = null
    destRef.current  = null
    setActiveDestination(null)
    announced.current = new Set()
    walkedMetersRef.current = 0
    setRemainingPath(null)
    setRemainingDist(null)
    setLiveEta(null)
    setGuidance(null)
    offRouteRef.current = false
    setOffRoute(false)
    setHasRoute(false)
    setFullPath(null)
    setFullDistance(null)
    setFullEta(null)
    setRecalculating(false)
  }, [stopAutoWalkInternal])

  // ---------------------------------------------------------------------
  // Dev-mode simulation controls
  // ---------------------------------------------------------------------

  /** Turn simulation on/off. Turning on immediately starts tracking with
   *  simulated coordinates; turning off hands control back to real GPS
   *  (if tracking was active) — same as the "Reset to actual GPS" button. */
  const toggleSimulatedGPS = useCallback(() => {
    if (!devModeAvailable) return
    const next = !useSimulatedGPS
    setUseSimulatedGPS(next)
    if (next) {
      stopRealWatch()
      setError(null)
      setTracking(true)
      if (!simPositionRef.current) applySimulatedPosition(DEFAULT_SIM_POSITION)
    } else if (tracking) {
      startRealWatch()
    }
  }, [devModeAvailable, useSimulatedGPS, tracking, stopRealWatch, startRealWatch, applySimulatedPosition])

  const resetToActualGPS = useCallback(() => {
    if (!devModeAvailable) return
    stopAutoWalkInternal()
    setUseSimulatedGPS(false)
    simPositionRef.current = null
    setSimPosition(null)
    if (tracking) startRealWatch()
  }, [devModeAvailable, tracking, startRealWatch, stopAutoWalkInternal])

  const ensureSimulationActive = useCallback(() => {
    if (!devModeAvailable) return
    if (!useSimulatedGPS) {
      stopRealWatch()
      setUseSimulatedGPS(true)
    }
    setError(null)
    setTracking(true)
  }, [devModeAvailable, useSimulatedGPS, stopRealWatch])

  /** Nudge the simulated position by a lat/lng delta (used by the N/S/E/W buttons). */
  const moveSim = useCallback((dLat, dLng) => {
    if (!devModeAvailable) return
    ensureSimulationActive()
    const base = simPositionRef.current ?? DEFAULT_SIM_POSITION
    applySimulatedPosition({ lat: base.lat + dLat, lng: base.lng + dLng })
  }, [devModeAvailable, ensureSimulationActive, applySimulatedPosition])

  /** Set the simulated position directly (used by the lat/lng inputs). */
  const setSimLatLng = useCallback((lat, lng) => {
    if (!devModeAvailable) return
    if (Number.isNaN(lat) || Number.isNaN(lng)) return
    ensureSimulationActive()
    applySimulatedPosition({ lat, lng })
  }, [devModeAvailable, ensureSimulationActive, applySimulatedPosition])

  /** Jump 80m away from the current position, to test the off-route warning. */
  const goOffRoute = useCallback(() => {
    if (!devModeAvailable) return
    ensureSimulationActive()
    const base = simPositionRef.current ?? position ?? DEFAULT_SIM_POSITION
    const offset = destinationPoint(base.lat, base.lng, 90, OFF_ROUTE_TEST_DISTANCE_M)
    applySimulatedPosition(offset)
  }, [devModeAvailable, ensureSimulationActive, position, applySimulatedPosition])

  /** Walk automatically along the current route, one tick per second,
   *  resuming from wherever the dot currently is. */
  const startAutoWalk = useCallback(() => {
    if (!devModeAvailable || !routeRef.current?.length) return
    ensureSimulationActive()

    const total = pathLength(routeRef.current)
    const alreadyWalked = remainingDist != null ? Math.max(0, total - remainingDist) : 0
    walkedMetersRef.current = alreadyWalked

    if (autoWalkTimer.current !== null) clearInterval(autoWalkTimer.current)
    setAutoWalking(true)
    autoWalkTimer.current = setInterval(() => {
      walkedMetersRef.current += AUTO_WALK_STEP_M
      const path = routeRef.current
      if (!path?.length) { stopAutoWalkInternal(); return }
      const next = pointAtDistanceAlongPath(path, walkedMetersRef.current)
      applySimulatedPosition(next)
      if (walkedMetersRef.current >= pathLength(path)) {
        stopAutoWalkInternal()
      }
    }, AUTO_WALK_INTERVAL_MS)
  }, [devModeAvailable, ensureSimulationActive, remainingDist, stopAutoWalkInternal, applySimulatedPosition])

  const stopAutoWalk = useCallback(() => {
    stopAutoWalkInternal()
  }, [stopAutoWalkInternal])

  // Clean up any running interval/watch on unmount.
  useEffect(() => {
    return () => {
      stopRealWatch()
      if (autoWalkTimer.current !== null) clearInterval(autoWalkTimer.current)
    }
  }, [stopRealWatch])

  const value = {
    // existing public API — unchanged
    position, accuracy, acquiringGps, tracking, error, arrivalRadius,
    // Priority 11 (Phase 4.2.7) — lets the UI show a specific "location
    // access needed" prompt with a retry action, instead of staying silent.
    permissionDenied,
    remainingPath, remainingDist, liveEta,
    guidance, offRoute,
    start, stop, setRoute, clearRoute,
    // Priority 2 (Phase 4.2.4) — GPS course-over-ground + speed for the
    // heading-fusion hook (useNavCamera)
    speed, gpsCourse,

    // Feature 1 — automatic recalculation
    fullPath, fullDistance, fullEta,
    recalculating, recalcVersion,
    destination: activeDestination,

    // dev-mode additions
    devModeAvailable,
    useSimulatedGPS,
    simPosition,
    hasRoute,
    autoWalking,
    toggleSimulatedGPS,
    moveSim,
    setSimLatLng,
    startAutoWalk,
    stopAutoWalk,
    goOffRoute,
    resetToActualGPS,
  }

  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>
}
