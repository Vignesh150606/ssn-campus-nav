# SSN Campus Navigator

> **Production backend:** this app runs on Supabase (Postgres + Storage)
> instead of local JSON files for events/locations/road closures, with real
> per-admin login. See **[SUPABASE_MIGRATION.md](./SUPABASE_MIGRATION.md)**
> for the database schema, environment variables, admin setup, and
> deployment guide. The JSON files in `backend/data/` are kept only as
> seed data for the one-time migration script
> (`backend/migrate_to_supabase.py`) and as the source `utils/router.py`
> builds its walkway graph from — nothing reads or writes them at runtime.

A smart campus navigation web app for **SSN College of Engineering, Chennai** —
built around a real use case: helping visitors from other colleges find their
way to fest events (Invente / Instincts) by scanning a QR code.

**Flow:** print a QR code on an event poster → visitor scans it → opens the
SSN Navigator (installable as an app, no app store needed) → sees the event
details → taps **Get Directions** → sees a route + walking time from the main
gate to the venue on the campus map.

---

## Tech stack

| Layer    | Tech |
|----------|------|
| Frontend | React + Vite, React Router, Leaflet / react-leaflet, vite-plugin-pwa |
| Backend  | FastAPI (Python) |
| Data     | Supabase (Postgres + Storage) — see SUPABASE_MIGRATION.md. Local JSON files remain only as migration seed data. |
| Maps     | OpenStreetMap tiles (free, no API key) |
| QR codes | `qrcode` Python library, generated per event |

---

## Project structure

```
nav_v2/
├── backend/
│   ├── main.py                # FastAPI app — locations, search, events, route,
│   │                           # QR, admin auth, road closures, venue menus
│   ├── auth.py                 # Admin login + JWT issue/verify
│   ├── db.py                   # Supabase client wrapper
│   ├── data_access.py           # Read/write helpers over Supabase tables
│   ├── requirements.txt
│   ├── data/                   # Seed data only (migrated into Supabase; not
│   │                           # written to at runtime) — locations, events,
│   │                           # walkway_graph, road_segments
│   ├── scripts/
│   │   ├── create_admin.py      # add/reset an admin login
│   │   ├── build_walkway_graph.py
│   │   └── validate_walkway_graph.py
│   ├── utils/
│   │   ├── router.py           # Dijkstra over the walkway graph
│   │   ├── copilot.py          # Campus Copilot rule-based NLU engine
│   │   └── qr_generator.py
│   └── static/qr/               # generated QR code PNGs
└── frontend/
    └── src/
        ├── api.js               # talks to the FastAPI backend
        ├── constants.js          # category colors, fest tags, name overrides
        ├── App.jsx               # header + routing shell
        ├── context/
        │   └── LocationProvider.jsx  # shared GPS state (real watchPosition +
        │                             # dev-mode simulated GPS)
        ├── hooks/
        │   ├── useNavCamera.js       # heading-up camera smoothing/fusion
        │   ├── useCompassHeading.js
        │   ├── useVoiceGuidance.js
        │   ├── useDraggableSheet.js
        │   └── useElementHeightVar.js
        ├── copilot/
        │   ├── ChatbotWidget.jsx     # Campus Copilot chat UI
        │   └── copilotEngine.js
        ├── components/
        │   ├── MapView.jsx           # Leaflet map, markers, route line,
        │   │                         # heading-up rotation bridge
        │   ├── SearchBar.jsx, CategoryChips.jsx, LocationCard.jsx
        │   ├── RoutePreviewPanel.jsx, NearbyFacilities.jsx
        │   ├── NavCompass.jsx, CompassWidget.jsx, NavSettingsPanel.jsx
        │   ├── VenueMenuCard.jsx / VenueMenuInline.jsx / VenueMenuAdmin.jsx
        │   ├── PosterManager.jsx     # admin event image/poster upload
        │   ├── BootGate.jsx           # startup health-check / cold-start screen
        │   └── DevLocationPanel.jsx  # dev-only GPS simulator (hidden in prod)
        └── pages/
            ├── Home.jsx               # search + map + live navigation
            ├── EventPage.jsx          # "festival pass" — scanned via QR
            ├── EventsList.jsx         # full fest schedule
            ├── LocationDeepLink.jsx
            └── AdminDashboard.jsx     # admin login + events/venues/closures
```

See **[SUPABASE_MIGRATION.md](./SUPABASE_MIGRATION.md)** for the database schema,
admin account setup, and deployment steps.

---

## Running it locally

### 1. Backend (FastAPI)

Needs a Supabase project + `backend/.env` first — see
[SUPABASE_MIGRATION.md §§ 1–3](./SUPABASE_MIGRATION.md) for the SQL, storage
bucket, and environment variables.

```bash
cd backend
pip install -r requirements.txt --break-system-packages
uvicorn main:app --reload
```

API docs: http://127.0.0.1:8000/docs

### 2. Frontend (React + Vite)

```bash
cd frontend
npm install
npm run dev
```

App: http://127.0.0.1:5173

The frontend reads the backend URL from `frontend/.env`:
```
VITE_API_BASE=http://127.0.0.1:8000
```

---

## Campus data

`backend/data/` now holds real surveyed data, not placeholders: 32 campus
locations with real coordinates, and a walkway graph digitized from GPX/KML
survey files (see `backend/scripts/build_walkway_graph.py` and
`validate_walkway_graph.py`). This data was migrated into Supabase and the
JSON files remain only as the seed/rebuild source — see
[SUPABASE_MIGRATION.md § 6](./SUPABASE_MIGRATION.md) for how to re-run the
migration if you change the seed data.

Adding a new location or event now happens through the **Admin Dashboard**
(`/admin`) once you've created an admin login — see
[SUPABASE_MIGRATION.md](./SUPABASE_MIGRATION.md) — rather than by hand-editing
JSON.

---

## QR codes for the fest

Each event has a QR code at:

```
GET /api/events/{event_id}/qr
```

This encodes a link to `https://<your-deployed-frontend>/event/{event_id}`.

**Before printing posters**, set the real deployed frontend URL:

```bash
export FRONTEND_BASE_URL="https://your-deployed-app.com"
cd backend
python utils/qr_generator.py   # regenerates all event QR codes
```

(Until deployed, QR codes point at `http://localhost:5173`, which only works
on the same machine — fine for local testing, not for printing.)

---

## Roadmap

- [x] **Phase 1–2** — Scope, stack, campus location + event data model
- [x] **Phase 3** — Supabase backend migration (Postgres + Storage, real
      per-admin login) — see SUPABASE_MIGRATION.md
- [x] **Phase 4** — Frontend: map, search, category filters, event "pass"
      pages, real walking-path routing (Dijkstra over a surveyed walkway
      graph, replacing the original straight-line routing)
- [x] **Phase 4.x** — Admin Dashboard (events/venues/road closures/poster
      uploads), Campus Copilot chatbot, Heading-Up navigation with live
      compass/GPS fusion, voice guidance, QR-code navigation, food/venue
      menus, route preview, nearby facilities
- [x] **Phase 6** — PWA: installable, offline caching of API responses and
      map tiles
- [ ] **Phase 7 (stretch)** — Wheelchair-accessible route toggle, Tamil/
      English language toggle, printable QR checkpoint signs for key
      junctions
- [ ] **Phase 8** — Further deployment polish (see SUPABASE_MIGRATION.md for
      the current Render/Vercel setup already in place)
