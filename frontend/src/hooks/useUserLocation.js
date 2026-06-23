/**
 * Real-time GPS tracking with turn-by-turn guidance.
 * - Live position tracking
 * - Remaining path + distance updates
 * - Distance announcements (200m, 100m, 50m from destination)
 * - Off-route detection (if user strays >60m from path)
 */
import { useState, useRef, useCallback } from 'react'

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const p1 = lat1 * Math.PI/180, p2 = lat2 * Math.PI/180
  const dp = (lat2-lat1)*Math.PI/180, dl = (lng2-lng1)*Math.PI/180
  const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2
  return 2*R*Math.asin(Math.sqrt(a))
}

function pathLength(pts) {
  let d = 0
  for (let i = 0; i < pts.length-1; i++)
    d += haversine(pts[i].lat, pts[i].lng, pts[i+1].lat, pts[i+1].lng)
  return d
}

function nearestIdx(lat, lng, path) {
  let best = 0, bestD = Infinity
  for (let i = 0; i < path.length; i++) {
    const d = haversine(lat, lng, path[i].lat, path[i].lng)
    if (d < bestD) { bestD = d; best = i }
  }
  return { idx: best, dist: bestD }
}

const ANNOUNCE_THRESHOLDS = [200, 100, 50, 20]  // metres from destination

export function useUserLocation() {
  const [position, setPosition]           = useState(null)
  const [accuracy, setAccuracy]           = useState(null)
  const [tracking, setTracking]           = useState(false)
  const [error, setError]                 = useState(null)
  const [remainingPath, setRemainingPath] = useState(null)
  const [remainingDist, setRemainingDist] = useState(null)  // metres
  const [liveEta, setLiveEta]             = useState(null)  // minutes
  const [guidance, setGuidance]           = useState(null)  // text announcement
  const [offRoute, setOffRoute]           = useState(false)

  const watchId    = useRef(null)
  const routeRef   = useRef(null)
  const announced  = useRef(new Set())   // which thresholds already announced
  const destRef    = useRef(null)        // destination {lat,lng}

  const setRoute = useCallback((path, destLat, destLng) => {
    routeRef.current  = path
    destRef.current   = { lat: destLat, lng: destLng }
    announced.current = new Set()
    setRemainingPath(path)
    setRemainingDist(pathLength(path))
    setOffRoute(false)
    setGuidance('Navigation started. Follow the orange path.')
    setTimeout(() => setGuidance(null), 3000)
  }, [])

  const clearRoute = useCallback(() => {
    routeRef.current = null
    destRef.current  = null
    setRemainingPath(null)
    setRemainingDist(null)
    setLiveEta(null)
    setGuidance(null)
    setOffRoute(false)
    announced.current = new Set()
  }, [])

  const onPosition = useCallback((pos) => {
    const lat = pos.coords.latitude
    const lng = pos.coords.longitude
    const acc = pos.coords.accuracy
    setPosition({ lat, lng })
    setAccuracy(acc)

    if (!routeRef.current?.length) return

    const { idx, dist: distFromPath } = nearestIdx(lat, lng, routeRef.current)

    // Off-route detection
    if (distFromPath > 60) {
      setOffRoute(true)
      setGuidance('⚠️ You seem to be off route — retrace to the orange path')
    } else {
      setOffRoute(false)
    }

    // Remaining path from nearest point
    const remaining = routeRef.current.slice(idx)
    setRemainingPath(remaining)

    const remDist = pathLength(remaining)
    setRemainingDist(Math.round(remDist))
    setLiveEta(Math.round(remDist / 1.4 / 60 * 10) / 10)

    // Distance announcements
    for (const threshold of ANNOUNCE_THRESHOLDS) {
      if (remDist <= threshold && !announced.current.has(threshold)) {
        announced.current.add(threshold)
        const msg = remDist <= 20
          ? '🎯 You have arrived!'
          : `📍 ${threshold}m from destination`
        setGuidance(msg)
        setTimeout(() => setGuidance(null), 4000)
        break
      }
    }
  }, [])

  const start = useCallback(() => {
    if (!navigator.geolocation) {
      setError('Geolocation not supported on this device.')
      return
    }
    setError(null)
    setTracking(true)
    watchId.current = navigator.geolocation.watchPosition(
      onPosition,
      (err) => { setError(`GPS: ${err.message}`); setTracking(false) },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    )
  }, [onPosition])

  const stop = useCallback(() => {
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current)
      watchId.current = null
    }
    setTracking(false)
    setPosition(null)
    clearRoute()
  }, [clearRoute])

  return {
    position, accuracy, tracking, error,
    remainingPath, remainingDist, liveEta,
    guidance, offRoute,
    start, stop, setRoute, clearRoute,
  }
}