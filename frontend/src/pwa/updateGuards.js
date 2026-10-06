// W3: guards that keep a long-lived PWA from running stale code, now that
// more of the app is lazy-loaded.
//
// 1) A page that booted before a deploy asks for a lazy chunk whose hashed
//    file no longer exists. Vite fires `vite:preloadError`; we reload ONCE
//    (loop-guarded) so the page picks up the new index.html + chunks.
// 2) Installed PWAs can sit in the background for days. Ask the browser to
//    check for a new service worker when the app returns to the foreground,
//    at most once per hour (one tiny request to /sw.js).

const RELOAD_KEY = 'ssn-preload-reload-at'
let navigationActive = false, pendingReload = false, refreshing = false

function reloadWhenIdle() {
  if (!pendingReload || navigationActive || refreshing) return
  refreshing = true
  window.location.reload()
}

window.addEventListener('campus:navigation-state', (event) => {
  navigationActive = event.detail.active
  reloadWhenIdle()
})

window.addEventListener('vite:preloadError', (event) => {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0)
    if (Date.now() - last < 30_000) return // already tried; don't loop
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch { return /* Cannot persist a safe reload guard. */ }
  event.preventDefault()
  pendingReload = true
  reloadWhenIdle()
})

if ('serviceWorker' in navigator) {
  let hadController = !!navigator.serviceWorker.controller
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first installed worker already matches this page. Subsequent worker
    // and missing-chunk updates share one guard, preserving an active route.
    if (!hadController) { hadController = true; return }
    pendingReload = true
    reloadWhenIdle()
  })
  let lastCheck = Date.now()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (Date.now() - lastCheck < 60 * 60 * 1000) return
    lastCheck = Date.now()
    navigator.serviceWorker.getRegistration().then((reg) => reg?.update()).catch(() => {})
  })
}
