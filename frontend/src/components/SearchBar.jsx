export default function SearchBar({ value, onChange, placeholder }) {
  return (
    <div className="search-box">
      <span className="search-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || 'Search buildings, departments, events…'}
        aria-label="Search campus"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          style={{
            width: 22, height: 22, borderRadius: 999,
            display: 'grid', placeItems: 'center',
            background: 'var(--ring)', color: 'var(--ink-2)',
            fontSize: 12, lineHeight: 1,
          }}
        >
          ✕
        </button>
      )}
    </div>
  )
}
