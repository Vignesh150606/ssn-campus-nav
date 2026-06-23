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

const CARDS = [
  { key: 'restroom',     icon: '🚻', label: 'Nearest Restroom' },
  { key: 'water_station',icon: '💧', label: 'Nearest Water Station' },
  { key: 'canteen',      icon: '🍽️', label: 'Nearest Canteen' },
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
          <div className="facility-card" key={r.key}>
            <div className="facility-icon">{r.icon}</div>
            <div className="facility-info">
              <div className="facility-label">{r.label}</div>
              <div className="facility-sub">{r.hit.location.name} · {formatDistance(r.hit.distanceM)}</div>
            </div>
            <button className="facility-nav-btn" onClick={() => onNavigate(r.hit.location)}>
              Navigate
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
