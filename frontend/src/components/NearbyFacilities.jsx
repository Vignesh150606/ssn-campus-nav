/**
 * NearbyFacilities — "Nearest Restroom / Water Station / Canteen" cards.
 *
 * Per the data model: restrooms and water stations have no coordinates of
 * their own. Every academic block + the library carries
 * `facilities: ["restroom", "water_station"]` in locations.json, and
 * "nearest restroom" really means "nearest building that has one". Only
 * canteens (category 'dining') are real standalone locations.
 */
import { nearestWithFacility, nearestCanteen } from '../utils/facilities'
import { displayLocationName } from '../constants'
import UIIcon from './UIIcon'

const CARDS = [
  { key: 'restroom',     icon: 'restroom', label: 'Nearest restroom' },
  { key: 'water_station',icon: 'water', label: 'Nearest water station' },
  { key: 'canteen',      icon: 'food', label: 'Nearest canteen' },
]

function formatDistance(m) {
  if (m == null) return '—'
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`
}

export default function NearbyFacilities({ locations, fromLat, fromLng, onNavigate }) {
  if (fromLat == null || fromLng == null) return null

  const results = CARDS.map(card => {
    const hit = card.key === 'canteen'
      ? nearestCanteen(locations, fromLat, fromLng)
      : nearestWithFacility(locations, fromLat, fromLng, card.key)
    return { ...card, hit }
  }).filter(r => r.hit)

  if (results.length === 0) return null

  return (
    <div className="nearby-facilities">
      <div className="sheet-title" style={{ padding: '0 0 8px' }}>Nearby Facilities</div>
      <div className="facility-cards">
        {results.map(r => (
          <button className="facility-card" key={r.key}
            onClick={() => onNavigate(r.hit.location)}
            aria-label={`Navigate to ${displayLocationName(r.hit.location)}, ${r.label.toLowerCase()}`}>
            <span className="facility-icon"><UIIcon name={r.icon} size={19} /></span>
            <div className="facility-info">
              <div className="facility-name">{displayLocationName(r.hit.location)}</div>
              <div className="facility-sub">{r.label} · {formatDistance(r.hit.distanceM)} away</div>
            </div>
            <UIIcon name="chevron" size={17} className="facility-chevron" />
          </button>
        ))}
      </div>
    </div>
  )
}
