/**
 * Home.jsx — Main campus navigation screen.
 *
 * Phase 1:  Active Navigation Mode (hides browse UI, shows nav UI)
 * Phase 3:  Professional turn-by-turn instruction card at top
 * Phase 4:  Smart user marker with heading (via MapView userHeading)
 * Phase 4A: Premium Google Maps navigation experience:
 *           True heading-up, lower-third camera, smart zoom, premium marker,
 *           premium route, navigation compass, follow mode, recenter button
 * Phase 5:  Navigation bottom sheet (collapsed: dist+ETA, expanded: details)
 * Phase 6:  Exit Navigation button (bottom-left)
 * Phase 7:  Arrival overlay with Done/Navigate Again/Share
 * Phase 13: Campus landmark guidance in turn card
 * Phase 14: Auto-follow + Recenter button when user manually pans
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate, useLocation as useRouterLocation } from 'react-router-dom'
import MapView from '../components/MapView'
import SearchBar from '../components/SearchBar'
import CategoryChips from '../components/CategoryChips'
import LocationCard from '../components/LocationCard'
import RoutePreviewPanel from '../components/RoutePreviewPanel'
import NearbyFacilities from '../components/NearbyFacilities'
import CompassWidget from '../components/CompassWidget'
import NavCompass from '../components/NavCompass'
import NavSettingsPanel from '../components/NavSettingsPanel'
import ChatbotWidget from '../copilot/ChatbotWidget'
import { getLocations, searchLocations, getRoute, getRouteFromCoords, getRoadSegments, getEvents } from '../api'
import { useLocationContext } from '../context/LocationContext'
import { useVoiceGuidance } from '../hooks/useVoiceGuidance'
import { useCompassHeading } from '../hooks/useCompassHeading'
import { useNavCamera, circDiff } from '../hooks/useNavCamera'
import { useElementHeightVar } from '../hooks/useElementHeightVar'
import { landmarksAlongPath } from '../utils/facilities'
import { computeUpcomingTurn, computeAllTurns, haversine } from '../utils/geo'
import { displayLocationName } from '../constants'
import { useDraggableSheet } from '../hooks/useDraggableSheet'
import VenueMenuCard from '../components/VenueMenuCard'
import VenueMenuInline from '../components/VenueMenuInline'
import RouteFeedbackDialog from '../components/RouteFeedbackDialog'
import { track } from '../analytics/analyticsClient'

const SHEET_HEIGHT = 38
const ENTRY_ID     = 'main-gate'
const ARRIVED_DIST_M = 20

// ── Turn display helpers ────────────────────────────────────────────────────
function turnIcon(dir) {
  switch (dir) {
    case 'slight left':  return '↖'
    case 'slight right': return '↗'
    case 'left':         return '↰'
    case 'right':        return '↱'
    case 'u-turn':       return '↩'
    default:             return '↑'
  }
}

function turnLabel(dir) {
  switch (dir) {
    case 'slight left':  return 'Bear Left'
    case 'slight right': return 'Bear Right'
    case 'left':         return 'Turn Left'
    case 'right':        return 'Turn Right'
    case 'u-turn':       return 'Make U-Turn'
    default:             return 'Continue Straight'
  }
}

function formatDist(m) {
  if (m == null) return '—'
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`
}

/** Phase 4.2.2 — clock time the user is expected to arrive, e.g. "4:32 PM" */
function formatArrivalClock(etaMinutes) {
  if (etaMinutes == null) return '—'
  const d = new Date(Date.now() + etaMinutes * 60_000)
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
}

/** Phase 13: find a named campus landmark within radius of a point. */
function nearestLandmarkToTurn(turnLat, turnLng, locations, excludeIds = []) {
  if (!turnLat || !turnLng || !locations?.length) return null
  let best = null, bestDist = 75 // only within 75m
  for (const loc of locations) {
    if (excludeIds.includes(loc.id)) continue
    const d = haversine(turnLat, turnLng, loc.lat, loc.lng)
    if (d < bestDist) { bestDist = d; best = loc }
  }
  return best
}

