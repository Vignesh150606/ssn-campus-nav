# Local campus navigation

Core navigation no longer calls `/api/route`, location search, health or auth.
`clientRouting.prepareClientRouting()` hydrates destinations and road status,
then loads the latest valid IndexedDB graph. Later routes and GPS reroutes read
these in-memory inputs synchronously using the existing Python-compatible
`offlineRouter.js`; its algorithm and the production graph are unchanged.

## Startup and persistence

The graph row in `ssn-campus-offline` / `bundle-cache` contains `data`, SHA-256
`hash`/`version`, `cachedAt`, `checkedAt`, `source` and `schema`. Validate both
cached and downloaded graphs, including geometry/weights, references,
duplicates, connected components and reachability of every cached destination.
Graph and metadata commit atomically; a failed transaction never replaces the
previous durable graph. Legacy graph rows are validated and migrated.

Missing/corrupt cache uses precached `/data/graph.json` as bootstrap. Missing
both produces an explicit connect/download/retry message. IndexedDB failure
allows the current tab to work but warns that offline reopening is not saved.
Browser storage eviction remains possible; installing a PWA is not a backup.

The graph is static deployment data. Normal visits never fetch `/api/graph`,
including on reconnect or visibility recovery. A SHA-256 version embedded by
Vite identifies the graph shipped with this app deployment. If IndexedDB has
not seen that version, download precached `/data/graph.json` once in the
background, validate its content and matching hash, then commit atomically.
Unchanged versions need no download. Invalid updates or failed writes retain
the good graph; failed deployment updates retry on the next app open.
The explicit `syncGraph()` function remains for diagnostics, but no visitor
flow calls it. It preserves the bundled version marker, so it cannot cause an
unchanged deployment to overwrite a later explicitly synchronized graph.
Future graph corrections require rebaking and deploying the frontend along
with the backend. Current walking paths remain intact during a graph update.
There is no service-worker cache for API responses.

Road closures still use `getClosures()` / `getRoadSegments()` and subscriptions,
not a frozen router copy. Poll visible clients every 30 seconds; public snapshot
cache-control remains 60 seconds (up to 90 seconds delivery once published,
with working connectivity). Offline uses the last known road status. The new
`/data/closures.json` is a BUILD-TIME copy of the existing backend road mirror,
used only to bootstrap without waiting for Render. It is not evidence roads
are currently open. The status badge tooltip states the road-status sync time,
or that it is a build-time copy awaiting synchronization.

Run `python scripts/bake_static_data.py` from backend when preparing a build.
It updates graph, locations and bootstrap road status without loading `.env`
in its default file mode. The Vite build rejects an out-of-date graph copy.
Retire `VITE_ROUTING_MODE=server`: navigation now always uses the client. Keep
`VITE_API_BASE` for legitimate online features; no credentials move to browsers.

## API dependency inventory

| Calls/components | Classification | Behavior |
| --- | --- | --- |
| Named/GPS routes, off-route reroutes, ETA, distances, turns, heading, GPS | Local | No backend request, health check or auth prerequisite |
| Search and shared campus destination deep links | Local/cache | Cached venue labels, aliases, relevance and typo matching; unknown deep-link IDs may use online venue lookup |
| `/api/graph` | Explicit diagnostics only | Visitors use deployed static graph and IndexedDB; no polling |
| Locations and road segments/closures | Cached/sync | Local startup and subscribed background refresh; build-time fallback clearly labelled |
| Schedule, event details, menus, posters | Cached/sync | Existing snapshots/IndexedDB and live API fallback; uncached/new records need internet |
| Copilot chat | Local/cache | On-device rules, aliases and FAQ; existing cards/actions retained; events/menus use snapshot/cache/API fallback |
| Feedback and analytics | Online/queued | Nonblocking analytics can queue offline; feedback submission needs internet |
| Admin/login/account, uploads, closures writes, dev tools | Online | Privileged backend/auth unchanged; no service-role key in frontend |
| QR image and uncached Storage images | Online/cache | Cached copies usable; missing assets need internet |
| OSM tiles and Google fonts | Online/cache | Viewed tiles/fonts cache; system fonts remain a fallback |

Analytics now batches for up to 60 seconds (formerly 8), with the existing
40-event threshold, hide beacon and offline persistence/replay. Nothing is
sampled or deliberately discarded. At sustained low event volume this reduces
timer-driven requests by up to 86.7%; short visits and burst-triggered batches
do not necessarily see that reduction.

