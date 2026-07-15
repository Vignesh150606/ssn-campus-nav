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
import { initOfflineSync } from './offline/offlineBundle.js'
import { flushQueuedOffline } from './analytics/analyticsClient.js'

// Phase X (Feature 1 — Offline-First Experience). Warms/refreshes the
// offline cache now if online, and keeps it in sync on every future
// reconnect — see offline/offlineBundle.js. Also resends any analytics
// events that were queued to IndexedDB while offline (see
// analytics/analyticsClient.js) on that same reconnect signal.
initOfflineSync()
window.addEventListener('online', () => { flushQueuedOffline() })

if ('serviceWorker' in navigator) {
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
