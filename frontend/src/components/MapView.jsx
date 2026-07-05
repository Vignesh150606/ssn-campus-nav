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
      html: `<div style="position:relative;width:32px;height:40px">
        <div style="position:absolute;left:50%;bottom:1px;
          width:18px;height:18px;border-radius:50%;
          transform:translateX(-50%);
          background:${color};opacity:0.28;
          animation:dest-pulse 2.2s ease-out infinite"></div>
        <svg width="32" height="40" viewBox="0 0 32 40" xmlns="http://www.w3.org/2000/svg"
          style="position:relative">
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
        </svg>
      </div>`,
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
//  Premium user location marker  (Google Maps–inspired, not a copy)
//
//  Phase 4.2.6, Priority 3 — rebuilt as an IMPERATIVE Leaflet marker
//  instead of a React-managed <Marker icon={...}> that regenerated a
//  brand-new divIcon (with the heading baked directly into the SVG's
//  rotate transform) on every single heading/position update. A freshly
//  recreated DOM node has no "previous state" for a CSS transition to
//  animate from, so despite already having reasonable visuals, the old
//  marker could only ever SNAP between positions and rotations — it could
//  never actually move or turn smoothly, however good the artwork was.
//
//  This version keeps ONE stable DOM node per visual mode (acquiring /
//  browse dot / nav puck) and mutates it in place:
//   - position updates go through Leaflet's normal setLatLng (same DOM
//     node → its own translate3d transform can be CSS-transitioned)
//   - rotation updates mutate an INNER wrapper div directly, completely
//     separate from Leaflet's own position transform, so the two can
//     never fight over the same CSS property
//   - both apply the same wraparound-jump guard as the map's own bearing
//     (see applyBearingRaw above) so crossing 0°/360° doesn't spin the
//     long way around
// ─────────────────────────────────────────────────────────────────────────────

function userMarkerHtml(mode) {
  if (mode === 'acquiring') {
    return `<div class="user-marker-rotate" style="width:26px;height:26px;position:relative">
      <div style="position:absolute;inset:0;border-radius:50%;
        background:rgba(217,119,6,0.2);animation:gps-pulse 1.8s ease-out infinite"></div>
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
        width:16px;height:16px;border-radius:50%;
        background:#D97706;border:3px solid #fff;
        box-shadow:0 2px 8px rgba(217,119,6,0.55)"></div>
    </div>`
  }
  if (mode === 'puck') {
    // Navigation puck — rounded chevron + halo + soft directional glow.
    // Deliberately not a copy of Google Maps' cone: a single bold
    // arrowhead sitting proud of the dot, rather than a wide translucent
    // beam, so it reads clearly at a glance without looking derivative.
    const CX = 24, CY = 24
    return `<div class="user-marker-rotate" style="width:48px;height:48px">
      <svg width="48" height="48" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
        <defs>
          <filter id="u-shadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="rgba(37,99,235,0.45)"/>
          </filter>
        </defs>
        <!-- soft directional glow -->
        <path d="M ${CX} 3 L ${CX - 13} ${CY + 8} Q ${CX} ${CY - 6} ${CX + 13} ${CY + 8} Z"
          fill="rgba(66,133,244,0.20)"/>
        <!-- white halo for contrast against any tile colour -->
        <circle cx="${CX}" cy="${CY}" r="13" fill="white" filter="url(#u-shadow)"/>
        <!-- main puck body -->
        <circle cx="${CX}" cy="${CY}" r="11" fill="#4285F4"/>
        <circle cx="${CX}" cy="${CY - 3.5}" r="3.5" fill="rgba(255,255,255,0.4)"/>
        <!-- bold forward-facing chevron, sitting proud above the puck -->
        <path d="M ${CX} -2 L ${CX - 6} ${CY - 13} L ${CX} ${CY - 9} L ${CX + 6} ${CY - 13} Z"
          fill="#FFFFFF" stroke="#4285F4" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
    </div>`
  }
  // 'dot' — browse mode, not yet navigating
  return `<div class="user-marker-rotate" style="width:26px;height:26px;position:relative">
    <div style="position:absolute;inset:0;border-radius:50%;
      background:rgba(66,133,244,0.20);animation:gps-pulse 1.8s ease-out infinite"></div>
    <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
      width:16px;height:16px;border-radius:50%;
      background:#4285F4;border:3px solid #fff;
      box-shadow:0 2px 8px rgba(66,133,244,0.5)"></div>
  </div>`
}

