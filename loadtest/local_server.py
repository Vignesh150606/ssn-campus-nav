"""
loadtest/local_server.py - run YOUR backend locally with Supabase replaced by local JSON files.

Why: load tests must never burn the free Supabase / Render quotas. This starts the real FastAPI app
(main.py, protection.py, health.py, all middleware) but every data_access / db call is answered from
backend/data/*.json after a simulated network delay. Nothing leaves your machine.

    cd backend
    python ..\\loadtest\\local_server.py            # http://127.0.0.1:8000
    set MOCK_DB_LATENCY_MS=120                      # optional: slower "Supabase" (default 40)
    set PORT=8001                                   # optional

On start it prints an ADMIN_TOKEN for the admin-read k6 scenario.
Run from anywhere; it changes into backend/ itself.
"""
import asyncio
import json
import os
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND))
os.chdir(BACKEND)

# These offline harnesses must not load the real backend .env.
import dotenv  # noqa: E402
dotenv.load_dotenv = lambda *_args, **_kwargs: False
os.environ["SNAPSHOT_ENABLED"] = "false"
os.environ["SNAPSHOT_PUBLISH_ON_STARTUP"] = "false"
os.environ["SUPABASE_URL"] = "https://mock.invalid"
os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "mock"
os.environ["JWT_SECRET"] = "local-loadtest-secret-not-for-production"
os.environ["FRONTEND_BASE_URL"] = "http://localhost:5173"

LAT = float(os.environ.get("MOCK_DB_LATENCY_MS", "40")) / 1000.0
DATA = BACKEND / "data"
LOCS = json.loads((DATA / "locations.json").read_text(encoding="utf-8"))
EVENTS = json.loads((DATA / "events.json").read_text(encoding="utf-8"))
SEGS = json.loads((DATA / "road_segments.json").read_text(encoding="utf-8"))

import auth  # noqa: E402
import data_access as da  # noqa: E402
import db  # noqa: E402


def _slow(value):
    def fn(*_a, **_k):
        time.sleep(LAT)
        return value() if callable(value) else value
    return fn


def _aslow(fn):
    async def inner(*a, **k):
        await asyncio.sleep(LAT)
        return fn(*a, **k)
    return inner


class _Q:
    def __init__(self, rows):
        self.rows = rows

    def select(self, *_a, **_k): return self
    def eq(self, *_a, **_k): return self
    def limit(self, *_a, **_k): return self
    def update(self, *_a, **_k): return self

    def execute(self):
        time.sleep(LAT)
        return type("R", (), {"data": self.rows})()


class _FakeClient:
    def table(self, name):
        return _Q([{"id": "admin-1", "disabled": False}] if name == "admins" else [{"id": "x"}])


def _find(items, key, value):
    return next((i for i in items if i.get(key) == value), None)


da.get_locations = _slow(lambda: LOCS)
da.search_locations = lambda q: (time.sleep(LAT), [loc for loc in LOCS if q.lower() in json.dumps(loc).lower()][:8])[1]
da.list_public_events = lambda fest=None, date=None: (time.sleep(LAT), EVENTS)[1]
da.get_road_segments = _slow(lambda: SEGS)
da.sync_road_segments_cache = lambda: None
da.venue_exists = lambda v: (time.sleep(LAT), _find(LOCS, "id", v) is not None)[1]
da.get_menu = lambda v, d=None: (time.sleep(LAT), None)[1]
da.event_exists = lambda e: _find(EVENTS, "id", e) is not None
da.get_location_async = _aslow(lambda i: _find(LOCS, "id", i))
da.get_event_async = _aslow(lambda i: _find(EVENTS, "id", i))
da.create_feedback = _slow({"id": "mock-feedback"})
da.record_analytics_events = lambda events, sid=None: (time.sleep(LAT), len(events))[1]
da.health_check = _slow(None)
da.list_all_events_admin = lambda **_k: (time.sleep(LAT), EVENTS)[1]
da.list_feedback_admin = lambda *_a, **_k: (time.sleep(LAT), [])[1]
da.list_audit_log = lambda *_a, **_k: (time.sleep(LAT), [])[1]
da.get_analytics_summary = lambda *_a, **_k: (time.sleep(LAT), {"days": 30, "totals": {}})[1]
db.get_client = lambda: _FakeClient()
auth.get_client = lambda: _FakeClient()

import uvicorn  # noqa: E402

import main  # noqa: E402

if __name__ == "__main__":
    token = auth.create_access_token("admin-1", "loadtest", "superadmin")
    print("\nLOCAL MOCK BACKEND - Supabase is simulated (%d ms per call). Nothing leaves this machine." % (LAT * 1000))
    print("ADMIN_TOKEN=" + token + "\n")
    uvicorn.run(main.app, host="127.0.0.1", port=int(os.environ.get("PORT", "8000")), log_level="warning")
