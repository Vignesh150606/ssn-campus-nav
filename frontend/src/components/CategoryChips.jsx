import { CATEGORY_META } from '../constants'

export default function CategoryChips({ active, onChange }) {
  return (
    <div className="chip-row">
      <button className={`chip ${!active ? 'active' : ''}`} onClick={() => onChange(null)}>
        All
      </button>
      {Object.entries(CATEGORY_META).map(([key, meta]) => (
        <button
          key={key}
          className={`chip ${active === key ? 'active' : ''}`}
          onClick={() => onChange(active === key ? null : key)}
        >
          <span className="chip-dot" style={{ background: meta.color }} />
          {meta.label}
        </button>
      ))}
    </div>
  )
}
