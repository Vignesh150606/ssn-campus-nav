import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import Home from './pages/Home.jsx'
import EventPage from './pages/EventPage.jsx'
import EventsList from './pages/EventsList.jsx'
import AdminDashboard from './pages/AdminDashboard.jsx'
import LocationDeepLink from './pages/LocationDeepLink.jsx'
import BootGate from './components/BootGate.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { LocationProvider } from './context/LocationProvider.jsx'
import { dlog } from './utils/debugLog.js'

// ── TEMPORARY diagnostics — see utils/debugLog.js for how to use these ──
dlog('main.jsx', 'Module executing — about to call createRoot().render()')

if ('serviceWorker' in navigator) {
  dlog('SW', 'Initial navigator.serviceWorker.controller =', navigator.serviceWorker.controller)
  navigator.serviceWorker.getRegistrations().then((regs) => {
    dlog('SW', `${regs.length} registration(s) found`, regs.map(r => ({
      scope: r.scope,
      active: r.active?.state,
      waiting: !!r.waiting,
      installing: !!r.installing,
    })))
  })
  // Fires the moment a (possibly NEW) service worker takes control of this
  // page WITHOUT a reload — this is the exact mechanism `clientsClaim: true`
  // in vite.config.js's Workbox setup enables, and the prime suspect for
  // "first visit blank, refresh fixes it": if this fires AFTER Home has
  // already loaded but BEFORE the user navigates to Fest Schedule/Admin,
  // every fetch from that point on is answered by the service worker
  // instead of going straight to the network.
  // Priority 7 (Phase 4.2.3) — Admin login intermittently failing on one
  // Android Chrome profile (but not friends' phones, incognito, or
  // desktop) is the textbook signature of a profile stuck several
  // versions behind on its installed service worker: an "Add to Home
  // Screen" PWA window is kept alive by Android in the background far
  // longer than a normal tab, so `clientsClaim`/`skipWaiting` (see
  // vite.config.js) never get the chance to finish handing control to
  // the new SW — the page keeps running whatever old SW/cached bundle it
  // booted with, indefinitely, until something forces a full reload.
  // Every other environment in the report (friends' phones, incognito,
  // desktop) simply never accumulated that stale state. The standard,
  // Workbox-recommended fix: reload exactly once the moment a NEW worker
  // actually takes control, so a stuck profile self-heals on its next
  // visit instead of silently running stale code forever. `refreshing`
  // guards against a reload loop if this fires more than once.
  let refreshing = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    dlog('SW', '⚠ controllerchange fired — a service worker just took control of this page without a reload. New controller:', navigator.serviceWorker.controller)
    if (refreshing) return
    refreshing = true
    window.location.reload()
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <LocationProvider>
        <BootGate>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<App />}>
                <Route index element={<Home />} />
                <Route path="event/:eventId" element={<EventPage />} />
                <Route path="location/:locationId" element={<LocationDeepLink />} />
                <Route path="events" element={<EventsList />} />
                <Route path="admin" element={<AdminDashboard />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </BootGate>
      </LocationProvider>
    </ErrorBoundary>
  </StrictMode>,
)

dlog('main.jsx', 'render() call returned (sync render scheduled)')
