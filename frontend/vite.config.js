import { defineConfig } from 'vite'
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
export default defineConfig({
  plugins: [
    leafletGlobalFix(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'SSN Campus Navigator',
        short_name: 'SSN Navigator',
        description: 'Find buildings, departments and fest events at SSN College of Engineering, with walking directions.',
        theme_color: '#003b7a',
        background_color: '#003b7a',
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
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.hostname.includes('tile.openstreetmap.org'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
        ],
      },
    }),
  ],
})
