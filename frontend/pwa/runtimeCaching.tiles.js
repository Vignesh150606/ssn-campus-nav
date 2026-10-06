// Workbox runtimeCaching entries for OpenStreetMap raster tiles (W3 lane).
// Default export is an ARRAY; the merge step concatenates it into the
// workbox.runtimeCaching list in vite.config.js. The application reuses only
// isCampusTile() to cache the already displayed viewport after first install.
//
// What it does: caches ONLY tiles that fall inside the campus bounding box
// AND inside the zoom range the map actually allows (MapView.jsx sets
// minZoom={15}; Leaflet's TileLayer default maxZoom is 18). Everything else
// is not matched, so it goes straight to the network and is not stored.
//
// It deliberately does NOT pre-download ("warm") tiles: the OSM tile policy
// says offline/bulk downloading is not permitted on tile.openstreetmap.org.
// Tiles are cached only after a user's own map view requests them.

// ── Campus bbox ──────────────────────────────────────────────────────────
// Derived from backend/data/walkway_graph.json nodes
//   (lat 12.74868–12.75375, lng 80.18895–80.20406) and locations.json
//   (lat 12.74908–12.75341, lng 80.18966–80.20409), plus ~0.003° padding so
//   edge-of-campus panning is covered. MapView.jsx CAMPUS_CENTER =
//   [12.7510, 80.1970]. If you add buildings outside this box, widen it.
export const CAMPUS_BBOX = { south: 12.7455, north: 12.7570, west: 80.1860, east: 80.2070 }
export const MIN_ZOOM = 15
export const MAX_ZOOM = 18

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z)
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
}

const OSM_HOST = /^([abc]\.)?tile\.openstreetmap\.org$/

export function isCampusTile(url) {
  if (!OSM_HOST.test(url.hostname)) return false
  const m = url.pathname.match(/^\/(\d+)\/(\d+)\/(\d+)\.png$/)
  if (!m) return false
  const z = +m[1], x = +m[2], y = +m[3]
  if (z < MIN_ZOOM || z > MAX_ZOOM) return false
  return (
    x >= lon2x(CAMPUS_BBOX.west, z) && x <= lon2x(CAMPUS_BBOX.east, z) &&
    y >= lat2y(CAMPUS_BBOX.north, z) && y <= lat2y(CAMPUS_BBOX.south, z)
  )
}

// Tiles in the bbox at z15–18 = 6 + 15 + 45 + 160 = 226 (computed with the
// same formulas as above), so 260 entries holds every tile with headroom.
export default [
  {
    urlPattern: ({ url }) => {
      if (!/^([abc]\.)?tile\.openstreetmap\.org$/.test(url.hostname)) return false
      const m = url.pathname.match(/^\/(\d+)\/(\d+)\/(\d+)\.png$/)
      if (!m) return false
      const [z, x, y] = m.slice(1).map(Number)
      if (z < 15 || z > 18) return false
      const tx = (lon) => Math.floor(((lon + 180) / 360) * 2 ** z)
      const ty = (lat) => {
        const rad = lat * Math.PI / 180
        return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * 2 ** z)
      }
      return x >= tx(80.1860) && x <= tx(80.2070) && y >= ty(12.7570) && y <= ty(12.7455)
    },
    handler: 'CacheFirst',
    options: {
      cacheName: 'map-tiles-campus-v1',
      // New tiles use anonymous CORS (200), avoiding opaque quota padding.
      // Keep 0 for legacy cached requests during upgrade; viewing only,
      // never a background whole-campus/offline download.
      cacheableResponse: { statuses: [0, 200] },
      expiration: {
        maxEntries: 260,
        // OSM policy: honour HTTP expiry, or at least 7 days. 14 days keeps
        // returning visitors off tile.openstreetmap.org for the whole fest.
        maxAgeSeconds: 60 * 60 * 24 * 14,
        // Opaque entries are counted with large padding by Chromium's quota
        // accounting; if the browser runs low, drop this cache, don't fail.
        purgeOnQuotaError: true,
      },
    },
  },
]
