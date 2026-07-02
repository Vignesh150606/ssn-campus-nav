import { CATEGORY_META, displayLocationName } from '../constants'

export default function LocationCard({ location, onSelect, onDirections, isDestination }) {
  const meta = CATEGORY_META[location.category] || {}
  return (
    <div
      className="location-card"
      onClick={() => onSelect(location)}
      style={{ background: isDestination ? 'var(--surface)' : undefined }}
    >
      <span className="location-dot" style={{ background: meta.color }} />
      <div className="location-info">
        <div className="location-name">{displayLocationName(location)}</div>
        <div className="location-sub">{location.department || meta.label}</div>
      </div>
      <button
        className="go-button"
        onClick={e => { e.stopPropagation(); onDirections(location) }}
      >
        Directions
      </button>
    </div>
  )
}
