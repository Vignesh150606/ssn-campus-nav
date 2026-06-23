import { useEffect, useMemo, useRef, useState } from 'react'
import MapView from '../components/MapView'
import SearchBar from '../components/SearchBar'
import CategoryChips from '../components/CategoryChips'
import LocationCard from '../components/LocationCard'
import RoutePreviewPanel from '../components/RoutePreviewPanel'
import NearbyFacilities from '../components/NearbyFacilities'
import CompassWidget from '../components/CompassWidget'
import VoiceSettingsPanel from '../components/VoiceSettingsPanel'
import { getLocations, searchLocations, getRoute, getRouteFromCoords, getRoadSegments } from '../api'
import { useLocationContext } from '../context/LocationContext'
import { useVoiceGuidance } from '../hooks/useVoiceGuidance'
import { landmarksAlongPath } from '../utils/facilities'

const SHEET_HEIGHT = 38
const ENTRY_ID     = 'main-gate'

export default function Home() {
  const [locations, setLocations]         = useState([])
  const [query, setQuery]                 = useState('')
  const [searchResults, setSearchResults] = useState(null)
  const [category, setCategory]           = useState(null)
  const [destination, setDestination]     = useState(null)   // id, for marker highlighting
  const [routePath, setRoutePath]         = useState(null)
  const [routeDist, setRouteDist]         = useState(null)
  const [routeEta, setRouteEta]           = useState(null)
  const [routeWarning, setRouteWarning]   = useState(null)
  const [routeError, setRouteError]       = useState(null)
  const [followUser, setFollowUser]       = useState(false)
  const [loadError, setLoadError]         = useState(null)
  const [roadSegments, setRoadSegments]   = useState([])

  // --- Feature 4: route preview, before navigation actually starts ---
  const [previewActive, setPreviewActive]   = useState(false)
  const [previewLoc, setPreviewLoc]         = useState(null) // full location object
  const [previewRoutes, setPreviewRoutes]   = useState(null) // [{ distanceM, etaMinutes, landmarks }]
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError]     = useState(null)
  const [previewTrigger, setPreviewTrigger] = useState(0)    // bumped to force map fit-to-bounds

  // --- Feature 3: voice settings panel visibility ---
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false)

  const {
    position, accuracy, acquiringGps, tracking, error: gpsError,
    remainingPath, remainingDist, liveEta,
    guidance, offRoute, hasRoute,
    fullPath, fullDistance, fullEta, recalculating, recalcVersion,
    destination: navDestination, // {lat,lng,id} of the currently *active* route's target — used by the compass
    start: startTracking, stop: stopTracking,
    setRoute, clearRoute: clearGpsRoute,
  } = useLocationContext()

  const voice = useVoiceGuidance({ tracking, hasRoute, remainingDist, remainingPath, offRoute })

  // Bug fix: voice announcements (200m/100m/arrived/turns) need to be able
  // to fire again for the new path after an automatic recalculation, the
  // same way the visual guidance banner already does. recalcVersion only
  // increments when LocationProvider.maybeRecalculate() actually succeeds,
  // so this resets voice's one-shot dedup exactly then — not on first
  // mount (the ref starts equal to the current value, so the first run is
  // a no-op) and not on every render.
  const prevRecalcVersionRef = useRef(recalcVersion)
  useEffect(() => {
    if (recalcVersion !== prevRecalcVersionRef.current) {
      prevRecalcVersionRef.current = recalcVersion
      voice.resetForNewRoute()
    }
    // voice.resetForNewRoute is stable (useCallback with empty deps inside
    // useVoiceGuidance) but `voice` itself is a fresh object every render,
    // so depending on the whole object would make this effect re-run on
    // every render instead of only when recalcVersion actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recalcVersion, voice.resetForNewRoute])

  useEffect(() => {
    getLocations().then(setLocations).catch(e => setLoadError(e.message))
  }, [])

  useEffect(() => {
    // Used to label "route passes" landmarks in the preview panel (Feature 4).
    // Non-fatal if it fails — landmarks just won't include road names.
    getRoadSegments().then(setRoadSegments).catch(() => {})
  }, [])

  useEffect(() => {
    if (!query.trim()) { setSearchResults(null); return }
    const h = setTimeout(() =>
      searchLocations(query).then(setSearchResults).catch(e => setLoadError(e.message))
    , 250)
    return () => clearTimeout(h)
  }, [query])

  // Feature 1: while navigation is active, the authoritative full route is
  // whatever the context currently holds (it gets replaced wholesale on
  // recalculation) — derived directly here rather than copied into local
  // state via an effect, so there's only ever one source of truth and no
  // synchronizing effect needed.
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

  // --- Feature 4: open the preview panel for a destination instead of
  // starting navigation immediately. If the user is already being tracked,
  // preview/route from their live position; otherwise assume the standard
  // QR/poster flow and route from the main gate. ---
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

  // "Preview Route" inside the panel — zoom the map to show the whole route
  // without committing to live navigation yet.
  function handlePreviewRoute() {
    setPreviewTrigger(t => t + 1)
  }

  // "Start Navigation" inside the panel — this is the moment live tracking
  // (GPS watch, off-route detection, recalculation, voice) actually begins.
  function handleStartNavigation() {
    if (!previewLoc || !routePath) return
    voice.resetForNewRoute()
    setRoute(routePath, previewLoc.lat, previewLoc.lng, previewLoc.id)
    voice.announceNavigationStart()
    if (!tracking) startTracking()
    setFollowUser(true)
    setPreviewActive(false)
    setPreviewRoutes(null)
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
  }

  function handleToggleTracking() {
    if (tracking) {
      stopTracking(); setFollowUser(false)
      voice.cancel()
    } else {
      startTracking()
      if (routePath) setFollowUser(true)
    }
  }

  // What to show in status bar
  const displayDist = remainingDist ?? displayFullDist
  const displayEta  = liveEta ?? displayFullEta

  const compassDestination = navDestination?.id
    ? { lat: navDestination.lat, lng: navDestination.lng }
    : null

  return (
    <div className="home">
      <div className="map-layer" style={{ bottom: sheetEmpty ? 0 : `${SHEET_HEIGHT}%` }}>
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
        />
      </div>

      <div className="search-overlay">
        <SearchBar value={query} onChange={setQuery} />
        {searchResults === null && <CategoryChips active={category} onChange={setCategory} />}
      </div>

      {/* Feature 2: navigation compass — only while actively navigating */}
      <CompassWidget
        active={tracking && hasRoute}
        position={position}
        destination={compassDestination}
      />

      {/* Guidance banner — 200m, 100m, arrived, off-route, recalculated */}
      {guidance && (
        <div className={`guidance-banner ${offRoute ? 'off-route' : ''}`}>
          {guidance}
        </div>
      )}

      {/* Status bar */}
      {(routePath || tracking) && (
        <div className="status-bar">
          {tracking && (
            <span className="status-pill gps">
              <span className="pulse-dot" />
              {(() => {
                if (!accuracy)                    return 'Searching for GPS…'
                if (accuracy > 1000)              return 'No GPS Signal'
                if (accuracy > 150)               return `Low GPS  ±${Math.round(accuracy)}m`
                if (acquiringGps)                 return `Waiting… ±${Math.round(accuracy)}m`
                if (accuracy <= 15)               return `GPS ±${Math.round(accuracy)}m ✓`
                return `GPS ±${Math.round(accuracy)}m`
              })()}
            </span>
          )}
          {recalculating && (
            <span className="status-pill recalculating">🔄 Recalculating…</span>
          )}
          {displayDist != null && (
            <span className={`status-pill route ${offRoute ? 'error' : ''}`}>
              {displayDist >= 1000
                ? `${(displayDist/1000).toFixed(1)}km`
                : `${Math.round(displayDist)}m`}
              {tracking && remainingDist != null ? ' remaining' : ''}
            </span>
          )}
          {displayEta != null && (
            <span className="status-pill">~{displayEta} min</span>
          )}
          <button
            className="voice-settings-trigger status-pill"
            onClick={() => setVoiceSettingsOpen(true)}
            aria-label="Voice settings"
          >
            {voice.settings.enabled ? '🔊' : '🔇'}
          </button>
          {routePath && (
            <button className="status-clear" onClick={handleClear}>✕</button>
          )}
          {(routeError || gpsError) && (
            <span className="status-pill error">{routeError || gpsError}</span>
          )}
        </div>
      )}

      {/* Road closure warning */}
      {routeWarning && (
        <div className="closure-banner">⚠️ {routeWarning}</div>
      )}

      <VoiceSettingsPanel
        voice={voice}
        open={voiceSettingsOpen}
        onClose={() => setVoiceSettingsOpen(false)}
      />

      {/* Bottom sheet — swaps between the route preview panel (Feature 4)
          and the normal browse/search list depending on previewActive. */}
      {previewActive ? (
        <div className="results-sheet preview-mode">
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
        <div className={`results-sheet ${sheetEmpty ? 'empty' : ''}`}>
          <div className="sheet-handle" />
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'4px 18px 8px' }}>
            <div className="sheet-title" style={{ padding:0 }}>
              {searchResults !== null ? `"${query}"` : 'Campus locations'}
            </div>
            <button
              className={`location-btn ${tracking ? 'active' : ''}`}
              onClick={handleToggleTracking}
            >
              {tracking ? '📍 Tracking' : '📍 My location'}
            </button>
          </div>
          <div className="sheet-list">
            {searchResults === null && (
              <NearbyFacilities
                locations={locations}
                fromLat={refLat}
                fromLng={refLng}
                onNavigate={handleDirections}
              />
            )}
            {loadError && <div className="state-message">{loadError}</div>}
            {!loadError && listItems.length === 0 && query.trim() && (
              <div className="state-message">No matches found.</div>
            )}
            {listItems.map(loc => (
              <LocationCard
                key={loc.id}
                location={loc}
                onSelect={loc => setDestination(loc.id)}
                onDirections={handleDirections}
                isDestination={loc.id === destination}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