export default function Home() {
  const navigate = useNavigate()
  const routerLocation = useRouterLocation()
  const [locations, setLocations]         = useState([])
  const [query, setQuery]                 = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const [category, setCategory]           = useState(null)
  const [destination, setDestination]     = useState(null)
  const [routePath, setRoutePath]         = useState(null)
  const [routeDist, setRouteDist]         = useState(null)
  const [routeEta, setRouteEta]           = useState(null)
  const [routeWarning, setRouteWarning]   = useState(null)
  const [routeError, setRouteError]       = useState(null)
  // Priority 2 (Phase 4.8) — set whenever handleDirections/
  // startNavigationFromCopilot had to fall back to routing from Main Gate
  // because live GPS position wasn't available yet at request time. See
  // the correction effect below (near handleStartNavigation) for why.
  const routeFromFallbackRef              = useRef(false)
  const [followUser, setFollowUser]       = useState(false)
  const [loadError, setLoadError]         = useState(null)
  const [roadSegments, setRoadSegments]   = useState([])

  // Route preview (before navigation starts)
  const [previewActive, setPreviewActive]   = useState(false)
  const [previewLoc, setPreviewLoc]         = useState(null)
  const [previewRoutes, setPreviewRoutes]   = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError]     = useState(null)
  const [previewTrigger, setPreviewTrigger] = useState(0)

  // Voice settings panel
  const [navSettingsOpen, setNavSettingsOpen] = useState(false)
  // Priority 1 (Phase 4.2.4) — Navigation Settings. `headingUp` (declared
  // further down, unchanged) doubles as "Rotate Map While Walking"; these
  // are new. All are plain session-lifetime state per the
  // spec ("persist during the current navigation session") — see
  // NavSettingsPanel.jsx's header comment for why that doesn't need
  // localStorage the way voice guidance does.
  const [showCompass, setShowCompass]   = useState(false) // default OFF — "Compass hidden unless explicitly enabled"
  const [autoRecenter, setAutoRecenter] = useState(false)
  const [dynamicZoom, setDynamicZoom]   = useState(true)
  // Priority 1 (Phase 4.5) — default is now 'native': leaflet-rotate's own
  // compassBearing handler drives the map directly (see MapView.jsx's
  // NavigationController), with a small dead-zone + light smoothing wrapper
  // around map.setBearing() to take the edge off magnetometer jitter without
  // building a second heading pipeline. 'smart' (our own GPS/compass fusion)
  // stays selectable in Navigation Settings for anyone who prefers its
  // heavier stabilization. See MapView.jsx for how exactly one of the two
  // ever drives map.setBearing() at a time.
  const [headingMode, setHeadingMode]   = useState('native')

  // ── Phase 1: Navigation mode state ─────────────────────────────────────
  const [navMode, setNavMode]                     = useState(false)
  // Phase 11: room/floor/wing info from event navigation
  const [navEventInfo, setNavEventInfo]           = useState(null)  // {room,floor,wing,building}
  // Phase 7: Arrival overlay
  const [arrived, setArrived]                     = useState(false)
  // Phase 2: Events happening at the arrival venue
  const [arrivalEvents, setArrivalEvents]         = useState([])
  // Phase 14: Auto-follow / recenter
  const [userManuallyPanned, setUserManuallyPanned] = useState(false)
  // Phase 4A: heading-up navigation mode (true = map rotates with user direction)
  const [headingUp, setHeadingUp] = useState(true)
  // Phase 4A: current map bearing reported by NavigationController
  const [currentBearing, setCurrentBearing] = useState(0)
  // Phase 4.2: clipboard feedback for share button (non-Web-Share browsers)
  const [shareCopied, setShareCopied] = useState(false)
  // Phase X — Feature 3 (Route Feedback) + Feature 2 (Analytics): trip
  // start time (for trip duration) and the feedback dialog's own state.
  // tripStartRef is a ref (not state) since it's write-once-per-trip and
  // read only at the moment the trip ends — no re-render needed for it.
  const tripStartRef = useRef(null)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedbackContext, setFeedbackContext] = useState(null)

  const {
    position, accuracy, acquiringGps, tracking, error: gpsError,
    permissionDenied: gpsPermissionDenied,
    remainingPath, remainingDist, liveEta,
    guidance, offRoute, hasRoute,
    fullPath, fullDistance, fullEta, recalculating, recalcVersion,
    destination: navDestination,
    arrivalRadius,
    start: startTracking, stop: stopTracking,
    setRoute, clearRoute: clearGpsRoute,
    // Priority 2 (Phase 4.2.4) — GPS course-over-ground + speed, fed into
    // useNavCamera below so it can prefer GPS course over the compass
    // while walking, and freeze heading updates entirely while stationary.
    speed, gpsCourse,
  } = useLocationContext()

  const voice = useVoiceGuidance({ tracking, hasRoute, remainingDist, remainingPath, offRoute })

  // ── Phase 4.2.2 — Draggable nav bottom sheet (3 snap points) ───────────
  // Peeks are in px of sheet visible above the viewport bottom edge.
  // Recomputed on resize/orientation-change so the sheet stays proportional.
  const [viewportH, setViewportH] = useState(() => window.innerHeight)
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])
  // Priority 3 (Phase 4.2.7) — root cause of "fully-expanded sheet collides
  // with the turn instruction card": the sheet's 'full' tier was a flat
  // 86% of viewport height with no awareness of the turn card at all,
  // while the turn card is pinned near the top at a fixed offset. On
  // shorter phones (or whenever the card grows taller — a longer street
  // name, a destination badge, etc.) the sheet's top edge could rise
  // above the turn card's bottom edge, and the two would overlap.
  // Measuring the card's REAL rendered bottom edge and clamping 'full' to
  // stop just below it (with a small gap) means the two can never
  // collide, regardless of device height or how tall the card gets.
  const [turnCardBottom, setTurnCardBottom] = useState(0)
  const turnCardRoRef = useRef(null)
  const turnCardRef = useCallback((node) => {
    if (turnCardRoRef.current) { turnCardRoRef.current.disconnect(); turnCardRoRef.current = null }
    if (!node) { setTurnCardBottom(0); return }
    const measure = () => setTurnCardBottom(node.getBoundingClientRect().bottom)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(node)
    turnCardRoRef.current = ro
  }, [])
  const navSheetPeeks = useMemo(() => {
    const TURN_CARD_GAP = 16
    const maxFullBeforeCollision = turnCardBottom > 0
      ? Math.max(240, viewportH - turnCardBottom - TURN_CARD_GAP)
      : Math.round(viewportH * 0.86)
    return {
      collapsed: 128,
      half: Math.round(viewportH * 0.44),
      full: Math.min(Math.round(viewportH * 0.86), maxFullBeforeCollision),
    }
  }, [viewportH, turnCardBottom])
  // Priority 1 (Phase 4.8) root-cause fix — the transform pivot passed to
  // useDraggableSheet below must always be the sheet's TRUE, fixed CSS box
  // height (`.nav-bottom-sheet { height: 86dvh }`), never the `full` tier's
  // OWN peek target, because that target is deliberately capped just above
  // (maxFullBeforeCollision) to keep the fully-expanded sheet clear of the
  // turn-by-turn card — a completely different concern from "how tall is
  // the box the transform is measured against". Conflating the two used to
  // silently shrink the transform pivot for every tier (not just full),
  // rendering the sheet measurably taller than any given peek intended —
  // proven via runtime instrumentation, see useDraggableSheet.js. This is
  // the same 86dvh expression as the sheet's own CSS, so it always matches.
  const navSheetBoxHeight = Math.round(viewportH * 0.86)
  // Priority 1 (Phase 4.4): gate --sheet-h ownership to whichever sheet is
  // actually on screen — see useDraggableSheet.js header comment for why.
  const navSheet = useDraggableSheet(navSheetPeeks, 'collapsed', navMode, navSheetBoxHeight)
  // Every fresh navigation session starts collapsed so the map is visible;
  // the user drags/taps up for more detail. Presentation-only — doesn't
  // touch routing/GPS.
  useEffect(() => {
    if (navMode) navSheet.snapToTier('collapsed')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navMode])

  // Bug 7 — Route Preview Panel: same idea, reused rather than rebuilt.
  // 'half' and 'full' are pinned to the same peek since this panel only
  // needs a binary collapsed/expanded state, not three distinct tiers —
  // that keeps this a plain reuse of useDraggableSheet with zero changes
  // to the hook itself (Bug 3 says not to rebuild the draggable sheet).
  // Priority 3 (Phase 4.2.3): collapsed peek bumped 132 → 160px — the old
  // height was cramped even before Priority 9 added the inline food-menu
  // line to this row; 160px gives both the dest/ETA/menu text stack and
  // the Start Navigation button comfortable breathing room. Keep this in
  // sync with the matching `calc(70vh - 160px)` fallback in index.css
  // (.results-sheet.preview-mode) if it's ever changed again.
  const previewSheetPeeks = useMemo(() => ({
    collapsed: 160,
    half: Math.round(viewportH * 0.7),
    full: Math.round(viewportH * 0.7),
  }), [viewportH])
  const previewSheet = useDraggableSheet(previewSheetPeeks, 'collapsed', previewActive)
  // Every new route preview starts collapsed (peek) so the map — and the
  // route "Preview Route" just zoomed to — stays the primary focus; the
  // user can drag it up for landmarks/menu/etc. Never remembers the
  // previous preview's expanded height.
  useEffect(() => {
    if (previewActive) previewSheet.snapToTier('collapsed')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewActive, previewLoc])

  // Priority X.1 (Phase 4.2.7) — the "Campus Locations" panel on the Home
  // screen used to be a plain static div fixed at 38% height (SHEET_HEIGHT
  // below); it's now a full 3-tier draggable sheet, same as nav/preview.
  // 'half' keeps the same 38%-of-viewport default so nothing about the
  // everyday look changes — it's just draggable now, both up and down.
  const browseSheetPeeks = useMemo(() => ({
    collapsed: 132,
    half: Math.round(viewportH * (SHEET_HEIGHT / 100)),
    full: Math.round(viewportH * 0.86),
  }), [viewportH])
  const browseSheet = useDraggableSheet(browseSheetPeeks, 'half', !navMode && !previewActive)

  // Priority X.2 (Phase 4.2.7) — pressing Enter/Search on the mobile
  // keyboard dismisses it (handled in SearchBar itself) and moves focus
  // onto the results list, so it's immediately visible and keyboard-
  // navigable with no extra tap. Also expands the sheet off 'collapsed'
  // so a collapsed sheet doesn't hide the very results just requested.
  const resultsListRef = useRef(null)
  const handleSearchSubmit = useCallback(() => {
    if (browseSheet.tier === 'collapsed') browseSheet.snapToTier('half')
    resultsListRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseSheet.tier])

  // Priority 4 (Phase 4.2.7) — root cause of "zoom controls too close to
  // the search bar on some devices": Leaflet's zoom control was always
  // mounted, even on the Home browse screen where the search bar and
  // category chips already occupy that same top-left corner on short
  // viewports. Rather than trust yet another clamped-offset formula to
  // cover every device, the zoom control is simply hidden entirely on the
  // browse screen (pinch-to-zoom / double-tap still work) and only shown
  // during active navigation, where it already has guaranteed clearance.
  useEffect(() => {
    document.documentElement.classList.toggle('app-navmode', navMode)
    return () => document.documentElement.classList.remove('app-navmode')
  }, [navMode])

  // Phase 4.2 — Priority 1 / Priority X.1 (4.2.7): the floating button
  // stack tracks its OWN real rendered height via ResizeObserver (still
  // needed — its height genuinely varies with content). --sheet-h itself
  // is now written directly by whichever draggable sheet is mounted (nav,
  // route-preview, or browse — all three use useDraggableSheet), so a
  // separate ResizeObserver-based measurement for it is no longer needed.
  const fabStackHeightRef = useElementHeightVar('--fab-stack-h')

  // Phase 4 + 4A: compass heading + premium smoothing.
  // Bug 6 fix: also gated on `headingUp` — when the user has explicitly
  // turned Heading-Up off, the device orientation sensor listener detaches
  // entirely (useCompassHeading's `active` flag), not just its effect on
  // the map. Re-enabling the toggle reattaches it, same as it already does
  // when navMode/tracking toggle.
  const {
    heading: rawHeading, supported: compassSupported,
    needsPermission: compassNeedsPermission, permissionState: compassPermissionState,
    requestPermission: requestCompassPermission,
  } = useCompassHeading(navMode && tracking && headingUp)
  // Phase 4A: smooth the raw heading → two outputs:
  //   smoothedHeading: fine-grained, used for the user marker arrow
  //   mapHeading:      coarser, used for map rotation to avoid micro-oscillations
  // Priority 3 (Phase 4.2.5) — ROOT CAUSE of "Heading-Up sometimes never
  // activates": this used to also require `!acquiringGps`, i.e. a GOOD GPS
  // FIX, before heading-up could do anything at all — conflating two
  // unrelated concerns. Compass rotation only needs a compass reading (or
  // GPS course); it doesn't need accurate positioning, that's a separate
  // concern already handled independently (MapView's camera-follow effect
  // already no-ops on its own when userPosition is null). Gating rotation
  // on GPS accuracy meant heading-up simply never engaged anywhere GPS
  // took a while to lock (indoors, urban canyon, cloudy sky) even though
  // the compass itself was ready immediately.
  const navCameraActive = navMode && tracking && headingUp
  // Phase 3 + 13: compute upcoming turn with landmark hint. Moved up from
  // its old spot further down — Priority 2 (Phase 4.2.6)'s cooldown-bypass
  // logic in useNavCamera needs nextTurn.distanceM to know when a turn is
  // imminent, so this has to run before that hook is called.
  const nextTurn = useMemo(() => {
    if (!navMode || !remainingPath?.length) return null
    return computeUpcomingTurn(remainingPath)
  }, [navMode, remainingPath])
  const { smoothedHeading, mapHeading } = useNavCamera(rawHeading, navCameraActive, {
    gpsCourse, speed, nextTurnDist: nextTurn?.distanceM ?? null,
  })

  // Priority 5 (Phase 4.2.5) — Navigation Status. A single, always-computed
  // status so nothing about heading-up/GPS acquisition ever just silently
  // does nothing — the user always sees *why* the map isn't rotating yet
  // if it isn't. Checked in priority order: a missing/weak GPS fix matters
  // more than heading state (nothing works well without a position at
  // all), then whether heading-up specifically has what it needs.
  const navStatus = useMemo(() => {
    if (!navMode) return null
    if (!position) return { icon: '📍', text: 'Waiting for GPS…' }
    if (accuracy != null && accuracy > 150) return { icon: '⚠', text: 'Weak GPS Signal' }
    if (headingUp) {
      // iOS-style explicit permission prompt was denied — say so rather
      // than leaving heading-up silently inert. GPS course (if available)
      // still works without compass permission, so only surface this when
      // there's no fallback either.
      if (compassNeedsPermission && compassPermissionState === 'denied' && gpsCourse == null) {
        return { icon: '⚠', text: 'Compass permission denied' }
      }
      if (rawHeading == null && gpsCourse == null) {
        return { icon: '🧭', text: 'Calibrating Heading…' }
      }
      if ((!compassSupported || compassPermissionState === 'denied') && gpsCourse != null) {
        return { icon: '⚠', text: 'Compass unavailable — using GPS heading' }
      }
    }
    return { icon: '✅', text: 'Navigation Ready' }
  }, [navMode, position, accuracy, headingUp, rawHeading, gpsCourse, compassSupported, compassNeedsPermission, compassPermissionState])

  // Reset voice dedup on recalculation — pass remainingPath so a turn that's
  // still the immediate upcoming one after the reroute isn't re-announced
  // (see useVoiceGuidance.js resetForNewRoute for the full reasoning).
  const prevRecalcVersionRef = useRef(recalcVersion)
  const remainingPathRef = useRef(remainingPath)
  remainingPathRef.current = remainingPath
  useEffect(() => {
    if (recalcVersion !== prevRecalcVersionRef.current) {
      prevRecalcVersionRef.current = recalcVersion
      voice.resetForNewRoute(remainingPathRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recalcVersion, voice.resetForNewRoute])

  // Detect active route on mount — handles EventPage → Home navigation flow.
  // EventPage calls setRoute+start+navigate('/', {state:{eventInfo}}) →
  // Home mounts with tracking+hasRoute already true + event room info.
  const voiceRef = useRef(null)
  voiceRef.current = voice
  const locationState = window.history.state?.usr  // React Router state
  useEffect(() => {
    if (tracking && hasRoute) {
      setNavMode(true)
      setFollowUser(autoRecenter)
      setTimeout(() => voiceRef.current?.announceNavigationStart(), 300)
    }
    // Phase 11: pick up room/floor/wing from EventPage navigation state
    if (locationState?.eventInfo) {
      setNavEventInfo(locationState.eventInfo)
    }
    // only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    getLocations().then(setLocations).catch(e => setLoadError(e.message))
  }, [])

  // Priority 1 (Phase 4.2.3): request GPS the moment the app launches,
  // instead of waiting for the user to tap "My Location" or "Start
  // Navigation". `startTracking` is a no-op-safe guard against
  // double-starting a watchPosition() if tracking is already active from
  // an earlier mount (LocationProvider lives above the router, so
  // `tracking` survives navigating away from and back to Home). If the
  // browser has no geolocation support or the user denies permission,
  // `error` is set and every route calculation below already falls back
  // to Main Gate on its own (see handleDirections/startNavigationFromCopilot's
  // `tracking && position` checks) — no separate fallback needed here.
  useEffect(() => {
    if (!tracking) startTracking()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Phase 4.2 — Priority 2: handle /location/:id deep links.
  // LocationDeepLink.jsx fetches the location then navigates here with
  // state.deepLinkLocation set. We pick it up once on mount and open
  // the route preview sheet exactly as if the user tapped the card.
  //
  // Bug found during production verification: this comment always said
  // "wait for locations to load before calling handleDirections", but the
  // code never actually did — it called handleDirections(loc) immediately
  // on mount, before the getLocations() fetch below could possibly have
  // resolved (fetches are async; they can't settle before sibling mount
  // effects finish running). handleDirections uses locations/roadSegments
  // to compute landmarksAlongPath() for the preview, so every
  // /location/:id share-link open silently got an empty "Route passes"
  // list — and since previewRoutes is only ever computed this one time,
  // it never refilled once locations *did* load moments later. Root-cause
  // fix: actually gate on locations having settled (loaded or failed)
  // before consuming the deep link. deepLinkConsumedRef — not the effect's
  // dependency array — is what keeps this a one-time action, so a later
  // locations reload can't re-fire it and reset an unrelated in-progress
  // preview.
  const deepLinkConsumedRef = useRef(false)
  useEffect(() => {
    const loc = routerLocation.state?.deepLinkLocation
    if (!loc || !loc.id || deepLinkConsumedRef.current) return
    if (locations.length === 0 && !loadError) return // still loading — wait
    deepLinkConsumedRef.current = true
    // Clear the state so a back-navigation doesn't re-trigger this
    window.history.replaceState({}, '')
    handleDirections(loc)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locations, loadError])

  useEffect(() => {
    getRoadSegments().then(setRoadSegments).catch(() => {})
  }, [])

  useEffect(() => {
    if (!query.trim()) { setSearchResults(null); return }
    const h = setTimeout(() =>
      searchLocations(query).then(setSearchResults).catch(e => setLoadError(e.message))
    , 250)
    return () => clearTimeout(h)
  }, [query])

  // Phase 9 (Q7): dynamic arrival — use GPS-accuracy-based radius
  useEffect(() => {
    if (navMode && !arrived && remainingDist != null) {
      const threshold = arrivalRadius ?? ARRIVED_DIST_M
      if (remainingDist <= threshold) {
        setArrived(true)
        voice.cancel()
      }
    }
  }, [navMode, arrived, remainingDist, arrivalRadius, voice])

  // Phase 2: fetch events at the arrived venue
  useEffect(() => {
    if (!arrived || !previewLoc?.id) { setArrivalEvents([]); return }
    const today = new Date().toISOString().slice(0, 10)
    const now   = `${String(new Date().getHours()).padStart(2,'0')}:${String(new Date().getMinutes()).padStart(2,'0')}`
    getEvents().then(evs => {
      const venue = evs.filter(e =>
        e.location?.id === previewLoc.id &&
        e.date === today &&
        e.start_time <= now && now <= e.end_time
      )
      setArrivalEvents(venue)
    }).catch(() => {})
  }, [arrived, previewLoc])

  // Authoritative route display
  const displayRoutePath = (hasRoute && fullPath) ? fullPath : routePath
  const displayFullDist  = (hasRoute && fullPath) ? fullDistance : routeDist
  const displayFullEta   = (hasRoute && fullPath) ? fullEta : routeEta

  const visibleLocations = useMemo(() => {
    if (category) return locations.filter(l => l.category === category)
    return locations
  }, [locations, category])

  const listItems  = searchResults !== null ? searchResults : visibleLocations
  const sheetEmpty = !previewActive && listItems.length === 0 && !loadError

  // While any of the three draggable sheets (nav, route-preview, or browse)
  // is mounted, it is the sole writer of --sheet-h, updating it every
  // animation frame (drag + snap). The floating controls that read
  // --sheet-h (copilot-fab-stack, zoom control) have their own CSS
  // `transition: bottom …` tuned for the OLD non-draggable sheets, which
  // updated --sheet-h in sparse discrete jumps rather than every frame.
  // Left on, that transition would fight our per-frame writes and visibly
  // lag behind the sheet instead of moving with "the same animation
  // curve" — so it's disabled for exactly as long as one of these sheets
  // (mutually exclusive — never more than one mounted at once) owns the var.
  useEffect(() => {
    document.documentElement.classList.toggle('nav-sheet-driving', navMode || previewActive || !sheetEmpty)
    return () => document.documentElement.classList.remove('nav-sheet-driving')
  }, [navMode, previewActive, sheetEmpty])

  const mainGateLoc = useMemo(() => locations.find(l => l.id === ENTRY_ID), [locations])
  const refLat = position?.lat ?? mainGateLoc?.lat ?? null
  const refLng = position?.lng ?? mainGateLoc?.lng ?? null

  // Destination name for nav UI
  const destName = useMemo(() => {
    if (previewLoc) return displayLocationName(previewLoc)
    if (navDestination?.id) {
      const loc = locations.find(l => l.id === navDestination.id)
      return loc ? displayLocationName(loc) : null
    }
    return null
  }, [previewLoc, navDestination, locations])

  // Phase 4.2.2 — full location object for the active nav destination
  // (navDestination from useLocationContext only carries {id, lat, lng} —
  // enough for GPS tracking, not enough for category/department/etc).
  const navDestLoc = useMemo(() => {
    if (!navDestination?.id) return null
    return locations.find(l => l.id === navDestination.id) || null
  }, [navDestination, locations])

  // Phase 4.2.2 — full turn-by-turn list for the "Fully Expanded" sheet
  // tier. Display-only derivative of the same remainingPath GPS already
  // tracks; does not feed guidance/voice/off-route logic.
  const allTurns = useMemo(() => {
    if (!navMode || !remainingPath?.length) return []
    return computeAllTurns(remainingPath)
  }, [navMode, remainingPath])

  const turnLandmark = useMemo(() => {
    if (!nextTurn || !locations.length) return null
    return nearestLandmarkToTurn(nextTurn.lat, nextTurn.lng, locations,
      navDestination?.id ? [navDestination.id] : [])
  }, [nextTurn, locations, navDestination])

  const displayDist = remainingDist ?? displayFullDist
  const displayEta  = liveEta ?? displayFullEta

  const compassDestination = navDestination?.id
    ? { lat: navDestination.lat, lng: navDestination.lng }
    : null

  // ── Handlers ──────────────────────────────────────────────────────────
  async function handleDirections(loc) {
    setDestination(loc.id)
    setPreviewLoc(loc)
    setPreviewActive(true)
    setPreviewError(null)
    setPreviewLoading(true)
    setPreviewRoutes(null)
    setRouteWarning(null)
    setRouteError(null)
    try {
      const usedFallback = !(tracking && position)
      routeFromFallbackRef.current = usedFallback
      const r = usedFallback
        ? await getRoute(ENTRY_ID, loc.id)
        : await getRouteFromCoords(position.lat, position.lng, loc.id, accuracy)
      const landmarks = landmarksAlongPath(r.path, locations, roadSegments, [ENTRY_ID, loc.id])
      setPreviewRoutes([{ distanceM: r.distance_m, etaMinutes: r.eta_minutes, landmarks }])
      setRoutePath(r.path)
      setRouteDist(r.distance_m)
      setRouteEta(r.eta_minutes)
      if (r.warning) setRouteWarning(r.warning)
    } catch (e) {
      setPreviewError(e.message)
    } finally {
      setPreviewLoading(false)
    }
  }

  function handlePreviewRoute() {
    setPreviewTrigger(t => t + 1)
    previewSheet.snapToTier('collapsed')
  }

  function handleStartNavigation() {
    if (!previewLoc || !routePath) return
    voice.resetForNewRoute()
    setRoute(routePath, previewLoc.lat, previewLoc.lng, previewLoc.id)
    voice.announceNavigationStart()
    if (!tracking) startTracking()
    setFollowUser(autoRecenter)
    setPreviewActive(false)
    setPreviewRoutes(null)
    // Phase 1: enter navigation mode
    setNavMode(true)
    setArrived(false)
    setUserManuallyPanned(false)
    // Phase X — Feature 2 (Analytics)
    tripStartRef.current = Date.now()
    track('trip_started', { destination_id: previewLoc.id, distance_m: routeDist })
    // Priority 4 (Phase 4.2.5): heading-up begins automatically as a
    // NATURAL CONSEQUENCE of headingUp already being true (default ON,
    // see its useState above) — not by force-setting it here. Forcing it
    // true unconditionally on every nav start would silently override a
    // user who'd deliberately turned Rotate Map While Walking off in
    // Navigation Settings, which is exactly what "preserve all Navigation
    // Settings" rules out. If the preference is on, navCameraActive
    // (navMode && tracking && headingUp) already activates heading-up on
    // its own the moment navMode flips true just below; if it's off,
    // navigation correctly stays North-Up.
    // Priority 3 (Phase 4.2.5) — reliable initialization. On browsers that
    // gate orientation access behind an explicit user gesture (iOS
    // Safari), this is that gesture — request it right here rather than
    // leaving it to whatever separately-instanced widget happens to call
    // it (previously only CompassWidget's own "Enable Compass" tap did,
    // which a user could easily never see before hitting Start
    // Navigation). No-ops immediately on platforms that don't need it
    // (Android/desktop) — see useCompassHeading's needsPermission check.
    // Requested regardless of the current headingUp setting so it's
    // already granted if the user flips the setting on mid-session.
    requestCompassPermission()
  }

  // Priority 2 (Phase 4.8) root-cause fix — proven via runtime instrumentation:
  // handleDirections/startNavigationFromCopilot above fall back to routing
  // FROM MAIN GATE whenever the user taps a destination before their live
  // GPS position has resolved. That's a common race, not an edge case —
  // tracking starts the moment the app launches (see the effect below that
  // calls startTracking() on mount), but a first fix can take several
  // seconds on a real device, and a user who already knows where they're
  // going often taps a destination well within that window. The
  // Main-Gate-anchored route was never corrected once the real position
  // did arrive, which is what actually produced "my location/route looks
  // wrong at the start of navigation, then corrects a few seconds later" —
  // confirmed by instrumenting the exact /api/route request made in that
  // race. Fix: the instant `position` transitions from unavailable to
  // available while the CURRENT route was actually built from that
  // fallback, re-request it from the real position. This is event-driven
  // off the position update itself — no guessed delay, no polling.
  useEffect(() => {
    if (!position || !routeFromFallbackRef.current || !previewLoc) return
    routeFromFallbackRef.current = false
    let cancelled = false
    ;(async () => {
      try {
        const r = await getRouteFromCoords(position.lat, position.lng, previewLoc.id, accuracy)
        if (cancelled) return
        setRoutePath(r.path)
        setRouteDist(r.distance_m)
        setRouteEta(r.eta_minutes)
        setRouteWarning(r.warning || null)
        // Only push into the live GPS-tracked route if navigation is
        // actually underway — during the preview step there's no live
        // route yet to update, just the preview numbers above.
        if (navMode) setRoute(r.path, previewLoc.lat, previewLoc.lng, previewLoc.id)
      } catch {
        // Keep the existing (fallback) route rather than surface an error
        // for a correction the user didn't explicitly ask for.
      }
    })()
    return () => { cancelled = true }
  }, [position, accuracy, previewLoc, navMode, setRoute])

  // Campus Copilot (Phase 1): start navigation directly from a chat card,
  // skipping the preview-panel step. Mirrors handleDirections +
  // handleStartNavigation above but fetches the route and applies it in
  // one go (no reliance on intermediate state having flushed yet), and
  // optionally carries classroom room/floor info into the existing
  // arrival-screen mechanism (navEventInfo) used by event navigation.
  async function startNavigationFromCopilot(loc, eventInfo = null) {
    // Priority 3 (Phase 4.2.5) — same reasoning as handleStartNavigation;
    // called first, synchronously, before any `await` below, since some
    // browsers only honor requestPermission() as part of the original
    // user-gesture call stack.
    requestCompassPermission()
    try {
      const usedFallback = !(tracking && position)
      routeFromFallbackRef.current = usedFallback
      const r = usedFallback
        ? await getRoute(ENTRY_ID, loc.id)
        : await getRouteFromCoords(position.lat, position.lng, loc.id, accuracy)
      voice.resetForNewRoute()
      setDestination(loc.id)
      setPreviewLoc(loc)
      setRoutePath(r.path)
      setRouteDist(r.distance_m)
      setRouteEta(r.eta_minutes)
      setRouteWarning(r.warning || null)
      setRouteError(null)
      setRoute(r.path, loc.lat, loc.lng, loc.id)
      voice.announceNavigationStart()
      if (!tracking) startTracking()
      setFollowUser(autoRecenter)
      setPreviewActive(false)
      setPreviewRoutes(null)
      setNavMode(true)
      setArrived(false)
      setUserManuallyPanned(false)
      // Priority 4 (Phase 4.2.5): don't force headingUp true here either —
      // see the matching comment in handleStartNavigation above.
      if (eventInfo) setNavEventInfo(eventInfo)
      // Phase X — Feature 2 (Analytics)
      tripStartRef.current = Date.now()
      track('trip_started', { destination_id: loc.id, distance_m: r.distance_m })
    } catch (e) {
      setRouteError(e.message)
    }
  }

  function handleCancelPreview() {
    setPreviewActive(false)
    setPreviewRoutes(null)
    setPreviewError(null)
    setPreviewLoc(null)
    setDestination(null)
    setRoutePath(null); setRouteDist(null); setRouteEta(null); setRouteWarning(null)
  }

  function handleClear() {
    // Phase X — Feature 2 (Analytics) + Feature 3 (Route Feedback): this is
    // the one place every "navigation is over" path already funnels
    // through (End Navigation, the arrival screen's Done / Go Somewhere
    // Else, the ✕ exit button, ChatbotWidget's cancel) — so it's also the
    // single, minimal hook point for both. Only fires for an actual
    // in-progress navigation (navMode true); clearing a not-yet-started
    // route preview does neither. Captured BEFORE the state below is
    // cleared, since this reads routeDist/previewLoc/destName/arrived.
    if (navMode) {
      const durationS = tripStartRef.current ? Math.round((Date.now() - tripStartRef.current) / 1000) : null
      track(arrived ? 'trip_completed' : 'trip_cancelled', {
        destination_id: previewLoc?.id ?? navDestination?.id ?? null,
        distance_m: routeDist,
        duration_s: durationS,
      })
      tripStartRef.current = null
      setFeedbackContext({
        destinationId: previewLoc?.id ?? navDestination?.id ?? null,
        destinationName: destName || null,
        distanceM: routeDist,
        arrived,
      })
      setFeedbackOpen(true)
    }
    setRoutePath(null); setRouteDist(null); setRouteEta(null)
    setRouteWarning(null); setRouteError(null); setDestination(null)
    setFollowUser(false)
    setPreviewActive(false); setPreviewRoutes(null); setPreviewLoc(null)
    clearGpsRoute()
    voice.cancel()
    // Phase 1: exit navigation mode
    setNavMode(false)
    setArrived(false)
    setUserManuallyPanned(false)
    setNavEventInfo(null)
    setArrivalEvents([])
    // Priority 4 (Phase 4.2.5): NOT resetting headingUp here anymore.
    // "Return to North-Up" already happens on its own — the map only
    // rotates while navMode is true (see the headingUp={navMode &&
    // headingUp} prop passed to MapView), so exiting navigation already
    // shows North-Up regardless of this setting's stored value. Actively
    // resetting the setting itself would throw away the user's
    // preference the moment they exit, breaking "preserve all Navigation
    // Settings" for their next Start Navigation.
    setCurrentBearing(0)
  }

  // Phase 14: recenter map on user.
  // Bug 6 fix: this used to also force headingUp back on, silently
  // overriding a user who'd deliberately switched to North-Up — Recenter
  // now only ever moves the camera, never touches the heading preference.
  const handleRecenter = useCallback(() => {
    setFollowUser(true)
    setUserManuallyPanned(false)
  }, [])

  // Phase 14: user manually dragged — disable follow
  const handleMapDrag = useCallback(() => {
    if (navMode) {
      setFollowUser(false)
      setUserManuallyPanned(true)
    }
  }, [navMode])

  // Bug 6: Heading-Up is now a simple, explicit user toggle — one
  // handler that flips the preference. Recenter (above) never calls this.
  const handleToggleHeadingUp = useCallback(() => {
    setHeadingUp(h => {
      const next = !h
      if (next) { setFollowUser(true); setUserManuallyPanned(false) }
      else { setCurrentBearing(0) }
      return next
    })
  }, [])

  function handleToggleTracking() {
    if (tracking) {
      stopTracking(); setFollowUser(false); voice.cancel()
    } else {
      startTracking()
      if (routePath) setFollowUser(autoRecenter)
    }
  }

  // Phase 7: Navigate Again
  function handleNavigateAgain() {
    setArrived(false)
    setNavMode(false)
    if (destName && navDestination?.id) {
      const loc = locations.find(l => l.id === navDestination.id)
      if (loc) handleDirections(loc)
    }
  }

  // Phase 4.2 — Priority 2: Share deep link
  // Generates a proper URL that opens the app directly to this destination.
  async function handleShareLocation(locOverride) {
    const loc = locOverride || previewLoc
    if (!loc?.id) return

    const base = window.location.origin
    const deepLink = `${base}/location/${loc.id}`
    const shareName = displayLocationName(loc)
    const shareTitle = shareName
    const shareText = `Navigate to ${shareName} at SSN College of Engineering`

    try {
      if (navigator.share) {
        await navigator.share({ title: shareTitle, text: shareText, url: deepLink })
      } else {
        await navigator.clipboard.writeText(deepLink)
        // Brief toast feedback — we'll use a simple state flag
        setShareCopied(true)
        setTimeout(() => setShareCopied(false), 2500)
      }
    } catch {
      // User cancelled share sheet — not an error
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className={`home${navMode ? ' nav-mode' : ''}`}>

      {/* Map — full-height in nav mode */}
      <div
        className="map-layer"
        style={{
          bottom: navMode
            ? 0
            // Priority 3 fix (and Priority X.1, same reasoning): both the
            // route-preview sheet and the browse results sheet are floating
            // overlays whose visible height now changes as the user drags
            // them — pinning the map to a flat percentage here would leave
            // a gap (collapsed) or hide markers behind the sheet
            // (expanded). Tracking the SAME --sheet-h custom property
            // whichever sheet is mounted writes on every drag/snap frame
            // (useDraggableSheet) keeps the map's visible area exactly
            // matched to the sheet's real height at all times.
            : previewActive
              ? 'var(--sheet-h, 160px)'
              : sheetEmpty ? 0 : `var(--sheet-h, ${SHEET_HEIGHT}%)`
        }}
      >
        <MapView
          locations={locations}
          destinationId={destination}
          routePath={displayRoutePath}
          remainingPath={tracking ? remainingPath : displayRoutePath}
          onSelect={loc => setDestination(loc.id)}
          userPosition={position ? [position.lat, position.lng] : null}
          userAccuracy={accuracy ?? 0}
          acquiringGps={!!acquiringGps}
          followUser={followUser}
          dynamicZoom={dynamicZoom}
          zoom={17}
          previewTrigger={previewTrigger}
          // The user's own marker icon lives in Leaflet's markerPane, which
          // leaflet-rotate deliberately does NOT rotate along with the map
          // (only tilePane/overlayPane rotate — see node_modules/leaflet-
          // rotate/src/map/Map.js's rotatePane/norotatePane split). So once
          // the map itself is rotated to put the travel direction "up"
          // (headingUp active), the marker's own arrow must show only the
          // small RESIDUAL drift between the current live heading and the
          // map's last committed bearing — not the raw absolute heading —
          // or it doubly rotates and points the wrong way entirely. In
          // North-up mode the map isn't rotated at all, so the raw
          // absolute heading is exactly what should be shown, as before.
          userHeading={navMode
            ? (headingUp && mapHeading != null
                ? circDiff(mapHeading, smoothedHeading)
                : smoothedHeading)
            : null}
          mapHeading={navMode ? mapHeading : null}
          headingUp={navMode && headingUp}
          headingMode={headingMode}
          declutter={navMode}
          nextTurnDist={navMode ? nextTurn?.distanceM ?? null : null}
          remainingDist={navMode ? remainingDist : null}
          recalcVersion={recalcVersion}
          onMapDrag={handleMapDrag}
          onRotationChange={setCurrentBearing}
          onToggleHeadingUp={handleToggleHeadingUp}
        />
      </div>

      {/* ── Browse UI — hidden in navigation mode ── */}
      {!navMode && (
        <>
          <div className="search-overlay">
            <SearchBar value={query} onChange={setQuery} onSubmit={handleSearchSubmit} />
            {searchResults === null && <CategoryChips active={category} onChange={setCategory} />}
          </div>

          {/* Priority 11 (Phase 4.2.7) — the only feedback a user got
              before this fix, if they denied the location prompt on first
              launch, was silence: gpsError was only ever surfaced inside
              the nav-mode status bar, which never renders in browse mode
              with no route yet. This is the missing "clear prompt +
              retry" the requirement asks for. */}
          {gpsPermissionDenied && (
            <div className="location-permission-banner">
              <span className="location-permission-banner-icon">📍</span>
              <div className="location-permission-banner-text">
                <strong>Location access is off</strong>
                <span>Turn it on so the map can show where you are and navigate you across campus.</span>
              </div>
              <button className="location-permission-retry-btn" onClick={() => startTracking()}>
                Retry
              </button>
            </div>
          )}

          <CompassWidget
            active={tracking && hasRoute}
            position={position}
            destination={compassDestination}
          />

          {guidance && (
            <div className={`guidance-banner ${offRoute ? 'off-route' : ''}`}>{guidance}</div>
          )}

          {(routePath || tracking) && (
            <div className="status-bar">
              {tracking && (
                <span className="status-pill gps">
                  <span className="pulse-dot" />
                  {(() => {
                    if (!accuracy)       return 'Obtaining your location…'
                    if (accuracy > 1000) return 'No GPS Signal'
                    if (accuracy > 150)  return `Low GPS ±${Math.round(accuracy)}m`
                    if (acquiringGps)    return `Waiting… ±${Math.round(accuracy)}m`
                    if (accuracy <= 15)  return `GPS ±${Math.round(accuracy)}m ✓`
                    return `GPS ±${Math.round(accuracy)}m`
                  })()}
                </span>
              )}
              {recalculating && <span className="status-pill recalculating">🔄 Recalculating…</span>}
              {displayDist != null && (
                <span className={`status-pill route ${offRoute ? 'error' : ''}`}>
                  {formatDist(displayDist)}
                  {tracking && remainingDist != null ? ' remaining' : ''}
                </span>
              )}
              {displayEta != null && <span className="status-pill">~{displayEta} min</span>}
              <button className="voice-settings-trigger status-pill"
                onClick={() => setNavSettingsOpen(true)} aria-label="Navigation settings">
                {voice.settings.enabled ? '🔊' : '🔇'}
              </button>
              {routePath && <button className="status-clear" onClick={handleClear}>✕</button>}
              {(routeError || gpsError) && (
                <span className="status-pill error">{routeError || gpsError}</span>
              )}
            </div>
          )}

          {routeWarning && <div className="closure-banner">⚠️ {routeWarning}</div>}

          {/* Bottom sheet */}
          {previewActive ? (
            <div
              className={`results-sheet preview-mode tier-${previewSheet.tier}${previewSheet.dragging ? ' dragging' : ''}`}
              ref={previewSheet.sheetRef}
            >
              <button
                className="nav-sheet-grip"
                onPointerDown={previewSheet.onPointerDown}
                onClick={() => previewSheet.snapToTier(previewSheet.tier === 'collapsed' ? 'half' : 'collapsed')}
                aria-label="Drag or tap to resize route preview"
              >
                <div className="sheet-handle" />
              </button>

              {/* Bug 7 — always-visible collapsed row: Destination, ETA,
                  Distance, and a large Start Navigation button anchored to
                  the right. Only shown while collapsed — once expanded,
                  RoutePreviewPanel's own header/stats/actions cover the
                  same ground, so this doesn't duplicate it. */}
              {previewSheet.tier === 'collapsed' && (
                <div className="preview-collapsed-row">
                  <div className="preview-collapsed-info">
                    <div className="route-preview-dest" style={{ fontSize:'0.95rem' }}>
                      {previewLoc ? displayLocationName(previewLoc) : '—'}
                    </div>
                    {previewRoutes?.[0] && (
                      <div className="nav-dist-label" style={{ marginTop: 2 }}>
                        {previewRoutes[0].etaMinutes} min · {formatDist(previewRoutes[0].distanceM)}
                      </div>
                    )}
                    {/* Priority 9 — food court menu, visible immediately,
                        no need to drag the sheet open to see it. */}
                    {['food', 'dining'].includes(previewLoc?.category) && (
                      <VenueMenuInline venueId={previewLoc.id} />
                    )}
                  </div>
                  <button
                    className="preview-collapsed-start-btn"
                    onClick={handleStartNavigation}
                    disabled={!previewRoutes?.[0] || previewLoading}
                  >
                    Start Navigation
                  </button>
                </div>
              )}

              {(previewSheet.tier === 'half' || previewSheet.tier === 'full') && (
                <div className="nav-sheet-scroll">
                  <RoutePreviewPanel
                    destination={previewLoc}
                    routes={previewRoutes}
                    loading={previewLoading}
                    error={previewError}
                    onPreview={handlePreviewRoute}
                    onStart={handleStartNavigation}
                    onCancel={handleCancelPreview}
                  />
                </div>
              )}
            </div>
          ) : (
            <div
              className={`results-sheet browse-mode tier-${browseSheet.tier}${browseSheet.dragging ? ' dragging' : ''} ${sheetEmpty ? 'empty' : ''}`}
              ref={browseSheet.sheetRef}
            >
              <div
                className="browse-sheet-grip"
                onPointerDown={browseSheet.onPointerDown}
                onClick={browseSheet.cycleTier}
              >
                <div className="sheet-handle" />
              </div>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 18px 8px' }}>
                <div className="sheet-title" style={{ padding:0 }}>
                  {searchResults !== null ? `"${query}"` : 'Campus locations'}
                </div>
                <button className={`location-btn ${tracking ? 'active' : ''}`} onClick={handleToggleTracking}>
                  {tracking ? '📍 Tracking' : '📍 My location'}
                </button>
              </div>
              <div
                className={`sheet-list nav-sheet-scroll${browseSheet.dragging ? ' dragging' : ''}`}
                ref={resultsListRef}
                tabIndex={-1}
              >
                {searchResults === null && (
                  <NearbyFacilities locations={locations} fromLat={refLat} fromLng={refLng} onNavigate={handleDirections} />
                )}
                {loadError && <div className="state-message">{loadError}</div>}
                {!loadError && listItems.length === 0 && query.trim() && (
                  <div className="state-message">No matches found.</div>
                )}
                {listItems.map(loc => (
                  <LocationCard key={loc.id} location={loc}
                    onSelect={loc => setDestination(loc.id)}
                    onDirections={handleDirections}
                    isDestination={loc.id === destination}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ─────────────────────────────────────────────────────
          NAVIGATION MODE UI (Phase 1–7, 13, 14)
          ──────────────────────────────────────────────────── */}
      {navMode && !arrived && (
        <>
          {/* Phase 3 — Turn instruction card */}
          <div className="nav-instruction-card" ref={turnCardRef}>
            <div className="nav-turn-icon-wrap">
              <span className="nav-turn-icon">{nextTurn ? turnIcon(nextTurn.direction) : '↑'}</span>
            </div>
            <div className="nav-turn-details">
              <div className="nav-turn-label">
                {nextTurn ? turnLabel(nextTurn.direction) : 'Continue Straight'}
              </div>
              {nextTurn && (
                <div className="nav-turn-distance">In {formatDist(nextTurn.distanceM)}</div>
              )}
              {/* Phase 13: landmark hint */}
              {turnLandmark && (
                <div className="nav-turn-landmark">Near {turnLandmark.name}</div>
              )}
              {destName && (
                <div className="nav-dest-badge">→ {destName}</div>
              )}
            </div>
            {/* Recalculating indicator */}
            {recalculating && (
              <div className="nav-recalc-dot" title="Recalculating…">🔄</div>
            )}
          </div>

          {/* Phase 6 — Exit Navigation button */}
          <button className="nav-exit-btn" onClick={handleClear} aria-label="Exit navigation">
            ✕ Exit
          </button>

          {/* Priority 1 (Phase 4.3) — the Heading-Up toggle is now the
              native Leaflet rotate control rendered inside MapView (see
              the L.Control.Rotate override in MapView.jsx), not a
              separate React button here. It's always visible during
              navigation via the existing .app-navmode CSS, and heading-up
              itself already auto-activates the instant navCameraActive
              goes true (see the useNavCamera call above) — the button
              only ever reflects/flips that state, same as before. */}

          {/* The compass needle is a fully separate, purely informational
              overlay — "Show Compass" only ever hides/shows THIS, and can
              never touch the Heading-Up toggle. */}
          {showCompass && (
            <NavCompass mapHeading={currentBearing} headingUp={headingUp} />
          )}

          {/* Phase 6 — Prominent off-route / recalculating banner */}
          {(offRoute || recalculating) && (
            <div className={`off-route-banner${recalculating ? ' recalculating' : ''}`}>
              {recalculating ? '🔄 Recalculating Route…' : '⚠ Off Route Detected'}
            </div>
          )}

          {/* Priority 5 (Phase 4.2.5) — Navigation Status. Was GPS-accuracy-only
              text; now covers heading-up/compass state too so nothing about
              navigation initialization ever silently does nothing. Same pill
              (position/CSS unchanged), broader content. */}
          {navStatus && (
            <div className={`nav-gps-pill${navStatus.icon === '⚠' ? ' warn' : ''}`}>
              <span className="pulse-dot" />
              {navStatus.icon} {navStatus.text}
            </div>
          )}

          {/* Phase 4.2.2 — Draggable 3-snap-point navigation bottom sheet.
              Drag the grip (or tap it to cycle tiers) between Collapsed,
              Half Expanded and Fully Expanded. Positioning is handled
              entirely by useDraggableSheet via transform — this JSX only
              decides what content is mounted per tier. */}
          <div
            className={`nav-bottom-sheet tier-${navSheet.tier}${navSheet.dragging ? ' dragging' : ''}`}
            ref={navSheet.sheetRef}
          >
            <button
              className="nav-sheet-grip"
              onPointerDown={navSheet.onPointerDown}
              onClick={navSheet.cycleTier}
              aria-label="Drag or tap to resize navigation details"
            >
              <div className="sheet-handle" />
            </button>

            {/* Visible at every tier: Next Turn · Distance · ETA */}
            <div className="nav-bottom-row-collapsed">
              {nextTurn ? (
                <div className="nav-sheet-turn-compact">
                  <span className="nav-sheet-turn-icon">{turnIcon(nextTurn.direction)}</span>
                  <div>
                    <div className="nav-dist-big nav-turn-compact-label">{turnLabel(nextTurn.direction)}</div>
                    <div className="nav-dist-label">in {formatDist(nextTurn.distanceM)}</div>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="nav-dist-big nav-turn-compact-label">Continue Straight</div>
                  <div className="nav-dist-label">next turn</div>
                </div>
              )}
              <div className="nav-divider-v" />
              <div>
                <div className="nav-dist-big">{formatDist(displayDist)}</div>
                <div className="nav-dist-label">remaining</div>
              </div>
              <div className="nav-divider-v" />
              <div>
                <div className="nav-eta-big">{displayEta != null ? `${displayEta} min` : '—'}</div>
                <div className="nav-dist-label">estimated</div>
              </div>
            </div>

            {/* Half + Full tier: adds Arrival time, Destination, Event, Menu preview */}
            {(navSheet.tier === 'half' || navSheet.tier === 'full') && (
              <div className="nav-sheet-scroll">
                <div className="nav-bottom-expanded-content">
                  <div className="nav-expanded-row">
                    <span className="nav-expanded-label">Arrival time</span>
                    <span className="nav-expanded-value">{formatArrivalClock(displayEta)}</span>
                  </div>
                  <div className="nav-expanded-row">
                    <span className="nav-expanded-label">Destination</span>
                    <span className="nav-expanded-value">{destName || '—'}</span>
                  </div>
                  {offRoute && (
                    <div className="nav-expanded-row">
                      <span className="nav-expanded-label">Status</span>
                      <span className="nav-expanded-value" style={{ color:'var(--danger)' }}>⚠️ Off route</span>
                    </div>
                  )}
                  {navEventInfo?.name && (
                    <div className="nav-expanded-row">
                      <span className="nav-expanded-label">Event</span>
                      <span className="nav-expanded-value">{navEventInfo.name}</span>
                    </div>
                  )}

                  {['food', 'dining'].includes(navDestLoc?.category) && (
                    <div style={{ marginTop: 10 }}>
                      <VenueMenuCard venueId={navDestLoc.id} venueName={destName} />
                    </div>
                  )}

                  <div style={{ marginTop:14, display:'flex', gap:8 }}>
                    <button className="voice-settings-trigger status-pill" style={{ flex:1, justifyContent:'center' }}
                      onClick={() => setNavSettingsOpen(true)}>
                      ⚙ Navigation Settings
                    </button>
                  </div>
                </div>

                {/* Full tier only: turn-by-turn list, building details, share, end nav */}
                {navSheet.tier === 'full' && (
                  <div className="nav-bottom-full-content">
                    {(navEventInfo?.room || navEventInfo?.floor || navEventInfo?.wing || navEventInfo?.building) && (
                      <div className="nav-sheet-section">
                        <div className="nav-sheet-section-title">Building details</div>
                        {navEventInfo.building && (
                          <div className="nav-expanded-row">
                            <span className="nav-expanded-label">Building</span>
                            <span className="nav-expanded-value">{navEventInfo.building}</span>
                          </div>
                        )}
                        {navEventInfo.floor && (
                          <div className="nav-expanded-row">
                            <span className="nav-expanded-label">Floor</span>
                            <span className="nav-expanded-value">{navEventInfo.floor}</span>
                          </div>
                        )}
                        {navEventInfo.wing && (
                          <div className="nav-expanded-row">
                            <span className="nav-expanded-label">Wing</span>
                            <span className="nav-expanded-value">{navEventInfo.wing}</span>
                          </div>
                        )}
                        {navEventInfo.room && (
                          <div className="nav-expanded-row">
                            <span className="nav-expanded-label">Room</span>
                            <span className="nav-expanded-value">{navEventInfo.room}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {navDestLoc?.department && (
                      <div className="nav-sheet-section">
                        <div className="nav-sheet-section-title">Destination info</div>
                        <div className="nav-expanded-row">
                          <span className="nav-expanded-label">Department</span>
                          <span className="nav-expanded-value">{navDestLoc.department}</span>
                        </div>
                      </div>
                    )}

                    {allTurns.length > 0 && (
                      <div className="nav-sheet-section">
                        <div className="nav-sheet-section-title">Turn-by-turn</div>
                        <ol className="nav-turn-list">
                          {allTurns.map((t, i) => (
                            <li key={`${t.turnIndex}-${i}`} className="nav-turn-list-item">
                              <span className="nav-turn-list-icon">{turnIcon(t.direction)}</span>
                              <span className="nav-turn-list-label">{turnLabel(t.direction)}</span>
                              <span className="nav-turn-list-dist">{formatDist(t.distanceM)}</span>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}

                    <div className="nav-sheet-section" style={{ display:'flex', gap:8 }}>
                      <button className="arrival-btn secondary" style={{ flex:1 }} onClick={() => handleShareLocation(navDestLoc)}>
                        {shareCopied ? '✓ Link Copied!' : '↗ Share'}
                      </button>
                      <button className="arrival-btn primary" style={{ flex:1 }} onClick={handleClear}>
                        End Navigation
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Phase 7 — Arrival overlay */}
      {navMode && arrived && (
        <div className="arrival-overlay">
          <div className="arrival-card">
            <div className="arrival-emoji">🎯</div>
            <div className="arrival-title">You've Arrived!</div>
            <div className="arrival-subtitle">
              {destName && <span className="arrival-dest">{destName}</span>}
            </div>

            {/* Phase 11: Room / Floor / Wing guidance */}
            {navEventInfo && (navEventInfo.room || navEventInfo.floor || navEventInfo.wing) && (
              <div className="arrival-room-card">
                {navEventInfo.building && (
                  <div className="arrival-room-row">
                    <span className="arrival-room-label">Building</span>
                    <span className="arrival-room-value">{navEventInfo.building}</span>
                  </div>
                )}
                {navEventInfo.room && (
                  <div className="arrival-room-row">
                    <span className="arrival-room-label">Room</span>
                    <span className="arrival-room-value">{navEventInfo.room}</span>
                  </div>
                )}
                {navEventInfo.floor && (
                  <div className="arrival-room-row">
                    <span className="arrival-room-label">Floor</span>
                    <span className="arrival-room-value">{navEventInfo.floor}</span>
                  </div>
                )}
                {navEventInfo.wing && (
                  <div className="arrival-room-row">
                    <span className="arrival-room-label">Wing</span>
                    <span className="arrival-room-value">{navEventInfo.wing}</span>
                  </div>
                )}
                {navEventInfo.floor && (
                  <div className="arrival-room-hint">
                    📍 Proceed to the {navEventInfo.floor}
                    {navEventInfo.wing ? ` and take the ${navEventInfo.wing} corridor` : ''}.
                  </div>
                )}
              </div>
            )}

            {/* Phase 2: Events happening at this venue right now */}
            {arrivalEvents.length > 0 && (
              <div className="arrival-venue-events">
                <div className="arrival-venue-events-title">
                  🎉 {arrivalEvents.length === 1 ? 'Event happening here now' : 'Events happening here now'}
                </div>
                {arrivalEvents.map(ev => (
                  <div key={ev.id} className="arrival-venue-event-row">
                    <div className="arrival-venue-event-name">{ev.name}</div>
                    <div className="arrival-venue-event-time">{ev.start_time}–{ev.end_time}</div>
                    <button
                      className="arrival-venue-event-btn"
                      onClick={() => navigate(`/event/${ev.id}`)}
                    >
                      Details
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="arrival-actions">
              <button className="arrival-btn primary" onClick={handleClear}>Done</button>
              <button className="arrival-btn secondary" onClick={handleNavigateAgain}>
                Navigate Again
              </button>
              <button className="arrival-btn secondary" onClick={handleClear}>
                🔍 Go Somewhere Else
              </button>
              <button className="arrival-btn secondary" onClick={handleShareLocation}>
                {shareCopied ? '✓ Link Copied!' : '↗ Share Location'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Phase X — Feature 3: Route Feedback */}
      <RouteFeedbackDialog
        open={feedbackOpen}
        context={feedbackContext}
        onClose={() => setFeedbackOpen(false)}
      />

      <NavSettingsPanel
        voice={voice}
        open={navSettingsOpen}
        onClose={() => setNavSettingsOpen(false)}
        headingUp={headingUp}
        onToggleHeadingUp={handleToggleHeadingUp}
        headingMode={headingMode}
        onSetHeadingMode={setHeadingMode}
        showCompass={showCompass}
        onToggleShowCompass={setShowCompass}
        autoRecenter={autoRecenter}
        onToggleAutoRecenter={setAutoRecenter}
        dynamicZoom={dynamicZoom}
        onToggleDynamicZoom={setDynamicZoom}
      />

      {/* Phase 4.2 — Priority 1: single floating-control stack (right side).
          Recenter + Campus Copilot now live in ONE flex column, anchored
          to the live sheet height via --sheet-h, so they can never
          collide and always move together as the sheet expands/collapses. */}
      <div className="copilot-fab-stack" ref={fabStackHeightRef}>
        {navMode && !arrived && userManuallyPanned && (
          <button className="recenter-btn" onClick={handleRecenter} aria-label="Resume navigation follow">
            <span className="recenter-icon">⊙</span>
            <span className="recenter-label">Re-center</span>
          </button>
        )}
        <ChatbotWidget
          locations={locations}
          position={position}
          arrivedLocationId={arrived ? previewLoc?.id : null}
          arrivedLocationName={arrived ? (previewLoc ? displayLocationName(previewLoc) : null) : null}
          onPreviewRoute={handleDirections}
          onStartNavigation={startNavigationFromCopilot}
          onViewEventDetails={(eventId) => navigate(`/event/${eventId}`)}
          onCancelNavigation={handleClear}
        />
      </div>
    </div>
  )
}