Copilot no longer calls `/api/copilot/chat`. Its browser classifier mirrors the
Python vocabulary, fuzzy matching and intent order; parity tests use the actual
stdlib Python classifier. Compact room codes such as ECE302 now work too.
Common app questions answer locally; missing opening hours, registration fees,
contacts and unverified step-free paths are explicitly described as unknown.
Dynamic event/menu answers still read real datasets, with an offline saved-data
notice. The backend chat endpoint is retained for compatibility.

## Maps and update safety

App shell, Leaflet/rotation library, route/destination/GPS icons, baked datasets
and lazy chunks are precached. No raster archive or whole-campus download.
Visited OSM tiles are cached only in the campus bounds at zoom 15–18, with a
260-entry / 14-day limit. First worker activation saves only tiles already in
the displayed viewport, using normal browser HTTP caching, without redrawing.
The canonical OSM URL and its verified `Access-Control-Allow-Origin: *` permit
anonymous CORS images, avoiding opaque-response storage padding for new tiles.
Unvisited/evicted tiles may be absent offline; route geometry, markers and
guidance still work. This is revisit caching, consistent with the
[OSM tile policy](https://operations.osmfoundation.org/policies/tiles/), not
an offline map download feature.

Worker installation does not force a first-visit reload. Later worker updates
defer page reload until navigation finishes so they cannot erase an active
route. Missing lazy chunks use the same guard, so combined update signals
reload only once after exit. Narrow headers use compact status/schedule labels
with full accessible descriptions, avoiding logo overlap at 320 px.
GPS watch, auto-walk and guidance timers clean up on exit/unmount;
older guidance timers cannot dismiss a newer reroute/arrival announcement.
GPS accuracy/hysteresis, route snapping, penalties and camera behavior remain.

## Verification and limitations

- `node scripts/verify_local_navigation.mjs`: real app modules, transactional
  storage double, integrity failures, update/abort retention, 100 concurrent
  operations, search and closures, Render-down routing. No env files loaded.
- `node scripts/verify_snapshots.mjs`, `verify_pwa.mjs`, `verify_copilot.mjs`:
  existing snapshot, SW-rule and error contracts.
- `node scripts/verify_offline_browser.cjs`: built preview, real Chrome IDB/SW,
  offline reopening, browser GPS, route/guidance/deviation/reroute/arrival/exit,
  graph update/invalid retention, latest graph offline, corrupt-cache repair,
  first-run failure, blocked upgrades, reconnect during navigation, compiled
  update guards, and 320/390/768 px headers in both themes.
  Set `PLAYWRIGHT_MODULE_PATH` to an installed Playwright package if necessary.
  Default rendered concurrency is three device profiles. Initial 100-profile
  attempts exhausted local browser resources, so use the dedicated full-app
  test below for the required 100 users.
- `node scripts/verify_app_concurrency.cjs`: 100 complete app pages started
  simultaneously, 100 separately persisted IndexedDB graphs, GPS, routes and
  turn instructions, zero Render route/health requests. Shares a browser
  context/static assets and caps renderer processes to fit this laptop;
  application/navigation state and navigation databases remain independent.
  External origins are blocked by Chrome DNS rules, not Playwright request
  interception (which disables HTTP caching). No live OSM/Render load is sent.
- `node scripts/verify_navigation_load.mjs`: 100 simultaneous browser workers
  using actual navigation modules, independent module state and 100 separate
  real IndexedDB databases; 1000 routes + 1000 reroutes, zero Render route calls.
  This tests navigation concurrency, not 100 simultaneous rendered screens.
- Routing parity and `route_quality_test.py` check the unchanged algorithm.
  Backend/Supabase integration tests remain **UNTESTED** locally (dependencies
  unavailable). No production load test or deployment is claimed here.

Phone follow-up: open/install online, view the intended map area, disable mobile
data/Wi-Fi, reopen and walk a known route/deviation/arrival. Check GPS lock,
compass calibration, available device speech voices, battery/background OS
suspension, tile coverage and storage eviction. Browser emulation is not a
physical Android test. Voice synthesis depends on device-installed voices;
visual guidance and ETA have no network dependency.

Before deploy, keep the existing snapshot bucket/publisher checklist in
MERGE_NOTES.md. That bucket was not provisioned here. Live API fallbacks remain;
the local navigation bootstrap does not assume snapshots exist. Contact-info
privacy, authentication, database schema and backend routing are unchanged.

## Completed verification (2026-10-06)

| Acceptance | Evidence |
| --- | --- |
| A/B/C/D/E/M: online/offline, backend unavailable, IDB, bootstrap | Local module tests plus real built Chrome app, successful IDB persistence, offline close/reopen and all external APIs unavailable |
| F/G: invalid/versioned graph updates | 11 malformed graph mutations rejected; abort retains durable old row; changed geometry affects next local route; real IDB version update and corrupt-cache repair |
| H/I/J: rerouting, deviation, GPS | Chromium geolocation watch supplies accurate fixes; actual provider detects deviation, recalculates locally, guides, arrives and exits offline |
| K: SW/app caching | Generated 26-entry precache, actual viewed-tile cache, offline app reopening; compiled worker/chunk recovery waits for navigation exit |
| L: simultaneous users | 100 complete rendered pages, separate real IDB graphs and navigation state; GPS + directions + instruction card; zero route/health requests |
| Closures / restored connectivity | Actual getClosures subscription changes route warnings and reopening clears them; automatic reconnect graph sync preserves active walking UI |

PASS: frontend lint (0 errors, 15 existing warnings), local-navigation,
snapshot, PWA and Copilot scripts, baked-data consistency, Python syntax,
400/400 pure routing-quality checks and 39,156-case quick Python/JS parity
(zero mismatches). The exhaustive 306,734-case parity run is not claimed.
No frontend typecheck command exists.

PASS: production build using dummy URLs in a mirror excluding real `.env`
files. Precache: 26 entries / 737.92 KiB. Main JS: 524.67 KB raw / 159.90 KB
gzip, still over the existing 500 KB chunk-warning threshold and the 150 KB
asset guideline. All other built files are below 150 KiB. Canonical graph,
Python Dijkstra and JavaScript Dijkstra have no changes in this migration.

Desktop measurements (not Android guarantees): real graph IDB reads p50
about 1.1 ms, observed p95 1.2–3.7 ms; 100 isolated browser workers ran 1,000
routes + 1,000 GPS reroutes with pair p50 1.0 ms / p95 6.0 ms / max 36.2 ms;
maximum concurrent worker bootstrap 1,146.9 ms. No graph reload, validation,
network wait or health check occurs on each GPS/route tick. The graph remains
small (195 nodes / 250 edges); it is loaded once rather than duplicated into
the main JS bundle. Existing GPS watch is active only during tracking, uses
high accuracy, and cleans up on exit; memoized provider state and camera
animation cleanup are retained. Android heap/battery usage and real GPS
frequency have not been measured.

Generator limitations: earlier 100 separate-profile runs exhausted local
resources. A 100-page run with Playwright interception had 61 startup timeouts;
its thousands of callbacks and disabled HTTP caching distorted bootstrap.
The final DNS-isolated full-app run passed all 100 pages in 48.96 seconds across
shared desktop renderer resources. This measures test completion, not an
individual phone's startup time or a production API capacity limit.

Backend/FastAPI integration tests, Render admin-triggered snapshot publication,
production CDN propagation, and physical Android GPS/compass/storage/battery
remain **UNTESTED**. Supabase bucket creation, four snapshot uploads, anonymous
public reads and anonymous Storage write rejection were subsequently verified;
see MERGE_NOTES.md. Dependencies were not installed and no application deployment
or production load test was performed in this pass. Current request-reduction
changes are uncommitted.

## Changed files

- Routing: `src/routing/{graphData,clientRouting,validateGraph,searchLocations}.js`,
  `src/api.js`; removed obsolete `src/routing/routingMode.js`.
- Startup/storage/status: `src/components/{BootGate,OfflineIndicator}.jsx`,
  `src/offline/{db,offlineBundle}.js`, `src/data/dataClient.js`.
- Navigation/update/map: `src/context/LocationProvider.jsx`,
  `src/components/MapView.jsx`, `src/pwa/updateGuards.js`, `src/main.jsx`,
  `src/App.jsx`, `src/index.css`, `src/hooks/useDirections.js`.
- Copilot connectivity copy: `src/copilot/{ChatbotWidget.jsx,copilotApi.js}`.
- Build/bootstrap: frontend `vite.config.js`, `.env.example`,
  `pwa/runtimeCaching.tiles.js`, `public/data/closures.json`;
  backend `scripts/bake_static_data.py` (build-time export only).
- Verification: frontend `scripts/verify_{local_navigation,client_routing,
  snapshots,pwa,copilot,navigation_load}.mjs`,
  `scripts/verify_{offline_browser,app_concurrency}.cjs`;
  root `scripts/routing_parity/parity.mjs`, `.gitignore`, and these docs.

Paths in this section are relative to frontend unless explicitly noted.
