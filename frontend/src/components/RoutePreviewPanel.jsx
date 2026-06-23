/**
 * RoutePreviewPanel — shown after picking a destination and before live
 * navigation actually starts. Lets the user see distance/ETA/landmarks and
 * zoom the map to the full route before committing to "Start Navigation".
 *
 * Takes a `routes` array (not a single route) even though the backend only
 * ever returns one shortest path today — this keeps the panel's shape
 * future-proof for showing multiple route options (e.g. "shortest" vs
 * "accessible") without a rewrite; `activeIndex`/`onSelectRoute` are unused
 * when there's only one route, but the plumbing exists.
 */
import { SkeletonRoutePreview } from './Skeleton'

function formatDistance(m) {
  if (m == null) return '—'
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`
}

export default function RoutePreviewPanel({
  destination,
  routes,           // [{ distanceM, etaMinutes, landmarks }]
  activeIndex = 0,
  onSelectRoute,
  loading,
  error,
  onPreview,
  onStart,
  onCancel,
}) {
  if (!destination) return null

  const active = routes?.[activeIndex]

  return (
    <div className="route-preview-panel">
      <div className="route-preview-header">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="route-preview-label">Destination</div>
          <div className="route-preview-dest">{destination.name}</div>
        </div>
        <button className="route-preview-close" onClick={onCancel} aria-label="Cancel">✕</button>
      </div>

      {loading && <SkeletonRoutePreview />}
      {error && <div className="state-message" style={{ color: 'var(--danger)' }}>{error}</div>}

      {active && !loading && (
        <>
          {routes.length > 1 && (
            <div className="route-options-row">
              {routes.map((r, i) => (
                <button
                  key={i}
                  className={`route-option-chip ${i === activeIndex ? 'active' : ''}`}
                  onClick={() => onSelectRoute?.(i)}
                >
                  {r.label || `Route ${i + 1}`}
                </button>
              ))}
            </div>
          )}

          <div className="route-preview-stats">
            <div>
              <span className="meta-label">Distance</span>
              {formatDistance(active.distanceM)}
            </div>
            <div>
              <span className="meta-label">ETA</span>
              {active.etaMinutes} min
            </div>
          </div>

          {active.landmarks?.length > 0 && (
            <div className="route-preview-landmarks">
              <span className="meta-label">Route passes</span>
              <ul>
                {active.landmarks.map(l => <li key={l.id}>{l.name}</li>)}
              </ul>
            </div>
          )}

          <div className="route-preview-actions">
            <button className="route-preview-btn secondary" onClick={onPreview}>
              Preview Route
            </button>
            <button className="route-preview-btn primary" onClick={onStart}>
              Start Navigation
            </button>
          </div>
        </>
      )}
    </div>
  )
}
