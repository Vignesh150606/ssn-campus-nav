import { Outlet, NavLink, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import DevLocationPanel from './components/DevLocationPanel'
import { dlog } from './utils/debugLog'

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
    dlog('App/theme', 'Theme initialized + applied to <html data-theme>:', theme)
  }, [theme])
  return [theme, () => setTheme(t => (t === 'dark' ? 'light' : 'dark'))]
}

export default function App() {
  const [theme, toggleTheme] = useTheme()
  const location = useLocation()

  // Fires on every client-side route change (including the very first
  // render's "navigation"). Confirms the Router has actually settled on a
  // path and App + its children are about to render for that path.
  useEffect(() => {
    dlog('App/router', 'Route is now:', location.pathname)
  }, [location.pathname])

  dlog('App/render', 'App component body executing for path:', location.pathname)

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
