# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project overview

SSN Campus Navigator — a campus navigation web app for SSN College of Engineering, Chennai. Primary real-world flow: a QR code on an event poster → visitor scans it → PWA opens → sees event details → taps "Get Directions" → gets a walking route + ETA from the main gate to the venue.

Two-part repo:
- `backend/` — FastAPI (Python 3.12), talking to Supabase (Postgres + Storage) in production.
- `frontend/` — React 19 + Vite, Leaflet/react-leaflet for the map, installable PWA (vite-plugin-pwa).

Read [README.md](./README.md) for the product framing and [SUPABASE_MIGRATION.md](./SUPABASE_MIGRATION.md) for the full data-layer/deployment handoff (schema, env vars, admin setup, what deliberately did *not* move to Supabase). `PRODUCTION_AUDIT_REPORT.md` and `ARCHITECTURAL_REVIEW.md` are point-in-time audit records, not living docs — don't treat their contents as current status without checking the code.

## Commands

### Backend (from `backend/`)
```bash
pip install -r requirements.txt --break-system-packages
cp .env.example .env   # fill in SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / JWT_SECRET
uvicorn main:app --reload
```
API docs at http://127.0.0.1:8000/docs. Needs a real Supabase project — there is no local/offline DB mode for the backend itself (`db.py` raises clearly if env vars are missing).

