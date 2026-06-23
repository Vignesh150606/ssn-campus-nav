import { useEffect, useRef, useState, useCallback } from 'react'
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

function userIcon(acquiring) {
  const dotColor  = acquiring ? '#D97706' : '#059669'
  const ringColor = acquiring ? 'rgba(217,119,6,0.22)' : 'rgba(5,150,105,0.25)'
  const shadow    = acquiring ? 'rgba(217,119,6,0.5)'  : 'rgba(5,150,105,0.5)'
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

// Fit map to show entire route
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

// Forces a fit-to-bounds on demand (Feature 4 "Preview Route" button) — unlike
// FitToRoute above, this fires regardless of whether userPosition/tracking is
// active, because it's an explicit user action rather than the default
// "just got a route, show it" behaviour.
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

// Pan to user when tracking
function PanToUser({ position }) {
  const map = useMap()
  useEffect(() => {
    if (position) map.panTo(position, { animate: true, duration: 0.5 })
  }, [position, map])
  return null
}

// Auto resize when container changes (bottom sheet open/close)
function AutoResize() {
  const map = useMap()
  useEffect(() => {
    const obs = new ResizeObserver(() => map.invalidateSize())
    obs.observe(map.getContainer())
    return () => obs.disconnect()
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
  userAccuracy,    // metres from pos.coords.accuracy — drives the accuracy circle
  acquiringGps,    // true while waiting for first good fix (amber dot)
  followUser,
  previewTrigger,
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

      {/* Remaining route — solid, updates as user walks */}
      {remainingPath?.length >= 2 && (
        <Polyline
          positions={remainingPath.map(p => [p.lat, p.lng])}
          pathOptions={{ color: '#059669', weight: 6, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }}
        />
      )}

      {/* GPS accuracy circle — shows uncertainty radius.
           Only rendered when accuracy > 8m (otherwise smaller than the dot). */}
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

      {/* Live user position — always TRUE GPS coordinate, never snapped */}
      {userPosition && (
        <Marker
          position={userPosition}
          icon={userIcon(acquiringGps)}
          zIndexOffset={1000}
        />
      )}

      {routePath?.length >= 2 && !userPosition && <FitToRoute path={routePath} />}
      {routePath?.length >= 2 && <FitToBoundsOnTrigger path={routePath} trigger={previewTrigger} />}
      {userPosition && followUser && <PanToUser position={userPosition} />}
      <AutoResize />
    </MapContainer>
  )
}
