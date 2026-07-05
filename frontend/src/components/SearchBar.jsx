import { useEffect, useRef } from 'react'

/**
 * SearchBar — Priority X.2 (Phase 4.2.7): mobile keyboard UX.
 *
 * Previously, after typing a destination, the on-screen keyboard stayed
 * open and physically covered the results sheet — the user had to
 * manually dismiss it (tap away) before they could even see, let alone
 * tap, a result. Three changes fix this without touching search logic
 * itself:
 *
 *   1. `enterKeyHint="search"` — the mobile keyboard's action key reads
 *      "Search" instead of a generic return arrow.
 *   2. Pressing Enter/Search blurs the input (closing the keyboard) and
 *      calls `onSubmit`, which Home.jsx uses to move focus onto the
 *      results list — so results are immediately visible AND keyboard-
 *      navigable, with no second tap needed. The query itself is never
 *      touched, so results stay exactly as they were.
 *   3. Tapping anywhere outside the search box also blurs the input
 *      (closing the keyboard) the same way, without changing the query —
 *      matching how Google Maps' search bar behaves.
 */
export default function SearchBar({ value, onChange, placeholder, onSubmit }) {
  const inputRef = useRef(null)

  useEffect(() => {
    const onDocPointerDown = (e) => {
      const input = inputRef.current
      if (input && document.activeElement === input && !input.contains(e.target)) {
        input.blur() // just dismiss the keyboard — query/results are untouched
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    return () => document.removeEventListener('pointerdown', onDocPointerDown)
  }, [])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.target.blur()
      onSubmit?.()
    }
  }

  return (
    <div className="search-box">
      <span className="search-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </span>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        enterKeyHint="search"
        inputMode="search"
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
