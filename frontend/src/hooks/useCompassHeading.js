/**
 * useCompassHeading — wraps the Device Orientation API to expose the
 * phone's current compass heading (0-360°, 0 = north).
 *
 * iOS Safari (13+) requires an explicit user gesture to grant motion/
 * orientation permission, so this hook exposes `permissionState` +
 * `requestPermission()` rather than auto-starting — CompassWidget calls
 * requestPermission() from an onClick handler.
 *
 * Browsers/devices with no orientation sensor (most desktops) report
 * `supported: false` and the hook simply never produces a heading —
 * CompassWidget hides itself in that case.
 *
 * `active` (default true) lets the caller pause the underlying sensor
 * listener while it isn't needed (e.g. CompassWidget is mounted for the
 * whole session but only wants headings while actually navigating) —
 * the listener detaches while inactive and reattaches automatically when
 * `active` becomes true again, without requiring another permission
 * prompt on iOS once it's already been granted once.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

function isIOSPermissionAPI() {
  return typeof DeviceOrientationEvent !== 'undefined' &&
    typeof DeviceOrientationEvent.requestPermission === 'function'
}

export function useCompassHeading(active = true) {
  const supported = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window
  const needsPermission = supported && isIOSPermissionAPI()

  const [heading, setHeading]              = useState(null)
  const [permissionState, setPermissionState] = useState(needsPermission ? 'prompt' : 'granted')
  const listenerAttached = useRef(false)

  const handleOrientation = useCallback((event) => {
    // iOS exposes a ready-to-use compass heading directly.
    if (typeof event.webkitCompassHeading === 'number') {
      setHeading(event.webkitCompassHeading)
      return
    }
    // Standard API: alpha is rotation around the z-axis. Without `absolute`
    // it's relative to the device's initial orientation, not true/magnetic
    // north — 360-alpha is the commonly used approximation either way;
    // exact accuracy varies by device/browser and isn't guaranteed by spec.
    if (typeof event.alpha === 'number') {
      setHeading((360 - event.alpha) % 360)
    }
  }, [])

  const attach = useCallback(() => {
    if (!supported || listenerAttached.current) return
    const eventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation'
    window.addEventListener(eventName, handleOrientation)
    listenerAttached.current = true
  }, [supported, handleOrientation])

  const detach = useCallback(() => {
    if (!listenerAttached.current) return
    window.removeEventListener('deviceorientationabsolute', handleOrientation)
    window.removeEventListener('deviceorientation', handleOrientation)
    listenerAttached.current = false
  }, [handleOrientation])

  const requestPermission = useCallback(async () => {
    if (!supported) return
    if (!needsPermission) {
      setPermissionState('granted')
      attach()
      return
    }
    try {
      const result = await DeviceOrientationEvent.requestPermission()
      setPermissionState(result === 'granted' ? 'granted' : 'denied')
      if (result === 'granted') attach()
    } catch {
      setPermissionState('denied')
    }
  }, [supported, needsPermission, attach])

  // Attach only while `active` and either no permission prompt is needed
  // (Android/desktop) or permission has already been granted (iOS, after
  // the user's first explicit tap via requestPermission() above). Detach
  // whenever `active` goes false, so the sensor isn't running in the
  // background for the whole session — and detach on unmount regardless.
  useEffect(() => {
    if (!active) {
      detach()
      return
    }
    if (supported && (!needsPermission || permissionState === 'granted')) {
      attach()
    }
    return () => detach()
  }, [active, supported, needsPermission, permissionState, attach, detach])

  return { supported, needsPermission, permissionState, heading, requestPermission }
}
