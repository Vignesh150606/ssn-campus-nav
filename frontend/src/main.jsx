import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import Home from './pages/Home.jsx'
import EventPage from './pages/EventPage.jsx'
import EventsList from './pages/EventsList.jsx'
import AdminDashboard from './pages/AdminDashboard.jsx'
import BootGate from './components/BootGate.jsx'
import { LocationProvider } from './context/LocationProvider.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LocationProvider>
      <BootGate>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<App />}>
              <Route index element={<Home />} />
              <Route path="event/:eventId" element={<EventPage />} />
              <Route path="events" element={<EventsList />} />
              <Route path="admin" element={<AdminDashboard />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </BootGate>
    </LocationProvider>
  </StrictMode>,
)
