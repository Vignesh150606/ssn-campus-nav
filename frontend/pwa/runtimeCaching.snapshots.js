/**
 * frontend/pwa/runtimeCaching.snapshots.js  --  W2
 *
 * Workbox runtimeCaching entries for the static snapshots. Default export = array; the merge
 * chat concatenates it with the other lanes' arrays inside vite.config.js:
 *
 *     import snapshotCaching from './pwa/runtimeCaching.snapshots.js'
 *     runtimeCaching: [...snapshotCaching, ...tilesCaching, ...existingEntries]
 *
 * ORDER MATTERS: workbox uses the first matching entry. The existing 'supabase-images' rule in
 * vite.config.js matches every *.supabase.co/storage/ URL, so these entries MUST come BEFORE it
 * or the snapshot JSON would be cached as an "image" (StaleWhileRevalidate, 80 entries).
 *
 * vite-plugin-pwa serialises these functions into the service worker, so every function below
 * is self-contained (no references to outer variables).
 *
 * Strategy notes:
 *  - live snapshots: NetworkFirst with a 3 s timeout. dataClient.js already does its own
 *    stale-while-revalidate + IndexedDB last-known-good; a SWR service worker on top would add a
 *    second layer of staleness. This entry's job is the offline / flaky-network fallback.
 *    The cache key ignores the query string (VITE_SNAPSHOT_BUCKET_SECONDS cache-buster).
 *  - qr/*.png: immutable per event, CacheFirst.
 *  - /data/*.json (baked): StaleWhileRevalidate, same-origin, served by Vercel.
 */
export default [
  {
    // https://<ref>.supabase.co/storage/v1/object/public/snapshots/{schedule,menus,closures,posters}.json
    urlPattern: ({ url }) =>
      url.pathname.includes('/storage/v1/object/public/snapshots/') && url.pathname.endsWith('.json'),
    handler: 'NetworkFirst',
    options: {
      cacheName: 'snapshots-live-v1',
      networkTimeoutSeconds: 3,
      cacheableResponse: { statuses: [200] },
      expiration: { maxEntries: 12, maxAgeSeconds: 60 },
      plugins: [
        {
          cachedResponseWillBeUsed: async ({ cachedResponse }) => {
            if (!cachedResponse) return null
            const headers = new Headers(cachedResponse.headers)
            headers.set('X-SSN-Snapshot-Source', 'sw-cache')
            return new Response(cachedResponse.body, {
              status: cachedResponse.status, statusText: cachedResponse.statusText, headers,
            })
          },
        },
        {
          cacheKeyWillBeUsed: async ({ request }) => {
            const u = new URL(request.url)
            u.search = ''
            return u.href
          },
        },
      ],
    },
  },
  {
    // .../snapshots/qr/<event_id>.png
    urlPattern: ({ url }) => url.pathname.includes('/storage/v1/object/public/snapshots/qr/'),
    handler: 'CacheFirst',
    options: {
      cacheName: 'snapshots-qr-v1',
      cacheableResponse: { statuses: [200] },
      expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 * 30 },
    },
  },
  {
    // /data/graph.json, /data/locations.json (baked at build time)
    urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/data/') && url.pathname.endsWith('.json'),
    handler: 'StaleWhileRevalidate',
    options: {
      cacheName: 'baked-data-v1',
      cacheableResponse: { statuses: [200] },
      expiration: { maxEntries: 6, maxAgeSeconds: 60 * 60 * 24 * 30 },
    },
  },
]
