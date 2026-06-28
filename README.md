# SSN Campus Navigator

> **Production backend migration:** this app now runs on Supabase
> (Postgres + Storage) instead of local JSON files for events/locations/road
> closures, with real per-admin login. See **[SUPABASE_MIGRATION.md](./SUPABASE_MIGRATION.md)**
> for the full setup + deployment guide. Everything below describes the
> original JSON-file version and is kept for local-dev/reference; the JSON
> files in `backend/data/` are now only used as the source for the one-time
> migration script (`backend/migrate_to_supabase.py`) and as the seed data
> `utils/router.py` builds its graph from — they are no longer written to at
> runtime.

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
campus-nav/
├── backend/
│   ├── main.py            # FastAPI app — locations, search, events, route, QR
│   ├── requirements.txt
│   ├── data/
│   │   ├── locations.json # PLACEHOLDER campus locations — edit with real data
│   │   └── events.json    # PLACEHOLDER fest events — edit with real schedule
│   ├── utils/
│   │   └── qr_generator.py
│   └── static/qr/         # generated QR code PNGs
└── frontend/
    ├── src/
    │   ├── api.js          # talks to the FastAPI backend
    │   ├── constants.js     # category colors, fest tags, default entry point
    │   ├── App.jsx          # header + routing shell
    │   ├── components/
    │   │   ├── MapView.jsx       # Leaflet map, markers, route line
    │   │   ├── SearchBar.jsx
    │   │   ├── CategoryChips.jsx
    │   │   └── LocationCard.jsx
    │   └── pages/
    │       ├── Home.jsx          # search + map + results
    │       ├── EventPage.jsx     # "festival pass" — scanned via QR
    │       └── EventsList.jsx    # full fest schedule
    └── vite.config.js       # PWA config (offline cache, installable)
```

---

## Running it locally

### 1. Backend (FastAPI)

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

## ⚠️ Replace the placeholder campus data

`backend/data/locations.json` currently has **draft coordinates** centered
near SSN's known campus location (12.8404, 80.1542) — they are realistic in
spacing but not accurate to real buildings. Before this becomes usable on
campus:

1. Open Google Maps, find each real building (Main Building, EEE Block, CSE
   Block, Library, Auditorium, hostels, gates, etc.)
2. Right-click the spot → "What's here?" → copy the lat/long shown
3. Update the `lat` / `lng` fields in `locations.json` for each entry (add
   new entries for anything missing, using the same shape)

`backend/data/events.json` has 3 **draft fest events** (Invente / Instincts)
so the event-page + QR flow can be built and tested end to end. Replace these
with the real fest schedule — same fields, just update `name`, `location_id`
(must match an id in `locations.json`), `date`, `start_time`, `end_time`,
`description`.

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

- [x] **Phase 1** — Scope, stack, data model
- [x] **Phase 2** — Campus location + event data model (placeholder data)
- [x] **Phase 3** — Backend API (search, locations, events, straight-line route, QR)
- [x] **Phase 4** — Frontend: map, search, category filters, event "pass" pages
- [x] **Phase 6 (partial)** — PWA basics: installable, offline caching of API
      responses + map tiles
- [ ] **Phase 5** — Real walking-path routing (currently straight-line). Will
      use a small graph of campus walkway nodes instead of direct lat/lng lines.
- [ ] **Phase 7 (stretch)** — Wheelchair-accessible route toggle, Tamil/English
      language toggle, printable QR checkpoint signs for key junctions
- [ ] **Phase 8** — Deployment (e.g. Vercel for frontend, Render/Railway for
      backend) + final polish for demos/portfolio
