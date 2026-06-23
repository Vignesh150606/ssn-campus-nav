/**
 * DevLocationPanel — floating developer-only widget for testing live
 * navigation (the blue dot, rerouting, ETA, off-route warnings, arrival
 * announcements) without needing to physically walk the campus.
 *
 * Renders nothing at all unless devModeAvailable is true, i.e.
 * VITE_DEV_MODE=true or the app is running on localhost/127.0.0.1 — so
 * there is no production-build path where this panel can appear.
 */
import { useState } from 'react'
import { useLocationContext } from '../context/LocationContext'

const MOVE_STEP_DEG = 0.0001 // roughly 11m at this latitude

export default function DevLocationPanel() {
  const {
    devModeAvailable,
    position, simPosition, tracking,
    useSimulatedGPS, toggleSimulatedGPS,
    moveSim, setSimLatLng,
    hasRoute, offRoute,
    autoWalking, startAutoWalk, stopAutoWalk,
    goOffRoute, resetToActualGPS,
  } = useLocationContext()

  const [collapsed, setCollapsed] = useState(true)
  const [draftLat, setDraftLat]   = useState('')
  const [draftLng, setDraftLng]   = useState('')

  if (!devModeAvailable) return null

  const current = simPosition ?? position
  const hasPosition = !!current

  function applyDraft() {
    const lat = parseFloat(draftLat)
    const lng = parseFloat(draftLng)
    if (Number.isNaN(lat) || Number.isNaN(lng)) return
    setSimLatLng(lat, lng)
  }

  if (collapsed) {
    return (
      <button className="dev-panel-chip" onClick={() => setCollapsed(false)}>
        🛠 DEV
      </button>
    )
  }

  return (
    <div className="dev-panel">
      <div className="dev-panel-header">
        <span>🛠 DEV MODE — Location Testing</span>
        <button className="dev-panel-collapse" onClick={() => setCollapsed(true)} aria-label="Collapse">
          –
        </button>
      </div>

      <div className="dev-panel-body">
        <div className="dev-row dev-coords">
          <div>
            <span className="dev-label">Lat</span>
            <span className="dev-value">{current ? current.lat.toFixed(6) : '—'}</span>
          </div>
          <div>
            <span className="dev-label">Lng</span>
            <span className="dev-value">{current ? current.lng.toFixed(6) : '—'}</span>
          </div>
        </div>

        <label className="dev-toggle-row">
          <input
            type="checkbox"
            checked={useSimulatedGPS}
            onChange={toggleSimulatedGPS}
          />
          Use Simulated GPS
        </label>

        <div className="dev-row dev-status-row">
          <span className={`dev-status-pill ${useSimulatedGPS ? 'sim' : 'real'}`}>
            {useSimulatedGPS ? 'SIMULATED' : 'REAL GPS'}
          </span>
          <span className={`dev-status-pill ${offRoute ? 'warn' : 'ok'}`}>
            {offRoute ? 'OFF ROUTE' : 'on route'}
          </span>
        </div>

        <div className="dev-compass">
          <button className="dev-btn" onClick={() => moveSim(MOVE_STEP_DEG, 0)}>▲ North</button>
          <div className="dev-compass-mid">
            <button className="dev-btn" onClick={() => moveSim(0, -MOVE_STEP_DEG)}>◀ West</button>
            <button className="dev-btn" onClick={() => moveSim(0, MOVE_STEP_DEG)}>East ▶</button>
          </div>
          <button className="dev-btn" onClick={() => moveSim(-MOVE_STEP_DEG, 0)}>▼ South</button>
        </div>

        <div className="dev-row dev-manual">
          <input
            className="dev-input"
            type="number"
            step="0.0001"
            placeholder="lat"
            value={draftLat}
            onChange={(e) => setDraftLat(e.target.value)}
          />
          <input
            className="dev-input"
            type="number"
            step="0.0001"
            placeholder="lng"
            value={draftLng}
            onChange={(e) => setDraftLng(e.target.value)}
          />
          <button className="dev-btn dev-btn-small" onClick={applyDraft}>Set</button>
        </div>

        <button
          className={`dev-btn dev-btn-wide ${autoWalking ? 'active' : ''}`}
          onClick={autoWalking ? stopAutoWalk : startAutoWalk}
          disabled={!hasRoute}
          title={!hasRoute ? 'Pick a destination and start directions first' : ''}
        >
          {autoWalking ? '⏹ Stop Auto Walk' : '▶ Start Auto Walk'}
        </button>

        <button
          className="dev-btn dev-btn-wide"
          onClick={goOffRoute}
          disabled={!hasRoute || !hasPosition}
          title={!hasRoute ? 'Pick a destination and start directions first' : ''}
        >
          ⚠ Go Off Route (80m)
        </button>

        <button className="dev-btn dev-btn-wide dev-btn-reset" onClick={resetToActualGPS}>
          ↺ Reset to actual GPS
        </button>

        {!tracking && (
          <p className="dev-hint">
            Tip: tap "📍 My location" in the app, or use a move button above — either one starts tracking.
          </p>
        )}
      </div>
    </div>
  )
}
