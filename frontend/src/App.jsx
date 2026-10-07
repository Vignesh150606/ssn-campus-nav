import { Outlet, NavLink } from 'react-router-dom'
import { useTheme } from './hooks/useTheme'
import DevLocationPanel from './components/DevLocationPanel'
import InstallPrompt from './components/InstallPrompt'
import OfflineIndicator from './components/OfflineIndicator'

export default function App() {
  const [theme, toggleTheme] = useTheme()

  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink to="/" className="brand">
          {/* Phase 4.2 — SSN branding: real logo in header */}
          <img src="/ssn-logo.webp" alt="SSN" className="brand-logo" />
          <span>Campus Navigator</span>
        </NavLink>
        <nav>
          <NavLink to="/events" aria-label="Fest Schedule">
            <span className="schedule-label">Fest Schedule</span>
            <span className="schedule-label-compact" aria-hidden="true">Schedule</span>
          </NavLink>
          {/* Task 1 (offline support) — built earlier (Phase X) but never
              actually rendered anywhere; renders nothing at all while
              online, so this is a purely additive, zero-risk mount. */}
          <OfflineIndicator />
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
      <InstallPrompt />
      <main className="app-main">
        <Outlet />
      </main>
      <DevLocationPanel />
    </div>
  )
}
