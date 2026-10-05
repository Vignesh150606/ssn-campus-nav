# Fest scaling integration

Rollback tag: `pre-fest-merge`. Work is on main; four lane commits, W2 → W1 → W3 → W4. Nothing is pushed or deployed by this integration. Input archives and handoffs are not committed. Backups and review inventory remain outside the repo in the integration scratch directory.

## Lane provenance and assumptions

- W2 = files (14).zip, confirmed by HANDOFF_W2.md. Public snapshot envelopes retain the live API's dataset shapes. Public event contact information is hidden with SNAPSHOT_INCLUDE_CONTACT_INFO=false, including live fallback; admin editing is unchanged. Set it true and republish schedule to restore the contact row. Previously cached data may remain visible until refreshed.
- W1 = files (13).zip. Reconstructed from scale-01-client-routing.patch and its 14 paths only. The nested baseline checkout and Git metadata are excluded. Backend router and canonical graph stay unchanged. Default routing moves to the authored JavaScript port; server mode remains an escape hatch.
- W3 = files (15).zip. Reconstructed from complete-file interface comments. Its package.json belongs beside scripts/measure-load.mjs, not to the React application.
- W4 = files (16).zip. Reconstructed from module docstrings. Missing endpoint cache/limiter bindings cannot be established from complete helper modules alone; no speculative endpoint policy is applied.

## MISSING

- HANDOFF_W1.md, HANDOFF_W3.md, HANDOFF_W4.md.
- W3 shared-file patches, including the intended complete bundle/precache changes.
- W4 shared-file patches for backend endpoint caches/limiter bindings and Copilot UI.
- W4 k6/load-test scenarios and docs/EVENT_DAY_CHECKLIST.md.
- W2's reported stub/backend and 14-scenario JS tests were not supplied.

The missing artifacts are not recreated or represented as tested. Module integration uses only interfaces documented in files that exist; missing policy changes remain deferred.

## Set these in Render/Vercel

Keep existing Render SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET, JWT_EXPIRES_HOURS, FRONTEND_BASE_URL and optional ADDITIONAL_ALLOWED_ORIGINS. No credentials are copied into frontend data.

Render W2 additions (defaults in backend/.env.example):
`SNAPSHOT_ENABLED=true`, `SNAPSHOT_BUCKET=snapshots`, `SNAPSHOT_CACHE_SECONDS=60`, `SNAPSHOT_DEBOUNCE_SECONDS=5`, `SNAPSHOT_MAX_WAIT_SECONDS=30`, `SNAPSHOT_PUBLISH_ON_STARTUP=false`, `SNAPSHOT_MENU_DAYS_AHEAD=14`, `SNAPSHOT_INCLUDE_CONTACT_INFO=false`, `SNAPSHOT_IMAGE_MAX_WIDTH=1080`, `SNAPSHOT_IMAGE_TARGET_KB=150`.

Vercel: keep VITE_API_BASE; add VITE_SNAPSHOT_BASE_URL (public bucket URL), VITE_ROUTING_MODE=client (W1). Optional VITE_SNAPSHOT_BUCKET_SECONDS is a cache-buster, not a freshness guarantee. The example Supabase project URL is UNVERIFIED for production.

W4 environment configuration and effective/deferred settings are recorded with its integration below.

## Before deploy

1. On the real Supabase project, review and run backend/supabase/snapshots_bucket.sql. The snapshots bucket and four JSON files do not exist yet. Public read must not imply anonymous write.
2. With backend dependencies and server-side environment configured, run `python scripts/publish_snapshots.py` from backend. First inspect `--dry-run` output locally. Verify all four public JSON URLs and referenced QR objects return valid responses.
3. Run the anonymous-write rejection test at the bottom of snapshots_bucket.sql using the correct anonymous key; an invalid-key authentication failure does not prove RLS isolation. Do not expose the service-role key to a browser or public logs.
4. Set the environment names above, run the backend checks marked UNTESTED below on the actual pinned dependencies, and deploy. Set SNAPSHOT_PUBLISH_ON_STARTUP=true when desired for event day.
5. Exercise QR/event, destination search, closures, GPS reroutes, menus, admin writes and offline restart on a phone. Confirm closure propagation with scripts/measure_snapshot_propagation.py. No live load test or infrastructure change was performed here.

First three operator commands, from backend after installing dependencies/configuring secrets privately:
`python scripts/publish_snapshots.py --dry-run`
`python scripts/publish_snapshots.py`
`python scripts/measure_snapshot_propagation.py --rounds 5`

## Freshness and fallback limits

The chosen snapshot Cache-Control is 60 seconds and schedule/closures client TTL is 30 seconds. Foreground subscribers refresh at that TTL and receive background updates; routing refreshes closures through the data getter. Offline/unreachable origins use last-known-good data and cannot promise current closures. Startup renders when cached or baked/snapshot data is available while backend health retries continue in the background. With no usable data it retains the blocking startup screen.