Lint: `ruff check .` (config in `backend/pyproject.toml`; select set is `E4,E7,E9,F,B,BLE,S,UP,I,SIM,RUF` — includes bandit-derived security checks, not ruff's unconfigured default set).

There is no pytest suite. "Tests" are standalone scripts, run directly:
```bash
python scripts/smoke_test_rbac.py        # RBAC/auth flow, in-memory fake Supabase, no live DB needed
python scripts/route_quality_test.py [N]  # routing regression (Dijkstra correctness/determinism), N random pairs, default 100
```
Other one-off scripts (all run from `backend/`, need Supabase credentials unless noted):
```bash
python scripts/create_admin.py            # create/reset a Super Admin login (only way to create one — no HTTP route does this)
python scripts/build_walkway_graph.py     # regenerate data/walkway_graph.json from GPX/KML survey files in data/raw/
python scripts/validate_walkway_graph.py  # sanity-check the built graph
python scripts/generate_graph_docs.py     # render docs/graph/* (png/svg/dot/mmd/csv/json exports)
python migrate_to_supabase.py             # one-time seed migration from backend/data/*.json into Supabase
```

### Frontend (from `frontend/`)
```bash
npm install
npm run dev       # http://127.0.0.1:5173
npm run build      # production build; FAILS the build if VITE_API_BASE isn't set (see vite.config.js)
npm run lint       # eslint .
npm run preview
```
Reads the backend URL from `frontend/.env` (`VITE_API_BASE=http://127.0.0.1:8000`). No frontend test suite exists.

## Architecture

### Backend request flow
`main.py` holds ~40 routes (locations, search, events, route, QR, admin auth, road closures, venue menus, analytics, feedback, Copilot chat) but contains almost no business logic itself — it wires HTTP to these modules:
- `db.py` — single shared Supabase client (service-role key; the frontend never receives a Supabase key at all, everything goes through this backend).
- `data_access.py` — every DB read/write goes through here. `main.py` never touches the Supabase client directly. Locations/venues are intentionally read-only (no write endpoint ever existed for them).
- `auth.py` — bcrypt + JWT admin auth, two roles (`superadmin`, `festadmin`). `get_current_active_admin`/`require_role` re-check the DB on every request (not just the JWT) so disabling an admin takes effect immediately, not at token expiry. Also owns login rate-limiting (`_check_login_rate_limit`) and a generic per-IP `rate_limit()` dependency factory used on public endpoints (feedback, analytics, Copilot chat).
- `utils/router.py` — Dijkstra over `data/walkway_graph.json`, with a hostel-road penalty and a road-closure penalty. **Production-stable, deliberately untouched by the Supabase migration** — treat changes here as high-risk. `road_segments.json` (open/closed state) is a write-through local mirror of the Supabase `road_segments` table, re-read fresh on every route call (not cached) so admin closures take effect on the next request without a restart; `walkway_graph.json` itself *is* cached in memory since it's static, build-time-generated data.
- `utils/copilot.py` — rule-based (non-LLM) NLU for the Campus Copilot chat feature.
- `devtools.py` — Super-Admin-only debug panel (Graph Viewer/Snap Debug/Route Inspector/Export), mounted under `/api/admin/devtools`. Deliberately self-contained and read-only against the live system — see the file's own docstring for the 4-step removal procedure if this feature is ever cut.

Cross-cutting things worth knowing before changing `main.py`:
- CORS is an explicit allow-list built from `FRONTEND_BASE_URL` + `ADDITIONAL_ALLOWED_ORIGINS`, only falling back to `*` when `FRONTEND_BASE_URL` isn't set at all (local dev). Don't reopen this to a wildcard in a configured deployment.
- Any Supabase/DB failure is normalized to `SupabaseUnavailableError` → a generic 503 to the caller (the real exception text is logged server-side only, never returned — it can contain raw Postgres/Storage internals).
- Uploaded images (`data_access.py`) are validated by actual file-signature ("magic bytes") sniffing, not just the client-supplied `Content-Type` header — don't reduce this back to a content-type-only check.

### Data model note
The original spec called for `buildings`/`building_rooms`/`building_aliases` tables; the actual schema uses one `venues` table instead, since no such hierarchy exists in the app today (room/floor/wing are free-text fields on *events*). See SUPABASE_MIGRATION.md §0 before assuming those tables exist.

### Frontend structure
- `App.jsx` — header/nav shell + `<Outlet/>`, theme toggle, mounts `OfflineIndicator`/`InstallPrompt`/`DevLocationPanel` globally.
- `pages/` — route-level screens: `Home.jsx` (search + map + live nav), `EventPage.jsx` (QR-scanned event "pass"), `EventsList.jsx`, `AdminDashboard.jsx` / `FestAdminDashboard.jsx` (+ `pages/admin/*` tabs: analytics, feedback, dev tools, manage fest admins, account settings).
- `context/LocationProvider.jsx` — shared GPS state (real `watchPosition` + a dev-mode simulated GPS via `DevLocationPanel`).
- `hooks/` — `useNavCamera.js` (heading-up camera smoothing/fusion), `useCompassHeading.js`, `useVoiceGuidance.js`, `useDirections.js`, `useDraggableSheet.js`.
- `components/MapView.jsx` — Leaflet map, markers, route line, heading-up rotation bridge; this is the densest component in the tree.
- `copilot/` — chat widget UI + engine calling the backend's `/api/copilot/chat`.
- `offline/` — IndexedDB-backed offline layer (`db.js`, `offlineBundle.js`), plus **`offlineRouter.js`**: a deliberately separate, simpler client-side Dijkstra used only when `/api/route` is unreachable. It intentionally does *not* port `backend/utils/router.py`'s more sophisticated live-GPS snap logic — see that file's own docstring — but does mirror the hostel-road penalty, closure penalty, and node-degree turn-detection logic to keep offline and online routes from disagreeing about what counts as a turn.

### PWA / caching (`vite.config.js`)
Service worker (Workbox via vite-plugin-pwa) deliberately has **no runtime-caching rule for `/api/*`** — that's handled at the app level (`src/api.js` + `src/offline/*`) instead, specifically to avoid two independent caches disagreeing about freshness (this caused a real "stale data until manual refresh" bug previously). Map tiles, Google Fonts, and Supabase Storage images are cached at the SW level since none of those have that staleness-correctness conflict. `navigateFallback` serves the precached app shell for any non-API SPA route (e.g. `/event/:id`) so deep links work offline.

## Working conventions found in this codebase

- Code comments here routinely explain *why*, including security-review history (search for "Security review", "Item N", "Production audit Part N") — read the surrounding comment before changing security-sensitive code (CORS, auth, rate limiting, image upload validation, `_client_ip`'s trust of the *last* `X-Forwarded-For` entry specifically because of how Render's proxy appends to it).
- `backend/utils/router.py` and `backend/data/walkway_graph.json` are called out repeatedly as production-stable/do-not-touch-casually; changes there should come with `scripts/route_quality_test.py` re-run.
- `.env.example` files are intentionally tracked (not gitignored); real `.env` files are gitignored. Never commit real Supabase/JWT secrets.
- `backend/data/*.json` is seed/build data only — nothing reads or writes it at runtime except `road_segments.json` (a live mirror, see above) and `walkway_graph.json` (static routing source). Don't reintroduce runtime JSON reads/writes for locations/events; that's what `data_access.py`/Supabase are for now.
