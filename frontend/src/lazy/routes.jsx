/* eslint-disable react-refresh/only-export-components */
// W3: route-level lazy wrappers. main.jsx imports these instead of the pages
// themselves, so the <Route element={<EventPage />}> lines stay untouched.
//
// Only routes worth a separate file are lazy. Each lazy chunk is one more
// file every NEW visitor's service worker downloads (and Vercel counts every
// file as an edge request), so tiny pages (EventsList, ~3 KB) stay in the
// main bundle.
import { lazy, Suspense } from 'react'

function RouteFallback() {
  return (
    <div role="status" aria-live="polite"
         style={{ padding: '48px 16px', textAlign: 'center', opacity: 0.6, fontSize: 14 }}>
      Loading…
    </div>
  )
}

function lazyRoute(load) {
  const Page = lazy(load)
  return function LazyRoute(props) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Page {...props} />
      </Suspense>
    )
  }
}

export const EventPage = lazyRoute(() => import('../pages/EventPage.jsx'))
export const AdminDashboard = lazyRoute(() => import('../pages/AdminDashboard.jsx'))
