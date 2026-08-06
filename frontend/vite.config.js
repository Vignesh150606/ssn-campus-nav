import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// ── Fix for "Uncaught ReferenceError: L is not defined" ─────────────────────
// leaflet-rotate ships a UMD/IIFE build (its package.json "browser" field)
// written for plain <script> usage, where Leaflet's own <script> tag has
// already created a global `L` before leaflet-rotate runs. Vite 8 (Rolldown)
// bundles every dependency as real ESM and never creates that global, so the
// plugin's bare reference to `L` throws at module-evaluation time — before
// React even mounts, which is why the whole app went white instead of just
// failing a feature.
// The fix is to give leaflet-rotate's own module a real, local `L` binding
// (a normal ES import) right before Rolldown bundles it. This is scoped to
// that one module only — nothing is attached to `window` or any other global.
function leafletGlobalFix() {
  const PLUGIN_PACKAGES = ['leaflet-rotate']
  return {
    name: 'leaflet-global-fix',
    transform(code, id) {
      const isTargetPackage = PLUGIN_PACKAGES.some((pkg) =>
        id.includes(`/node_modules/${pkg}/`)
      )
      if (isTargetPackage && !id.endsWith('.css')) {
        return { code: `import L from 'leaflet';\n${code}`, map: null }
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // Item 18 (strengthened) — apiBase.js already throws at module-load time
  // in the browser if a production build shipped without VITE_API_BASE,
  // but that only surfaces the problem to the first real visitor, after
  // the broken build has already deployed. Checked here too because this
  // file runs as actual Node.js during `vite build` itself (unlike
  // application code, which is only ever bundled, never executed, at
  // build time) — so a misconfigured Vercel deploy now fails the BUILD
  // STEP directly, the same way a misconfigured Render deploy fails at
  // backend startup (see qr_generator.py's FRONTEND_BASE_URL guard), and
  // never goes live at all.
  if (command === 'build' && mode === 'production') {
    const env = loadEnv(mode, process.cwd(), 'VITE_')
    if (!env.VITE_API_BASE) {
      throw new Error(
        'VITE_API_BASE is not set for this production build. Set it in ' +
        "your deployment platform's environment variables (see README.md " +
        '/ SUPABASE_MIGRATION.md) — without it the build would ship ' +
        'permanently pointed at 127.0.0.1:8000, which does not exist for ' +
        'real visitors.'
      )
    }
  }

  return {
  plugins: [
    leafletGlobalFix(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // generateSW's default globPatterns only match built js/css/html, so
      // these public/ image assets (referenced from index.html/App.jsx/
      // BootGate.jsx, not imported in JS) would otherwise never enter the
      // precache manifest and would 404 on a first-ever page paint with no
      // network — this is standard PWA app-shell caching, unrelated to any
      // per-feature data caching.
      includeAssets: [
        'favicon.svg',
        'icons.svg',
        'icons/icon-192.png',
        'icons/icon-512.png',
        'icons/apple-touch-icon.png',
        'ssn-logo.png',
      ],
      manifest: {
        name: 'SSN Campus Navigator',
        short_name: 'SSN Navigator',
        description: 'Find buildings, departments and fest events at SSN College of Engineering, with walking directions.',
        theme_color: '#0d4ba0',
        // Priority 4 (PWA polish): white background behind the icon, to
        // match the app icon itself (blue SSN logo on white) — this is
        // what Android/Chrome use to generate the native install/launch
        // splash screen from the icons below.
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Phase 4A.1: removed the previous NetworkFirst rule for `/api/*`.
        // Events/admin/route data already has its own freshness logic in
        // the app (EventsList's localStorage cache + 20s poll, BootGate's
        // health gate, etc.) — having the service worker *also* cache
        // those same responses meant two independent caches could disagree
        // about what's "current", and a stale/erroring SW cache entry
        // would silently win on the very first load of a session, only
        // clearing once something (a reload) forced the SW to revalidate.
        // That matches "fest/event/admin only show data after one refresh"
        // exactly. Map tiles are static images and have no such conflict,
        // so CacheFirst stays for those.
        //
        // Task 1 (offline support) — /api/* still deliberately has no
        // runtime-caching rule here, for the exact reason above: it would
        // reintroduce the same two-caches-disagree bug. Offline resilience
        // for /api/* data instead lives at the app level now (src/api.js +
        // src/offline/*, an IndexedDB cache with its own explicit
        // freshness/fallback rules the app controls directly), the same
        // layer EventsList's own cache already used. Fonts and images
        // below are added because neither has that same conflict — a
        // cached font file or poster image doesn't "go stale" the way an
        // event list or a route does.
        clientsClaim: true,
        skipWaiting: true,
        // SPA deep links (e.g. /event/abc123, /events, /admin) have no
        // precached HTML of their own — only '/' (start_url) does. Without
        // this, refreshing (or cold-launching) on one of those routes
        // while offline 404s at the network layer before React Router
        // ever gets a chance to run. This tells the generated service
        // worker to serve the precached app shell for any navigation
        // request that isn't itself precached, letting client-side
        // routing take over exactly like an online first paint would.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.hostname.includes('tile.openstreetmap.org'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
          {
            // Google Fonts' CSS file (index.html's <link> tag) — this is
            // the small stylesheet listing @font-face rules, not the font
            // binaries themselves (those are the gstatic.com rule below).
            // Google occasionally updates which specific font files a
            // given CSS request maps to, so this one prefers the network
            // when available and only falls back to cache when it can't
            // be reached — unlike the webfont files themselves, which are
            // immutable per URL and safe to cache-first.
            urlPattern: ({ url }) => url.hostname === 'fonts.googleapis.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-stylesheets' },
          },
          {
            // The actual .woff2 font files. Standard workbox recipe for
            // Google Fonts: each URL is content-addressed/immutable, so
            // CacheFirst with a long expiration is safe, and
            // cacheableResponse is required since these are cross-origin
            // (opaque) responses that would otherwise never be considered
            // "successful" enough to cache.
            urlPattern: ({ url }) => url.hostname === 'fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          {
            // Poster/venue-menu images served from Supabase Storage.
            // Stale-while-revalidate: show whatever's cached immediately
            // (so a venue card never blocks on a slow image), refresh it
            // in the background for next time — appropriate here since,
            // unlike locations/events/routes, a slightly-stale poster
            // image has no correctness impact.
            urlPattern: ({ url }) => url.hostname.endsWith('.supabase.co') && url.pathname.includes('/storage/'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'supabase-images',
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
  }
})