function UserLocationMarker({ position, acquiring, heading }) {
  const map = useMap()
  const markerRef = useRef(null)
  const modeRef = useRef(null)
  const lastHeadingRef = useRef(0)

  const mode = acquiring ? 'acquiring' : (heading != null ? 'puck' : 'dot')

  // Create (or replace) the marker only when switching between the 3
  // discrete visual modes — NOT on every position/heading tick. Keeping
  // the DOM node stable across those ticks is what makes CSS transitions
  // able to animate at all (a brand-new node has no prior state to
  // animate from).
  useEffect(() => {
    if (!position || !map) return
    if (modeRef.current === mode && markerRef.current) return
    if (markerRef.current) markerRef.current.remove()
    const size = mode === 'puck' ? 48 : 26
    const icon = L.divIcon({
      className: 'user-marker-icon',
      html: userMarkerHtml(mode),
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    })
    markerRef.current = L.marker([position.lat, position.lng], {
      icon, zIndexOffset: 1000, interactive: false, keyboard: false,
    }).addTo(map)
    modeRef.current = mode
    lastHeadingRef.current = heading ?? 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, mode, !!position])

  // Position — Leaflet's own translate3d transform on this same node;
  // .user-marker-icon's CSS transition (index.css) is what turns this
  // into a glide instead of a snap.
  useEffect(() => {
    if (markerRef.current && position) {
      markerRef.current.setLatLng([position.lat, position.lng])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally depends on the primitive lat/lng, not the `position` object identity (a fresh object every render would defeat this)
  }, [position?.lat, position?.lng])

  // Rotation — mutate the inner wrapper directly, never Leaflet's own
  // position transform. Same wraparound-jump guard as applyBearingRaw.
  useEffect(() => {
    if (!markerRef.current || heading == null) return
    const el = markerRef.current.getElement()
    const rotateEl = el?.querySelector('.user-marker-rotate')
    if (!rotateEl) return
    const wrapped = ((heading % 360) + 360) % 360
    const rawJump = Math.abs(wrapped - lastHeadingRef.current)
    if (rawJump > 180) {
      rotateEl.style.transition = 'none'
      void rotateEl.offsetHeight // force reflow before re-enabling
      requestAnimationFrame(() => { rotateEl.style.transition = '' })
    }
    lastHeadingRef.current = wrapped
    rotateEl.style.transform = `rotate(${heading}deg)`
  }, [heading])

  // Don't fight the map's own zoom animation — a marker gliding on its
  // own transition WHILE Leaflet is separately animating the zoom looks
  // detached/floaty. Snap position instantly during a zoom, resume
  // transitioning once it settles.
  useEffect(() => {
    if (!map) return
    const disable = () => { const e = markerRef.current?.getElement(); if (e) e.style.transition = 'none' }
    const enable  = () => { const e = markerRef.current?.getElement(); if (e) e.style.transition = '' }
    map.on('zoomstart', disable)
    map.on('zoomend', enable)
    return () => { map.off('zoomstart', disable); map.off('zoomend', enable) }
  }, [map])

  useEffect(() => () => { markerRef.current?.remove() }, [map])

  return null
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
  dynamicZoom = true, // Priority 1 (Phase 4.2.4) — gate the smart-zoom effect below
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
  const lastBearingRef = useRef(0)
  const applyBearingRaw = useCallback((deg) => {
    const wrapped = ((deg % 360) + 360) % 360
    const rawJump = Math.abs(wrapped - lastBearingRef.current)
    if (rawJump > 180) {
      // Crossing the 0°/360° wrap boundary — disable the CSS transition
      // for just this one update (a small circular delta applied
      // instantly is imperceptible; animating the raw/long way is not),
      // then restore it on the next frame for subsequent normal updates.
      const pane = map.getPane('rotatePane')
      if (pane) {
        pane.style.transition = 'none'
        void pane.offsetHeight // force reflow so transition:none actually applies before setBearing
        requestAnimationFrame(() => { pane.style.transition = '' })
      }
    }
    lastBearingRef.current = wrapped
    map.setBearing(deg)
    onRotationChange?.(deg)
  }, [map, onRotationChange])

  const applyBearing = useCallback((deg) => {
    if (!isMapAlive() || !map._rotate) return
    applyBearingRaw(deg)
  }, [map, isMapAlive, applyBearingRaw])

  const resetBearing = useCallback(() => {
    if (!isMapAlive() || !map._rotate) return
    applyBearingRaw(0)
  }, [map, isMapAlive, applyBearingRaw])

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
    if (!followUser || !dynamicZoom || !isMapAlive()) return

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
  }, [remainingDist, nextTurnDist, followUser, dynamicZoom, map, isMapAlive])

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
  /** Priority 1 (Phase 4.2.4): Navigation Settings — Dynamic Zoom toggle */
  dynamicZoom = true,
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
        /* Phase 4.2.6 Priority 3 — root cause of the rotation "black
           screen": leaflet-rotate rotates the tile pane via CSS transform,
           but Leaflet still only loads tiles to cover the UNROTATED
           viewport rectangle (+ keepBuffer). At any bearing other than 0°,
           the rotated viewport's corners reach outside that rectangle, so
           whichever corner tiles haven't loaded yet show the container's
           own background instead — see the .leaflet-container background
           fix below for why that read as literally black. Default
           keepBuffer is 2; 6 preloads a much wider ring of surrounding
           tiles up front so a bearing change is far less likely to expose
           any untiled area at all, rather than only reacting after the
           fact. */
        keepBuffer={6}
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

      {/* Full route ghost — shows the complete planned path.
          Priority 9 (Phase 4.2.5): two different jobs depending on state,
          so two different treatments:
           • PREVIEW (no remainingPath yet — nothing else is drawn) needs
             to be the primary, clearly-visible route on its own: a white
             casing underneath + a solid, high-contrast dotted violet line
             on top — Google Maps' own convention for a walking-route
             preview, and clearly distinct in both color and style from
             the solid blue line used once actually navigating.
           • ACTIVE NAV (remainingPath present) keeps the original subtle
             pale-gray treatment — here it's only a receding "already
             walked" breadcrumb behind the vivid live blue centerline
             below, and should stay in the background, not compete with it. */}
      {routePath?.length >= 2 && !remainingPath?.length && (
        <Polyline
          positions={routePath.map(p => [p.lat, p.lng])}
          pathOptions={{
            color: '#FFFFFF',
            weight: 9,
            opacity: 0.85,
            lineCap: 'round',
            lineJoin: 'round',
          }}
        />
      )}
      {routePath?.length >= 2 && (
        <Polyline
          positions={routePath.map(p => [p.lat, p.lng])}
          pathOptions={
            remainingPath?.length
              ? { color: '#94A3B8', weight: 6, opacity: 0.38, lineCap: 'round', lineJoin: 'round' }
              : { color: '#6D28D9', weight: 6, opacity: 0.95, dashArray: '1, 12', lineCap: 'round', lineJoin: 'round' }
          }
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

      {/* Remaining route — white casing (Google Maps style outline that
          gives the blue centreline definition against busy tile colours).
          Sits between the soft glow and the main line; purely cosmetic,
          does not touch routing/positions. */}
      {remainingPath?.length >= 2 && (
        <Polyline
          positions={remainingPath.map(p => [p.lat, p.lng])}
          pathOptions={{
            color: '#FFFFFF',
            weight: 11,
            opacity: 0.9,
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
            className: 'user-accuracy-circle',
          }}
        />
      )}

      {/* ── User position marker ────────────────────────────────────── */}
      {userPosition && (
        <UserLocationMarker
          position={{ lat: userPosition[0], lng: userPosition[1] }}
          acquiring={acquiringGps}
          heading={userHeading}
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
        dynamicZoom={dynamicZoom}
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
