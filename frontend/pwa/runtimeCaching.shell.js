// Workbox runtimeCaching entries for the app shell (W3 lane). Default-exported
// ARRAY, concatenated by the merge step.
//
// Admin-only lazy chunks (AdminDashboard, DevTools, admin/*) are excluded from
// the precache list (see globIgnores patch) so that ordinary visitors don't
// download them. This rule lets an admin's browser cache them after first use.
// Hashed filenames are immutable, so CacheFirst is safe.
export default [
  {
    urlPattern: ({ url, sameOrigin }) =>
      sameOrigin && /^\/assets\/.+\.(?:js|css)$/.test(url.pathname),
    handler: 'CacheFirst',
    options: {
      cacheName: 'lazy-assets-v1',
      cacheableResponse: { statuses: [200] },
      expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 30 },
    },
  },
]
