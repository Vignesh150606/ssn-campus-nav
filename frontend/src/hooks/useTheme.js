import { useEffect, useState } from 'react'

// Shared preference, independently mounted by the visitor and admin entries.
export function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      const stored = localStorage.getItem('ssn-theme')
      if (stored === 'light' || stored === 'dark') return stored
    } catch { /* A blocked storage API must not prevent either page loading. */ }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem('ssn-theme', theme) } catch { /* Keep the in-memory preference. */ }
    document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', '#0d4ba0'))
  }, [theme])
  return [theme, () => setTheme(t => t === 'dark' ? 'light' : 'dark')]
}
