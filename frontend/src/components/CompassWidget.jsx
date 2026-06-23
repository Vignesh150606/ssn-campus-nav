/**
 * CompassWidget — floating arrow that always points toward the active
 * destination, rotating in real time as the phone turns.
 *
 * Only rendered while navigation is active (passed in via `active`).
 * Hides itself entirely on devices/browsers without orientation sensors;
 * on iOS, shows a one-tap "Enable Compass" button first since Safari
 * requires a user gesture before it will grant orientation permission.
 */
import { useCompassHeading } from '../hooks/useCompassHeading'
import { bearing } from '../utils/geo'

export default function CompassWidget({ active, position, destination }) {
  // Version A's hook signature preserved: active param controls sensor attach/detach
  const { supported, needsPermission, permissionState, heading, requestPermission } = useCompassHeading(active)

  if (!active || !supported) return null

  if (needsPermission && permissionState !== 'granted') {
    return (
      <button
        className="compass-widget compass-enable"
        onClick={requestPermission}
        title="Enable the navigation compass"
      >
        🧭 {permissionState === 'denied' ? 'Compass blocked — tap to retry' : 'Enable Compass'}
      </button>
    )
  }

  if (heading == null || !position || !destination) return null

  const bearingToDest = bearing(position.lat, position.lng, destination.lat, destination.lng)
  const arrowRotation = ((bearingToDest - heading) + 360) % 360

  return (
    <div className="compass-widget" role="img" aria-label="Direction to destination">
      {/* SVG arrow from Version B (more polished than text ↑) */}
      <div className="compass-arrow" style={{ transform: `rotate(${arrowRotation}deg)` }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2 L17 20 L12 16 L7 20 Z" />
        </svg>
      </div>
      <div className="compass-caption">
        <span className="compass-heading">{Math.round(heading)}°</span>
      </div>
    </div>
  )
}
