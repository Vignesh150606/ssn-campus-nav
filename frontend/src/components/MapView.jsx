/**
 * MapView — Phase 4A Premium Google Maps Navigation Experience
 *
 * New features:
 *  1. True Heading-Up navigation via leaflet-rotate (map.setBearing)
 *  2. Google Maps-style camera: user in lower-third with look-ahead
 *  3. Smart dynamic zoom: only changes near turns / destination / reroute
 *  4. Premium Google Maps-style user location marker (arrow + dot)
 *  5. Premium route rendering: thick blue line with subtle glow
 *  6. Smooth transitions on all camera / rotation / zoom changes
 *
 * Unchanged:
 *  - GPX / KML / Dijkstra / routing graph — not touched
 *  - Campus Copilot, Supabase, events, search — not touched
 *  - Voice guidance, rerouting logic — not touched
 */

// ── leaflet-rotate must be imported BEFORE L/MapContainer so it can
//    patch L.Map.prototype with setBearing / getBearing.
import 'leaflet-rotate'

import { useEffect, useRef, useCallback } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, useMap, Circle } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { CATEGORY_META } from '../constants'

// Root-cause hardening (post-4A crash fix): leaflet-rotate's own patches to
// L.Marker, L.GridLayer, L.Popup, L.Tooltip and L.SVG/L.Canvas (Renderer)
// all read/write `el._leaflet_pos` via L.DomUtil.getPosition/setPosition
// without checking that `el` is defined first — confirmed by reading the
// plugin's source directly (e.g. its GridLayer.getEvents() reads
// `this._map._rotate` with no null-check on `this._map`, and several
// layers read `getPosition(this._container)`/`getPosition(marker._icon)`
// the same way). In a single-page app, these can fire from a throttled
// callback (leaflet-rotate throttles GridLayer's 'rotate' → tile reposition)
// that lands a tick *after* React/react-leaflet has already torn the map
// down and removed those DOM elements — at which point the element is
// undefined and the read throws, crashing whatever happens to be mounted
// at that moment (which looked, from the outside, like an unrelated page
// being "randomly blank").
//
// Rather than patch the library in node_modules (lost on every reinstall)
// or chase every individual call site across 5+ files, this wraps the two
// shared primitives every one of those call sites funnels through, so an
// undefined element becomes a safe no-op instead of a thrown TypeError —
// closing the entire class of bug at its root, regardless of which layer
// type triggers it. This runs once, at module load, after the imports
// above have finished executing (leaflet-rotate's own monkey-patch of
// these same two functions has already applied by this point, so this
// wraps ITS versions, not the original Leaflet ones).
const _getPosition = L.DomUtil.getPosition
const _setPosition = L.DomUtil.setPosition
L.DomUtil.getPosition = function (el) {
  if (!el) return new L.Point(0, 0)
  return _getPosition.call(this, el)
}
L.DomUtil.setPosition = function (el, ...rest) {
  if (!el) return
  return _setPosition.call(this, el, ...rest)
}

export const CAMPUS_CENTER = [12.7510, 80.1970]

// ─────────────────────────────────────────────────────────────────────────────
//  Location / destination markers
// ─────────────────────────────────────────────────────────────────────────────

