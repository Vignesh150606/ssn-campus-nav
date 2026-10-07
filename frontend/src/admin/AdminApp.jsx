import AdminDashboard from '../pages/AdminDashboard'
import { useTheme } from '../hooks/useTheme'

export default function AdminApp() {
  const [theme, toggleTheme] = useTheme()
  return (
    <div className="app-shell admin-shell">
      <header className="admin-header">
        <div className="brand">
          <img src="/ssn-logo.webp" alt="SSN" className="brand-logo" />
          <span>Admin Console</span>
        </div>
        <nav aria-label="Admin navigation">
          {/* A full navigation switches to the independent visitor entry. */}
          <a href="/">Open campus app</a>
          <button type="button" className="theme-toggle" onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
            {theme === 'dark' ? '☀' : '◐'}
          </button>
        </nav>
      </header>
      <main className="app-main admin-main"><AdminDashboard /></main>
    </div>
  )
}