**90 seconds is a target after publication, not a guaranteed bound from an admin write.** The publisher waits 5 seconds for quiet edits, up to 30 seconds for a continuous burst; uploads, network latency and CDN revalidation add time. Supabase Free does not provide Smart CDN invalidation guarantees. W4's helper policy lists faster 10-second closure caches, but these absent endpoint patches are not enabled. Values were not silently reduced.

Absent snapshots fall back to live APIs. This preserves operation before bucket setup, but loses the intended Render load reduction. Search, health, analytics, Copilot and admin still use Render. Animated uploads are preserved instead of losing animation through single-frame WebP conversion; menu images target 300 KB and may exceed the 150 KB asset guideline. Existing images are not retroactively compressed.

## Validation

Backend runtime import, TestClient/auth/concurrency/protection tests, snapshot upload/dry-run against the DB and exact dependency-pin compatibility: **UNTESTED**. Backend dependencies are unavailable locally; they were not installed. Static syntax and pure routing checks, frontend checks, build sizes and browser verification are recorded below as they run.

## Budget estimate (no live usage totals)

8,000 visitors × (45 KB graph + 8 KB locations) ≈ 424 MB uncompressed static data. Schedule/closures/menus add small JSON bodies; poster/media/tile traffic and app bundles usually dominate. Actual artifact sizes and files over 150 KB are listed after build.

With snapshots working and client routing enabled, normal routes need zero Render route requests. At a 30-second refresh cadence, 5,000/20,000 foreground clients could make approximately 167/667 requests per second **per subscribed live snapshot** to Supabase Storage, not Render. Example analytics at one batch/minute yields 83/333 Render requests/second; Copilot at one message per user per 5 minutes yields 17/67 requests/second. These are workload assumptions, not measured capacity. Without snapshots, fallback traffic returns to Render and its Free resource ceiling remains a likely bottleneck.

### W2 verification
PASS: frontend lint (0 errors, 16 warnings), dummy-URL production build in a scratch mirror excluding real .env files (17 precache entries, 723.50 KiB), verify_snapshots.mjs mocked contracts, baked-data --check, Python AST syntax. Backend runtime tests and actual Storage/SQL/security verification: UNTESTED.

### W1 integration and verification
Only the 14 patch-listed paths were considered; BootGate retains W2's requested data-availability gate. Initial routes await getRoadSegments/getClosures, closure subscriptions refresh every 30 s in the foreground, and synchronous GPS reroutes use that continually updated input while invoking the same getter. Missing road status is no longer assumed all-open. PASS: client/server verification (no route API calls in client mode; closure refresh and reopening tested), lint (0 errors, 16 warnings), production build (17 precache entries, 765.73 KiB). The exhaustive Python/JS parity run was interrupted after prolonged reference execution; the supplied quick-mode coverage passed and is recorded below. Backend integration tests: UNTESTED.

### W3 integration and verification
PASS: lint (0 errors, 16 warnings), production build, 726 serialized tile-matcher cases, snapshot SW fallback provenance and preload-error recovery. Main JS is 557.52 KB raw / 165.21 KB gzip (over 150 KB), down from W1's approximately 630 KB raw; final dist is approximately 972 KiB. Precache is 23 entries / 769.00 KiB. The supplied lazy wrappers reduce the critical main chunk but add requests; missing admin precache exclusions remain DEFERRED, so this does not yet remove install-time admin downloads. Removed @react-google-maps/api only after source search returned no imports. Browser verification and final artifact accounting follow below. Vercel deployment-specific headers are UNTESTED on the actual CDN.

Browser PASS (isolated Chrome, mocked APIs): /, /location/main-gate and /event/f1-4aae7d loaded and survived reload while /api/health returned 503 and snapshots returned 404. Cached schedule survived offline restart with the generated service worker. Zero JS runtime errors and zero /api/route calls. Real phone GPS, backend admin writes, production Vercel rewrites/CDN and actual Supabase propagation remain UNTESTED.


## W4 integration / deferred behavior changes

Integrated only supplied module interfaces: protection.install(app) before CORS; health.router; existing /api/health delegates to the supplied cached probe (same 200/503 body contract); typed Copilot client errors reach the chat UI. The original Copilot classifier and original auth/per-IP limits remain in place. Middleware compresses eligible responses, bounds bodies and enforces no-store for admin responses. Health, snapshot and QR GET paths are not rate-limited by this middleware. No worker count, database schema, live bucket, paid plan or deployment was changed.