function markerIcon(category, isDestination) {
  const color = CATEGORY_META[category]?.color || '#6B7280'

  if (isDestination) {
    return L.divIcon({
      className: '',
      html: `<svg width="32" height="40" viewBox="0 0 32 40" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id="pin-shadow" x="-30%" y="-10%" width="160%" height="140%">
            <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="rgba(0,0,0,0.35)"/>
          </filter>
        </defs>
        <g filter="url(#pin-shadow)">
          <path d="M16 2C9.4 2 4 7.4 4 14c0 8.4 12 24.5 12 24.5S28 22.4 28 14C28 7.4 22.6 2 16 2z"
            fill="${color}" stroke="white" stroke-width="2"/>
        </g>
        <circle cx="16" cy="14" r="5.5" fill="white" opacity="0.95"/>
      </svg>`,
      iconSize: [32, 40],
      iconAnchor: [16, 40],
    })
  }

  const size = 14
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;
      background:${color};border:2.5px solid #fff;
      box-shadow:0 1px 5px rgba(0,0,0,0.35);"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

// ─────────────────────────────────────────────────────────────────────────────
//  Premium user location marker  (Google Maps style)
// ─────────────────────────────────────────────────────────────────────────────

function userIcon(acquiring, heading) {
  const CX = 24, CY = 24   // SVG centre in a 48×48 canvas

  if (!acquiring && heading != null) {
    // ── Navigation mode: blue direction arrow ──────────────────────────
    return L.divIcon({
      className: '',
      html: `<svg width="48" height="48" viewBox="0 0 48 48"
          xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
        <defs>
          <filter id="u-shadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="rgba(37,99,235,0.45)"/>
          </filter>
        </defs>

        <!-- Heading cone / beam (soft, semi-transparent) -->
        <path
          d="M ${CX} 6
             L ${CX - 11} ${CY + 4}
             Q ${CX} ${CY - 3} ${CX + 11} ${CY + 4} Z"
          fill="rgba(66,133,244,0.22)"
          transform="rotate(${heading},${CX},${CY})"
        />

        <!-- White halo (gives the dot contrast against any tile colour) -->
        <circle cx="${CX}" cy="${CY}" r="13" fill="white" filter="url(#u-shadow)"/>
        <!-- Main blue dot -->
        <circle cx="${CX}" cy="${CY}" r="11" fill="#4285F4"/>
        <!-- Subtle inner highlight -->
        <circle cx="${CX}" cy="${CY - 3.5}" r="3.5" fill="rgba(255,255,255,0.4)"/>

        <!-- Arrow head pointing in heading direction (white) -->
        <polygon
          points="${CX},${CY - 10} ${CX - 5},${CY - 1} ${CX + 5},${CY - 1}"
          fill="white"
          transform="rotate(${heading},${CX},${CY})"
        />
      </svg>`,
      iconSize: [48, 48],
      iconAnchor: [24, 24],
    })
  }

  if (acquiring) {
    // ── GPS acquiring: amber pulsing dot ──────────────────────────────
    return L.divIcon({
      className: '',
      html: `<div style="position:relative;width:26px;height:26px">
        <div style="position:absolute;inset:0;border-radius:50%;
          background:rgba(217,119,6,0.2);animation:gps-pulse 1.8s ease-out infinite"></div>
        <div style="position:absolute;top:50%;left:50%;
          transform:translate(-50%,-50%);
          width:16px;height:16px;border-radius:50%;
          background:#D97706;border:3px solid #fff;
          box-shadow:0 2px 8px rgba(217,119,6,0.55)"></div>
      </div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    })
  }

  // ── Normal: blue location dot ──────────────────────────────────────
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:26px;height:26px">
      <div style="position:absolute;inset:0;border-radius:50%;
        background:rgba(66,133,244,0.20);animation:gps-pulse 1.8s ease-out infinite"></div>
      <div style="position:absolute;top:50%;left:50%;
        transform:translate(-50%,-50%);
        width:16px;height:16px;border-radius:50%;
        background:#4285F4;border:3px solid #fff;
        box-shadow:0 2px 8px rgba(66,133,244,0.5)"></div>
    </div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  })
}

// ─────────────────────────────────────────────────────────────────────────────
//  NavigationController — heading-up rotation + camera + smart zoom
// ─────────────────────────────────────────────────────────────────────────────

const ZOOM_WALK   = 17      // default walking zoom
const ZOOM_CLOSE  = 18.5   // near turn or destination
const TURN_ZOOM_M = 50     // metres to turn → trigger close zoom
const DEST_ZOOM_M = 80     // metres to dest → trigger close zoom
const EARTH_R     = 6371000

function NavigationController({
  heading,          // smoothed map-rotation heading (degrees, null = no compass)
  headingUp,        // boolean — heading-up mode active
  followUser,       // boolean — camera should track user
  userPosition,     // {lat, lng} or null
  remainingDist,    // metres remaining to destination
  nextTurnDist,     // metres to the next turn
  recalcVersion,    // increments whenever route is recalculated
  routePath,        // full route path (for fit-bounds after reroute)
  onRotationChange, // callback(degrees) — informs parent of current bearing
}) {
  const map = useMap()
  const lastPosRef    = useRef(null)
  const zoomTimerRef  = useRef(null)
  const fitTimerRef   = useRef(null)
  const prevRecalcRef = useRef(recalcVersion ?? 0)

  // Root-cause fix (post-4A): `map.remove()` (called by MapContainer's own
  // unmount effect) sets `_mapPane` to null among other teardown steps, but
  // doesn't synchronously cancel everything leaflet-rotate has scheduled —
  // notably its GridLayer patch throttles tile repositioning off the
  // map's 'rotate' event. If anything here calls `map.setBearing()` (which
  // fires 'rotate') during or near unmount, that throttled tile callback
  // can fire AFTER the map/tiles are gone, reading a removed tile's
  // internal position field and throwing — which, because it happens
  // inside a React effect, takes the whole tree down via the nearest
  // error boundary instead of staying a contained map-internal error.
  // `isMapAlive()` is the standard Leaflet idiom for "has .remove() been
  // called on this instance" and guards every map mutation below.
  const isMapAlive = useCallback(() => !!map && !!map._mapPane, [map])

  // ── Helper: set bearing + notify parent ────────────────────────────
  const applyBearing = useCallback((deg) => {
    if (!isMapAlive() || !map._rotate) return
    map.setBearing(deg)
    onRotationChange?.(deg)
  }, [map, isMapAlive, onRotationChange])

  const resetBearing = useCallback(() => {
    if (!isMapAlive() || !map._rotate) return
    map.setBearing(0)
    onRotationChange?.(0)
  }, [map, isMapAlive, onRotationChange])

  // ── Heading-up rotation ────────────────────────────────────────────
  // headingUp=false → always reset to North
  // headingUp=true + !followUser → PAUSE at current bearing (user is panning)
  // headingUp=true + followUser + heading available → rotate to heading
  useEffect(() => {
    if (!headingUp) {
      resetBearing()
      return
    }
    if (!followUser || heading == null) return   // pause — keep current bearing
    applyBearing(heading)
  }, [heading, headingUp, followUser, applyBearing, resetBearing])

  // ── Camera follow + look-ahead (lower-third positioning) ───────────
  useEffect(() => {
    if (!followUser || !userPosition || !isMapAlive()) return

    const { lat, lng } = userPosition

    // Skip sub-metre position jitter
    const prev = lastPosRef.current
    if (prev &&
        Math.abs(prev.lat - lat) < 0.000004 &&
        Math.abs(prev.lng - lng) < 0.000004) return
    lastPosRef.current = { lat, lng }

    let targetLat = lat
    let targetLng = lng

    // In heading-up mode, offset camera centre "ahead" of the user so
    // that the user appears in the lower ~35% of the screen.
    if (headingUp && heading != null) {
      const zoom = map.getZoom()
      const size = map.getSize()
      // Metres per screen pixel at this zoom & latitude
      const mpx = (40075016.686 * Math.cos(lat * Math.PI / 180)) /
                  Math.pow(2, zoom + 8)
      // Look ahead ~22% of screen height worth of real-world distance
      const lookaheadM = size.y * 0.22 * mpx
      const hRad = (heading * Math.PI) / 180
      targetLat = lat + (Math.cos(hRad) * lookaheadM / EARTH_R) * (180 / Math.PI)
      targetLng = lng + (Math.sin(hRad) * lookaheadM / EARTH_R) *
                  (180 / Math.PI) / Math.cos(lat * Math.PI / 180)
    }

    map.panTo([targetLat, targetLng], {
      animate: true,
      duration: 0.65,
      easeLinearity: 0.5,
      noMoveStart: true,
    })
  }, [userPosition, followUser, headingUp, heading, map])

  // ── Smart dynamic zoom ─────────────────────────────────────────────
  // Only changes near turns, near destination, or after rerouting.
  // Never oscillates — guarded by threshold + debounce.
  useEffect(() => {
    if (!followUser || !isMapAlive()) return

    let target = ZOOM_WALK
    if      (remainingDist != null && remainingDist < DEST_ZOOM_M) target = ZOOM_CLOSE
    else if (nextTurnDist  != null && nextTurnDist  < TURN_ZOOM_M) target = ZOOM_CLOSE

    const current = map.getZoom()
    if (Math.abs(current - target) < 0.25) return   // already close enough

    if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current)
    zoomTimerRef.current = setTimeout(() => {
      // Guard again: this fires after a 300ms delay, during which the
      // component may have unmounted (e.g. user navigated away).
      if (!isMapAlive()) return
      map.setZoom(target, { animate: true })
    }, 300)
  }, [remainingDist, nextTurnDist, followUser, map, isMapAlive])

  // ── Fit-bounds after route recalculation ──────────────────────────
  useEffect(() => {
    const rv = recalcVersion ?? 0
    if (rv <= 0 || rv === prevRecalcRef.current) return
    prevRecalcRef.current = rv
    if (!routePath?.length) return
    fitTimerRef.current = setTimeout(() => {
      if (!isMapAlive()) return
      try {
        const bounds = L.latLngBounds(routePath.map(p => [p.lat, p.lng]))
        map.fitBounds(bounds, { padding: [60, 80], animate: true })
      } catch { /* ignore edge-case bound errors */ }
    }, 600)
    return () => { if (fitTimerRef.current) clearTimeout(fitTimerRef.current) }
  }, [recalcVersion, routePath, map, isMapAlive])

  // ── Cleanup ────────────────────────────────────────────────────────
  // Deliberately does NOT call resetBearing()/setBearing() here. The map
  // is being torn down (MapContainer's own unmount effect calls
  // map.remove() right around this same point) — there is nothing to
  // visually "reset" on a map instance that's about to be destroyed, and
  // calling setBearing() this late is exactly what caused the crash
  // described above. Only timers need clearing.
  useEffect(() => {
    return () => {
      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current)
      if (fitTimerRef.current) clearTimeout(fitTimerRef.current)
    }
  }, [])

  return null
}

// ─────────────────────────────────────────────────────────────────────────────
//  Utility Leaflet sub-components (unchanged from original)
// ─────────────────────────────────────────────────────────────────────────────

function FitToRoute({ path }) {
  const map = useMap()
  useEffect(() => {
    if (path?.length >= 2) {
      const bounds = L.latLngBounds(path.map(p => [p.lat, p.lng]))
      map.fitBounds(bounds, { padding: [60, 60] })
    }
  }, [path, map])
  return null
}

function FitToBoundsOnTrigger({ path, trigger }) {
  const map = useMap()
  useEffect(() => {
    if (!trigger || !(path?.length >= 2)) return
    const bounds = L.latLngBounds(path.map(p => [p.lat, p.lng]))
    map.fitBounds(bounds, { padding: [60, 60] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger])
  return null
}

function AutoResize() {
  const map = useMap()
  useEffect(() => {
    const obs = new ResizeObserver(() => map.invalidateSize())
    obs.observe(map.getContainer())
    return () => obs.disconnect()
  }, [map])
  return null
}

function DetectDrag({ onDrag }) {
  const map = useMap()
  const onDragRef = useRef(onDrag)
  useEffect(() => { onDragRef.current = onDrag }, [onDrag])
  useEffect(() => {
    const handler = () => onDragRef.current?.()
    map.on('dragstart', handler)
    return () => map.off('dragstart', handler)
  }, [map])
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
//  MapView — main export
// ─────────────────────────────────────────────────────────────────────────────

export default function MapView({
  locations = [],
  destinationId,
  routePath,
  remainingPath,
  onSelect,
  center,
  zoom = 17,
  userPosition,
  userAccuracy,
  acquiringGps,
  followUser,
  previewTrigger,
  /** Phase 4A: smoothed heading for the user marker arrow */
  userHeading = null,
  /** Phase 4A: heading used to rotate the map (slightly coarser threshold) */
  mapHeading = null,
  /** Phase 4A: true = heading-up mode; false = north-up */
  headingUp = false,
  /** Phase 4A: metres to next turn (smart zoom) */
  nextTurnDist = null,
  /** Phase 4A: metres remaining (smart zoom / near-destination zoom) */
  remainingDist = null,
  /** Phase 4A: increments on reroute → triggers zoom-to-fit */
  recalcVersion = 0,
  /** Phase 14: called when user manually drags the map */
  onMapDrag,
  /** Phase 4A: called with current bearing in degrees */
  onRotationChange,
}) {
  return (
    <MapContainer
      center={center || CAMPUS_CENTER}
      zoom={zoom}
      minZoom={15}
      style={{ height: '100%', width: '100%' }}
      zoomControl={true}
      /* leaflet-rotate: enable bearing/rotation support */
      rotate={true}
      bearing={0}
      touchRotate={false}      // disable pinch-to-rotate (use our programmatic API only)
      shiftKeyRotate={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {/* Campus location markers */}
      {locations.map(loc => (
        <Marker
          key={loc.id}
          position={[loc.lat, loc.lng]}
          icon={markerIcon(loc.category, loc.id === destinationId)}
          eventHandlers={{ click: () => onSelect?.(loc) }}
        />
      ))}

      {/* ── Route rendering ────────────────────────────────────────── */}

      {/* Full route ghost — shows the complete planned path as a light trail */}
      {routePath?.length >= 2 && (
        <Polyline
          positions={routePath.map(p => [p.lat, p.lng])}
          pathOptions={{
            color: '#94A3B8',
            weight: 6,
            opacity: 0.38,
            lineCap: 'round',
            lineJoin: 'round',
          }}
        />
      )}

      {/* Remaining route — subtle outer glow layer */}
      {remainingPath?.length >= 2 && (
        <Polyline
          positions={remainingPath.map(p => [p.lat, p.lng])}
          pathOptions={{
            color: '#1967D2',
            weight: 18,
            opacity: 0.14,
            lineCap: 'round',
            lineJoin: 'round',
          }}
        />
      )}

      {/* Remaining route — main Google Maps blue line */}
      {remainingPath?.length >= 2 && (
        <Polyline
          positions={remainingPath.map(p => [p.lat, p.lng])}
          pathOptions={{
            color: '#4285F4',
            weight: 8,
            opacity: 1,
            lineCap: 'round',
            lineJoin: 'round',
          }}
        />
      )}

      {/* ── GPS accuracy circle ─────────────────────────────────────── */}
      {userPosition && userAccuracy > 8 && (
        <Circle
          center={userPosition}
          radius={userAccuracy}
          pathOptions={{
            color: '#4285F4',
            fillColor: '#4285F4',
            fillOpacity: 0.07,
            weight: 1,
            opacity: 0.22,
          }}
        />
      )}

      {/* ── User position marker ────────────────────────────────────── */}
      {userPosition && (
        <Marker
          position={userPosition}
          icon={userIcon(acquiringGps, userHeading)}
          zIndexOffset={1000}
        />
      )}

      {/* ── Route preview fitting ───────────────────────────────────── */}
      {routePath?.length >= 2 && !userPosition && <FitToRoute path={routePath} />}
      {routePath?.length >= 2 && (
        <FitToBoundsOnTrigger path={routePath} trigger={previewTrigger} />
      )}

      {/* ── Navigation controller (camera / rotation / zoom) ────────── */}
      <NavigationController
        heading={mapHeading}
        headingUp={headingUp}
        followUser={followUser}
        userPosition={
          userPosition
            ? { lat: userPosition[0], lng: userPosition[1] }
            : null
        }
        remainingDist={remainingDist}
        nextTurnDist={nextTurnDist}
        recalcVersion={recalcVersion}
        routePath={routePath}
        onRotationChange={onRotationChange}
      />

      {/* ── Manual drag detection (Phase 14) ────────────────────────── */}
      {onMapDrag && <DetectDrag onDrag={onMapDrag} />}

      <AutoResize />
    </MapContainer>
  )
}
