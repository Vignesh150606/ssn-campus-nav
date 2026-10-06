import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import Home from './pages/Home.jsx'
import { EventPage, AdminDashboard } from './lazy/routes.jsx'
import './pwa/updateGuards.js'
import EventsList from './pages/EventsList.jsx'
import LocationDeepLink from './pages/LocationDeepLink.jsx'
import BootGate from './components/BootGate.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { LocationProvider } from './context/LocationProvider.jsx'
import { flushQueuedOffline } from './analytics/analyticsClient.js'

// Resends any analytics events that were queued to IndexedDB while offline
// (see analytics/analyticsClient.js) the moment connectivity returns.
window.addEventListener('online', () => { flushQueuedOffline() })

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