The following missing-policy changes are **DEFERRED, not guessed or enabled**: W4 endpoint microcache/ETag wrappers and invalidation bindings; replacement login/analytics/feedback/Copilot limiters; Copilot concurrency/queue guard and its message truncation; W3 admin precache exclusions. These need the missing lane patches or a separately approved behavior decision. The supplied W4 tests include assertions for these absent bindings and are not expected to all pass until those patches are supplied; do not interpret them as verified capacity.

Mock backend harnesses now use explicit dummy environment values, disable dotenv loading and snapshot publishing so they do not accidentally read real local credentials. Animation preservation is enforced in both browser JPEG-only shrinking and server animated-image pass-through. These are bug/safety fixes, not removed features.

### Additional environment names

Effective Render settings: RATE_BODY_MAX_BYTES=65536, RATE_UPLOAD_MAX_BYTES=6291456, RATE_IP_MODE=auto (trusted last X-Forwarded-For; CF header only in explicit cf mode), RATE_HEALTH_DB_TIMEOUT_S=8, RATE_HEALTH_DB_CACHE_S=30.

Recognized by supplied W4 helpers but **deferred / not effective for existing endpoint policies**: RATE_DISABLED, RATE_CACHE_DISABLED, RATE_CACHE_MAX_ENTRIES, RATE_CACHE_MAX_BYTES, RATE_ORIGIN_THREADS, RATE_ORIGIN_MISS_PER_MIN, RATE_ORIGIN_MISS_BURST, RATE_ORIGIN_TIMEOUT_S; RATE_LOGIN_PER_MIN/BURST, RATE_LOGIN_GLOBAL_PER_MIN/BURST, RATE_FEEDBACK_PER_MIN/BURST, RATE_ANALYTICS_PER_MIN/BURST, RATE_COPILOT_PER_MIN/BURST, RATE_COPILOT_GLOBAL_PER_MIN/BURST. Each /BURST shorthand means the full RATE_<NAME>_BURST environment name. RATE_DISABLED does not disable the existing auth.py limiter.

Likewise deferred Copilot helper settings: COPILOT_DISABLED, COPILOT_MAX_CONCURRENCY, COPILOT_MAX_QUEUE, COPILOT_QUEUE_WAIT_S, COPILOT_TIMEOUT_S, COPILOT_MAX_MESSAGE_CHARS, COPILOT_CACHE_TTL_S, COPILOT_CACHE_MAX, COPILOT_LOCATIONS_TTL_S, COPILOT_LOCATIONS_TIMEOUT_S. MOCK_DB_LATENCY_MS and PORT are local harness settings, not required new dashboard settings.

## Final verification status

- **PASS** frontend lint: zero errors, 15 existing/state-effect warnings at the final run. No typecheck script exists (JavaScript application).
- **PASS** dummy-URL production build in a scratch mirror excluding actual .env files: 23 precache entries, 769.75 KiB; main JS 557.51 KB raw / 165.21 KB gzip. Main JS is the only built file over 150 KiB. Dist totals about 973 KiB; graph 44.68 KiB, locations 8.45 KiB. Larger uploaded media cannot be inventoried without live access; menus target 300 KB and retained animations may exceed 150 KB.
- **PASS** verify_snapshots.mjs, verify_client_routing.mjs (both client/server modes), verify_pwa.mjs and verify_copilot.mjs: mocked missing/invalid snapshots, TTL/cache fallback, subscriber updates, closed/reopened routing, typed errors and serialized SW callbacks.
- **PASS** quick Python/JS parity: 39,156 cases, zero mismatches. Coverage includes all named-location pairs, closure scenarios, GPS grid/accuracy, preferred snap nodes, capped connector rings, junction flags, numeric rounding and distances. The exhaustive 306,734-case default run was interrupted and is **NOT completed / NOT claimed PASS**.
- **PASS** pure route_quality_test.py 200: 400/400 routes (200 named pairs + 200 GPS starts), deterministic, connected, no impossible shortcuts. These use only the existing routing engine/JSON and do not validate the backend HTTP/data layer.
- **PASS** baked graph/location consistency, Python AST parsing and diff whitespace review. Backend router and canonical graph have zero diff from pre-fest-merge.
- **PASS** isolated browser preview with mocked APIs: requested three URLs load/reload, no-snapshot/live fallback, health-503 startup, offline cached schedule restart; zero JS exceptions and zero Render route requests. Production CDN rewrites/headers and real-device GPS remain **UNTESTED**.
- **UNTESTED** backend runtime import, RBAC/concurrency/snapshot/protection integration tests and exact pinned dependencies (unavailable locally); live snapshot dry-run/uploads, anonymous-write rejection, real freshness propagation and capacity/load tests. No backend package installation or production request was made for this merge.

### Request / bandwidth estimates (not live metering)

