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
import VoiceSettingsPanel from '../components/VoiceSettingsPanel'
import ChatbotWidget from '../copilot/ChatbotWidget'
import { getLocations, searchLocations, getRoute, getRouteFromCoords, getRoadSegments, getEvents } from '../api'
import { useLocationContext } from '../context/LocationContext'
import { useVoiceGuidance } from '../hooks/useVoiceGuidance'
import { useCompassHeading } from '../hooks/useCompassHeading'
import { useNavCamera } from '../hooks/useNavCamera'
import { useElementHeightVar } from '../hooks/useElementHeightVar'
import { landmarksAlongPath } from '../utils/facilities'
import { computeUpcomingTurn, haversine } from '../utils/geo'

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
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false)

  // ── Phase 1: Navigation mode state ─────────────────────────────────────
  const [navMode, setNavMode]                     = useState(false)
  // Phase 11: room/floor/wing info from event navigation
  const [navEventInfo, setNavEventInfo]           = useState(null)  // {room,floor,wing,building}
  // ── Phase 5: Bottom sheet expansion ────────────────────────────────────
  const [navSheetExpanded, setNavSheetExpanded]   = useState(false)
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

  const {
    position, accuracy, acquiringGps, tracking, error: gpsError,
    remainingPath, remainingDist, liveEta,
    guidance, offRoute, hasRoute,
    fullPath, fullDistance, fullEta, recalculating, recalcVersion,
    destination: navDestination,
    arrivalRadius,
    start: startTracking, stop: stopTracking,
    setRoute, clearRoute: clearGpsRoute,
  } = useLocationContext()

  const voice = useVoiceGuidance({ tracking, hasRoute, remainingDist, remainingPath, offRoute })

  // Phase 4.2 — Priority 1: floating controls track the REAL rendered
  // height of whichever bottom sheet is currently showing (browse results
  // sheet, route preview sheet, or nav-mode sheet — collapsed/expanded),
  // and the floating button stack's own height, instead of hardcoded
  // pixel offsets that desync the moment the sheet's actual height
  // changes. See useElementHeightVar for details.
  const sheetHeightRef    = useElementHeightVar('--sheet-h')
  const fabStackHeightRef = useElementHeightVar('--fab-stack-h')

  // Phase 4 + 4A: compass heading + premium smoothing
  const { heading: rawHeading } = useCompassHeading(navMode && tracking)
  // Phase 4A: smooth the raw heading → two outputs:
  //   smoothedHeading: fine-grained, used for the user marker arrow
  //   mapHeading:      coarser, used for map rotation to avoid micro-oscillations
  const navCameraActive = navMode && tracking && !acquiringGps
  const { smoothedHeading, mapHeading } = useNavCamera(rawHeading, navCameraActive)

  // Reset voice dedup on recalculation
  const prevRecalcVersionRef = useRef(recalcVersion)
  useEffect(() => {
    if (recalcVersion !== prevRecalcVersionRef.current) {
      prevRecalcVersionRef.current = recalcVersion
      voice.resetForNewRoute()
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
      setFollowUser(true)
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

  // Phase 4.2 — Priority 2: handle /location/:id deep links.
  // LocationDeepLink.jsx fetches the location then navigates here with
  // state.deepLinkLocation set. We pick it up once on mount and open
  // the route preview sheet exactly as if the user tapped the card.
  useEffect(() => {
    const loc = routerLocation.state?.deepLinkLocation
    if (loc && loc.id) {
      // Clear the state so a back-navigation doesn't re-trigger this
      window.history.replaceState({}, '')
      // Wait for locations to load before calling handleDirections
      // (handleDirections itself is stable; the locations list is used
      //  for landmark labels but isn't required for the route fetch)
      handleDirections(loc)
    }
  // Only run on mount — handleDirections is defined below but is stable
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  const mainGateLoc = useMemo(() => locations.find(l => l.id === ENTRY_ID), [locations])
  const refLat = position?.lat ?? mainGateLoc?.lat ?? null
  const refLng = position?.lng ?? mainGateLoc?.lng ?? null

  // Destination name for nav UI
  const destName = useMemo(() => {
    if (previewLoc?.name) return previewLoc.name
    if (navDestination?.id) return locations.find(l => l.id === navDestination.id)?.name || null
    return null
  }, [previewLoc, navDestination, locations])

  // Phase 3 + 13: compute upcoming turn with landmark hint
  const nextTurn = useMemo(() => {
    if (!navMode || !remainingPath?.length) return null
    return computeUpcomingTurn(remainingPath)
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
      const r = (tracking && position)
        ? await getRouteFromCoords(position.lat, position.lng, loc.id)
        : await getRoute(ENTRY_ID, loc.id)
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
  }

  function handleStartNavigation() {
    if (!previewLoc || !routePath) return
    voice.resetForNewRoute()
    setRoute(routePath, previewLoc.lat, previewLoc.lng, previewLoc.id)
    voice.announceNavigationStart()
    if (!tracking) startTracking()
    setFollowUser(true)
    setPreviewActive(false)
    setPreviewRoutes(null)
    // Phase 1: enter navigation mode
    setNavMode(true)
    setNavSheetExpanded(false)
    setArrived(false)
    setUserManuallyPanned(false)
    // Phase 4A: start in heading-up mode
    setHeadingUp(true)
  }

  // Campus Copilot (Phase 1): start navigation directly from a chat card,
  // skipping the preview-panel step. Mirrors handleDirections +
  // handleStartNavigation above but fetches the route and applies it in
  // one go (no reliance on intermediate state having flushed yet), and
  // optionally carries classroom room/floor info into the existing
  // arrival-screen mechanism (navEventInfo) used by event navigation.
  async function startNavigationFromCopilot(loc, eventInfo = null) {
    try {
      const r = (tracking && position)
        ? await getRouteFromCoords(position.lat, position.lng, loc.id)
        : await getRoute(ENTRY_ID, loc.id)
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
      setFollowUser(true)
      setPreviewActive(false)
      setPreviewRoutes(null)
      setNavMode(true)
      setNavSheetExpanded(false)
      setArrived(false)
      setUserManuallyPanned(false)
      // Phase 4A: start in heading-up mode
      setHeadingUp(true)
      if (eventInfo) setNavEventInfo(eventInfo)
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
    setRoutePath(null); setRouteDist(null); setRouteEta(null)
    setRouteWarning(null); setRouteError(null); setDestination(null)
    setFollowUser(false)
    setPreviewActive(false); setPreviewRoutes(null); setPreviewLoc(null)
    clearGpsRoute()
    voice.cancel()
    // Phase 1: exit navigation mode
    setNavMode(false)
    setArrived(false)
    setNavSheetExpanded(false)
    setUserManuallyPanned(false)
    setNavEventInfo(null)
    setArrivalEvents([])
    // Phase 4A: reset heading-up on exit
    setHeadingUp(false)
    setCurrentBearing(0)
  }

  // Phase 14: recenter map on user
  const handleRecenter = useCallback(() => {
    setFollowUser(true)
    setUserManuallyPanned(false)
    // Phase 4A: restore heading-up when recentering
    setHeadingUp(true)
  }, [])

  // Phase 14: user manually dragged — disable follow
  const handleMapDrag = useCallback(() => {
    if (navMode) {
      setFollowUser(false)
      setUserManuallyPanned(true)
    }
  }, [navMode])

  // Phase 4A: compass tap handlers
  const handleNorthUp = useCallback(() => {
    setHeadingUp(false)
    setCurrentBearing(0)
  }, [])

  const handleHeadingUp = useCallback(() => {
    setHeadingUp(true)
    setFollowUser(true)
    setUserManuallyPanned(false)
  }, [])

  function handleToggleTracking() {
    if (tracking) {
      stopTracking(); setFollowUser(false); voice.cancel()
    } else {
      startTracking()
      if (routePath) setFollowUser(true)
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
  async function handleShareLocation() {
    const loc = previewLoc
    if (!loc?.id) return

    const base = window.location.origin
    const deepLink = `${base}/location/${loc.id}`
    const shareTitle = loc.name
    const shareText = `Navigate to ${loc.name} at SSN College of Engineering`

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
        style={{ bottom: navMode ? 0 : sheetEmpty ? 0 : `${SHEET_HEIGHT}%` }}
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
          zoom={17}
          previewTrigger={previewTrigger}
          userHeading={navMode && !acquiringGps ? smoothedHeading : null}
          mapHeading={navMode && !acquiringGps ? mapHeading : null}
          headingUp={navMode && headingUp}
          nextTurnDist={navMode ? nextTurn?.distanceM ?? null : null}
          remainingDist={navMode ? remainingDist : null}
          recalcVersion={recalcVersion}
          onMapDrag={handleMapDrag}
          onRotationChange={setCurrentBearing}
        />
      </div>

      {/* ── Browse UI — hidden in navigation mode ── */}
      {!navMode && (
        <>
          <div className="search-overlay">
            <SearchBar value={query} onChange={setQuery} />
            {searchResults === null && <CategoryChips active={category} onChange={setCategory} />}
          </div>

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
                    if (!accuracy)       return 'Searching GPS…'
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
                onClick={() => setVoiceSettingsOpen(true)} aria-label="Voice settings">
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
            <div className="results-sheet preview-mode" ref={sheetHeightRef}>
              <div className="sheet-handle" />
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
          ) : (
            <div className={`results-sheet ${sheetEmpty ? 'empty' : ''}`} ref={sheetHeightRef}>
              <div className="sheet-handle" />
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'4px 18px 8px' }}>
                <div className="sheet-title" style={{ padding:0 }}>
                  {searchResults !== null ? `"${query}"` : 'Campus locations'}
                </div>
                <button className={`location-btn ${tracking ? 'active' : ''}`} onClick={handleToggleTracking}>
                  {tracking ? '📍 Tracking' : '📍 My location'}
                </button>
              </div>
              <div className="sheet-list">
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
          <div className="nav-instruction-card">
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

          {/* Phase 4A — Navigation compass (shows when map is rotated away from North) */}
          <NavCompass
            mapHeading={currentBearing}
            headingUp={headingUp}
            onNorthUp={handleNorthUp}
            onHeadingUp={handleHeadingUp}
          />

          {/* Phase 6 — Prominent off-route / recalculating banner */}
          {(offRoute || recalculating) && (
            <div className={`off-route-banner${recalculating ? ' recalculating' : ''}`}>
              {recalculating ? '🔄 Recalculating Route…' : '⚠ Off Route Detected'}
            </div>
          )}

          {/* GPS status pill during navigation */}
          {tracking && accuracy && (
            <div className="nav-gps-pill">
              <span className="pulse-dot" />
              {acquiringGps ? `Acquiring ±${Math.round(accuracy)}m` : `±${Math.round(accuracy)}m`}
            </div>
          )}

          {/* Phase 5 — Navigation bottom sheet */}
          <div className={`nav-bottom-sheet ${navSheetExpanded ? 'expanded' : ''}`} ref={sheetHeightRef}>
            <button
              className="nav-sheet-grip"
              onClick={() => setNavSheetExpanded(e => !e)}
              aria-label={navSheetExpanded ? 'Collapse' : 'Expand navigation details'}
            >
              <div className="sheet-handle" />
            </button>

            {/* Collapsed: distance + ETA */}
            <div className="nav-bottom-row-collapsed">
              <div>
                <div className="nav-dist-big">{formatDist(displayDist)}</div>
                <div className="nav-dist-label">remaining</div>
              </div>
              <div className="nav-divider-v" />
              <div>
                <div className="nav-eta-big">{displayEta != null ? `${displayEta} min` : '—'}</div>
                <div className="nav-dist-label">estimated</div>
              </div>
              {destName && (
                <>
                  <div className="nav-divider-v" />
                  <div style={{ flex:1, overflow:'hidden' }}>
                    <div className="nav-dest-name-small" style={{ fontFamily:'var(--font-display)', fontWeight:700, fontSize:'0.82rem', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{destName}</div>
                    <div className="nav-dist-label">destination</div>
                  </div>
                </>
              )}
            </div>

            {/* Expanded: full details */}
            {navSheetExpanded && (
              <div className="nav-bottom-expanded-content">
                <div className="nav-expanded-row">
                  <span className="nav-expanded-label">Destination</span>
                  <span className="nav-expanded-value">{destName || '—'}</span>
                </div>
                {nextTurn && (
                  <div className="nav-expanded-row">
                    <span className="nav-expanded-label">Next turn</span>
                    <span className="nav-expanded-value">
                      {turnIcon(nextTurn.direction)} {turnLabel(nextTurn.direction)} in {formatDist(nextTurn.distanceM)}
                    </span>
                  </div>
                )}
                <div className="nav-expanded-row">
                  <span className="nav-expanded-label">Distance</span>
                  <span className="nav-expanded-value">{formatDist(displayDist)}</span>
                </div>
                <div className="nav-expanded-row">
                  <span className="nav-expanded-label">ETA</span>
                  <span className="nav-expanded-value">{displayEta != null ? `~${displayEta} min` : '—'}</span>
                </div>
                {offRoute && (
                  <div className="nav-expanded-row">
                    <span className="nav-expanded-label">Status</span>
                    <span className="nav-expanded-value" style={{ color:'var(--danger)' }}>⚠️ Off route</span>
                  </div>
                )}
                <div style={{ marginTop:14, display:'flex', gap:8 }}>
                  <button className="voice-settings-trigger status-pill" style={{ flex:1, justifyContent:'center' }}
                    onClick={() => setVoiceSettingsOpen(true)}>
                    {voice.settings.enabled ? '🔊 Voice On' : '🔇 Voice Off'}
                  </button>
                </div>
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

      <VoiceSettingsPanel voice={voice} open={voiceSettingsOpen} onClose={() => setVoiceSettingsOpen(false)} />

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
          arrivedLocationName={arrived ? previewLoc?.name : null}
          onPreviewRoute={handleDirections}
          onStartNavigation={startNavigationFromCopilot}
          onViewEventDetails={(eventId) => navigate(`/event/${eventId}`)}
          onCancelNavigation={handleClear}
        />
      </div>
    </div>
  )
}
