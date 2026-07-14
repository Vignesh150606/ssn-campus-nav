import { Outlet, NavLink } from 'react-router-dom'
import { useEffect, useState } from 'react'
import DevLocationPanel from './components/DevLocationPanel'

// Dark mode hook — persists to localStorage, respects system preference
function useTheme() {
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return 'light'
    const stored = localStorage.getItem('ssn-theme')
    if (stored === 'light' || stored === 'dark') return stored
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('ssn-theme', theme)
    const metas = document.querySelectorAll('meta[name="theme-color"]')
    const color = theme === 'dark' ? '#003b7a' : '#003b7a'
    metas.forEach((m) => m.setAttribute('content', color))
  }, [theme])
  return [theme, () => setTheme(t => (t === 'dark' ? 'light' : 'dark'))]
}

export default function App() {
  const [theme, toggleTheme] = useTheme()

  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink to="/" className="brand">
          {/* Phase 4.2 — SSN branding: real logo in header */}
          <img src="/ssn-logo.png" alt="SSN" className="brand-logo" />
          <span>Campus Navigator</span>
        </NavLink>
        <nav>
          <NavLink to="/events">Fest Schedule</NavLink>
          <NavLink to="/admin" style={{ opacity: 0.6 }}>Admin</NavLink>
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? '☀' : '◐'}
          </button>
        </nav>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
      <DevLocationPanel />
    </div>
  )
}