A new visit may cost roughly 30-40 same-origin requests once HTML/app assets, 23 precache entries, baked JSON, manifest and update checks are included; 8,000 new visitors would therefore be roughly 240,000-320,000 Vercel requests before repeated navigation, admin activity and revalidation. A warm visit can often use the cached shell/assets, but sw.js update checks, HTML/data revalidation and deployment updates still count (approximately 1-5 same-origin requests is only an assumption). Missing admin exclusions keep cold-install request volume higher than the W3 goal.

8,000 visitors x (44.68 + 8.45) KiB = about 415 MiB of raw graph/location bodies if fetched separately once. The graph is also bundled into application JS; gzip reduces transfer bytes, while app updates/repeated downloads add bytes. Main JS gzip alone is approximately 1.32 GB for 8,000 full downloads. Snapshot bandwidth is separate Supabase Storage traffic: two assumed 2 KB datasets every 30 seconds for a 15-minute session is roughly 120 KB/person or 0.96 GB for 8,000 visitors. Actual schedule/poster/menu sizes are unknown. One 150 KB poster per person adds 1.2 GB; galleries, fonts and map tiles add more. These estimates do not establish that free quotas or Render capacity are sufficient.

## Files by lane

### W2 (87ecd3b)

- `backend/.env.example`
- `backend/data_access.py`
- `backend/main.py`
- `backend/requirements.txt`
- `backend/scripts/bake_static_data.py`
- `backend/scripts/measure_snapshot_propagation.py`
- `backend/scripts/publish_snapshots.py`
- `backend/snapshots.py`
- `backend/supabase/snapshots_bucket.sql`
- `docs/MERGE_NOTES.md`
- `frontend/.env.example`
- `frontend/public/data/graph.json`
- `frontend/public/data/locations.json`
- `frontend/pwa/runtimeCaching.snapshots.js`
- `frontend/scripts/verify_snapshots.mjs`
- `frontend/src/api.js`
- `frontend/src/components/BootGate.jsx`
- `frontend/src/components/PosterManager.jsx`
- `frontend/src/data/dataClient.js`
- `frontend/src/pages/EventPage.jsx`
- `frontend/src/pages/EventsList.jsx`
- `frontend/src/pages/Home.jsx`
- `frontend/vite.config.js`

### W1 (8c4a7e0)

- `docs/MERGE_NOTES.md`
- `frontend/.env.example`
- `frontend/package.json`
- `frontend/scripts/verify_client_routing.mjs`
- `frontend/src/api.js`
- `frontend/src/context/LocationProvider.jsx`
- `frontend/src/offline/offlineBundle.js`
- `frontend/src/offline/offlineRouter.js`
- `frontend/src/routing/clientRouting.js`
- `frontend/src/routing/graphData.js`
- `frontend/src/routing/routingMode.js`
- `frontend/vite.config.js`
- `scripts/routing_parity/parity.mjs`
- `scripts/routing_parity/py_router_runner.py`

### W3 (f2ea8e1)

- `docs/FALLBACK_CLOUDFLARE_PAGES.md`
- `docs/MERGE_NOTES.md`
- `frontend/package-lock.json`
- `frontend/package.json`
- `frontend/public/ssn-logo.webp`
- `frontend/pwa/runtimeCaching.shell.js`
- `frontend/pwa/runtimeCaching.tiles.js`
- `frontend/scripts/verify_pwa.mjs`
- `frontend/scripts/verify_snapshots.mjs`
- `frontend/src/App.jsx`
- `frontend/src/components/BootGate.jsx`
- `frontend/src/lazy/components.jsx`
- `frontend/src/lazy/routes.jsx`
- `frontend/src/main.jsx`
- `frontend/src/pages/Home.jsx`
- `frontend/src/pages/LocationDeepLink.jsx`
- `frontend/src/pwa/updateGuards.js`
- `frontend/vercel.json`
- `frontend/vite.config.js`
- `scripts/measure-load.mjs`
- `scripts/package.json`

### W4

- backend/health.py, backend/protection.py, backend/main.py, backend/.env.example
- frontend/src/copilot/copilotApi.js, frontend/src/copilot/ChatbotWidget.jsx, frontend/scripts/verify_copilot.mjs
- loadtest/local_server.py, loadtest/verify_protection.py
- frontend/.env.example (correct public-snapshot documentation)
- frontend/src/components/PosterManager.jsx (preserve APNG/animated WebP before backend validation)
- frontend/src/components/BootGate.jsx (release only on data, not health alone; remove obsolete comments)
- docs/MERGE_NOTES.md (final integration notes and verification)

Animated-image pass-through retains original bytes/metadata and may exceed image-size targets; runtime image optimization is UNTESTED without Pillow/backend dependencies.

Final startup boundary PASS: a new isolated browser with health 200 but no snapshots, no baked fetches and no cached/live data retained the blocking screen. Final frontend build/lint were rerun after this correction and animation preservation.
