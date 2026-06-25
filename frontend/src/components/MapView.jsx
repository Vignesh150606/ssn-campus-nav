/**
 * MapView — Leaflet map component.
 * Phase 4:  Smart user marker with heading arrow (direction cone).
 * Phase 14: Drag detection → onMapDrag callback for auto-follow management.
 */
import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, useMap, Circle } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { CATEGORY_META } from '../constants'

export const CAMPUS_CENTER = [12.7510, 80.1970]

function markerIcon(category, isDestination) {
  const color = CATEGORY_META[category]?.color || '#6B7280'
  const size = isDestination ? 22 : 14
  return L.divIcon({
    className: '',
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${color};border:2.5px solid #fff;
      box-shadow:0 1px 5px rgba(0,0,0,0.35);
    "></div>`,
    iconSize: [size, size],
    iconAnchor: [size/2, size/2],
  })
}

/**
 * Phase 4 — Smart user marker.
 * When heading is provided (compass heading in degrees, 0=north):
 *   → Blue dot + direction cone pointing the way the user faces.
 * When acquiring GPS:
 *   → Amber pulsing dot (unchanged).
 * Normal (no heading):
 *   → Green dot with accuracy pulse ring.
 */
function userIcon(acquiring, heading) {
  const CX = 22, CY = 22 // SVG center

  if (!acquiring && heading != null) {
    // Navigation mode: blue dot + heading cone
    return L.divIcon({
      className: '',
      html: `<svg width="44" height="44" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
        <!-- accuracy pulse ring -->
        <circle cx="${CX}" cy="${CY}" r="20" fill="rgba(37,99,235,0.08)"/>
        <!-- direction cone pointing north (0°), rotated by heading -->
        <polygon
          points="${CX},5 ${CX-7},${CY} ${CX+7},${CY}"
          fill="rgba(37,99,235,0.6)"
          transform="rotate(${heading},${CX},${CY})"
        />
        <!-- white backing circle for contrast -->
        <circle cx="${CX}" cy="${CY}" r="9.5" fill="white"/>
        <!-- blue position dot -->
        <circle cx="${CX}" cy="${CY}" r="7.5" fill="#2563eb"/>
        <!-- inner highlight -->
        <circle cx="${CX}" cy="${CY - 2}" r="2.5" fill="rgba(255,255,255,0.45)"/>
      </svg>`,
      iconSize: [44, 44],
      iconAnchor: [22, 22],
    })
  }

  // Standard dot (green = good fix, amber = acquiring)
  const dotColor  = acquiring ? '#D97706' : '#059669'
  const ringColor = acquiring ? 'rgba(217,119,6,0.22)'  : 'rgba(5,150,105,0.25)'
  const shadow    = acquiring ? 'rgba(217,119,6,0.5)'   : 'rgba(5,150,105,0.5)'
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:22px;height:22px">
      <div style="
        position:absolute;inset:0;border-radius:50%;
        background:${ringColor};
        animation:gps-pulse 1.8s ease-out infinite;
      "></div>
      <div style="
        position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
        width:14px;height:14px;border-radius:50%;
        background:${dotColor};border:3px solid #fff;
        box-shadow:0 2px 6px ${shadow};
      "></div>
    </div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  })
}

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

function PanToUser({ position }) {
  const map = useMap()
  useEffect(() => {
    if (position) map.panTo(position, { animate: true, duration: 0.5 })
  }, [position, map])
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

/**
 * Phase 14 — Detect when the user manually drags the map.
 * Calls onDrag() once on dragstart so the parent can disable auto-follow
 * and show the Recenter button.
 */
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
  /** Phase 4: compass heading in degrees (0=north). When provided during
   *  navigation, renders a direction cone on the user dot. */
  userHeading = null,
  /** Phase 14: called when the user manually drags the map. */
  onMapDrag,
}) {
  return (
    <MapContainer
      center={center || CAMPUS_CENTER}
      zoom={zoom}
      minZoom={15}
      style={{ height: '100%', width: '100%' }}
      zoomControl={true}
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

      {/* Full route — faded */}
      {routePath?.length >= 2 && (
        <Polyline
          positions={routePath.map(p => [p.lat, p.lng])}
          pathOptions={{ color: '#059669', weight: 5, opacity: 0.28, dashArray: '4 8', lineCap: 'round' }}
        />
      )}

      {/* Remaining route — solid */}
      {remainingPath?.length >= 2 && (
        <Polyline
          positions={remainingPath.map(p => [p.lat, p.lng])}
          pathOptions={{ color: '#059669', weight: 6, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }}
        />
      )}

      {/* GPS accuracy circle */}
      {userPosition && userAccuracy > 8 && (
        <Circle
          center={userPosition}
          radius={userAccuracy}
          pathOptions={{
            color: acquiringGps ? '#D97706' : '#059669',
            fillColor: acquiringGps ? '#D97706' : '#059669',
            fillOpacity: 0.07,
            weight: 1.5,
            opacity: 0.35,
          }}
        />
      )}

      {/* Live user position with Phase 4 heading arrow */}
      {userPosition && (
        <Marker
          position={userPosition}
          icon={userIcon(acquiringGps, userHeading)}
          zIndexOffset={1000}
        />
      )}

      {routePath?.length >= 2 && !userPosition && <FitToRoute path={routePath} />}
      {routePath?.length >= 2 && <FitToBoundsOnTrigger path={routePath} trigger={previewTrigger} />}
      {userPosition && followUser && <PanToUser position={userPosition} />}

      {/* Phase 14 — drag detection */}
      {onMapDrag && <DetectDrag onDrag={onMapDrag} />}

      <AutoResize />
    </MapContainer>
  )
}
