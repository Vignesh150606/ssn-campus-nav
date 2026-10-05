"""
loadtest/verify_protection.py - offline checks for backend/protection.py + backend/health.py.

No network, no Supabase: data_access / db are monkeypatched. Run from the repo root:

    cd backend
    pip install pytest
    python -m pytest ../loadtest/verify_protection.py -q
"""
import asyncio
import gzip
import json
import os
import sys
import threading
import time
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND))
os.chdir(BACKEND)

# These offline harnesses must not load the real backend .env.
import dotenv  # noqa: E402
dotenv.load_dotenv = lambda *_args, **_kwargs: False
os.environ["SNAPSHOT_ENABLED"] = "false"
os.environ["SNAPSHOT_PUBLISH_ON_STARTUP"] = "false"
os.environ["SUPABASE_URL"] = "https://example.invalid"
os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "test"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["FRONTEND_BASE_URL"] = "http://localhost:5173"

from fastapi.testclient import TestClient  # noqa: E402

import data_access  # noqa: E402
import health  # noqa: E402
import main  # noqa: E402
import protection  # noqa: E402
from db import SupabaseUnavailableError  # noqa: E402

LOCS = json.load(open(BACKEND / "data" / "locations.json", encoding="utf-8"))
ORIGIN = {"Origin": "http://localhost:5173"}
_ip = iter(range(1, 10_000))


def fresh_ip():
    return {"X-Forwarded-For": f"10.9.{next(_ip) // 250}.{next(_ip) % 250}"}


@pytest.fixture(scope="module")
def client():
    data_access.sync_road_segments_cache = lambda: None  # no Supabase at startup
    with TestClient(main.app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    protection.invalidate("")
    protection._LOC.update(data=None, exp=0.0, task=None)
    if protection._C_CACHE is not None:
        protection._C_CACHE._d.clear()
    monkeypatch.delenv("COPILOT_DISABLED", raising=False)
    yield


# ------------------------------------------------------------------ cache / gzip / etag
def test_graph_gzip_once_etag_304(client):
    r = client.get("/api/graph", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert r.headers["content-encoding"] == "gzip"          # single encoding, not double-gzipped
    assert "nodes" in r.json()
    etag = r.headers["etag"]
    assert "max-age=600" in r.headers["cache-control"]
    r2 = client.get("/api/graph", headers={"If-None-Match": etag})
    assert r2.status_code == 304 and r2.content == b""
    raw = client.get("/api/graph", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in raw.headers and raw.num_bytes_downloaded > r.num_bytes_downloaded * 3


def test_locations_one_read_per_ttl_even_concurrent(client, monkeypatch):
    calls = []

    def fake(category=None):
        calls.append(category)
        time.sleep(0.05)
        return LOCS

    monkeypatch.setattr(data_access, "get_locations", fake)
    threads = [threading.Thread(target=lambda: client.get("/api/locations")) for _ in range(20)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    for _ in range(30):
        assert client.get("/api/locations").status_code == 200
    assert len(calls) == 1
    assert "max-age=300" in client.get("/api/locations").headers["cache-control"]


def test_stale_if_error_and_no_cache_failure(client, monkeypatch):
    monkeypatch.setattr(data_access, "get_road_segments", lambda: [{"id": "a", "closed": False}])
    assert client.get("/api/road-segments").json()[0]["id"] == "a"
    protection._CACHE["road-segments"].fresh_until = 0           # expire it
    def boom():
        raise SupabaseUnavailableError("down")
    monkeypatch.setattr(data_access, "get_road_segments", boom)
    r = client.get("/api/road-segments")
    assert r.status_code == 200 and r.headers["x-cache"] == "STALE"
    protection.invalidate("")
    assert client.get("/api/road-segments").status_code == 503   # nothing stale -> existing 503 handler


def test_404_is_not_cached(client, monkeypatch):
    n = []
    monkeypatch.setattr(data_access, "venue_exists", lambda v: n.append(v) or False)
    assert client.get("/api/locations/zzz/menu").status_code == 404
    assert client.get("/api/locations/zzz/menu").status_code == 404
    assert len(n) == 2


def test_search_key_is_normalized(client, monkeypatch):
    n = []
    monkeypatch.setattr(data_access, "search_locations", lambda q: n.append(q) or [{"id": "x"}])
    client.get("/api/locations/search?q=Library")
    client.get("/api/locations/search?q=%20library%20")
    assert len(n) == 1
    assert client.get("/api/locations/search?q=" + "a" * 81).status_code == 422


# ------------------------------------------------------------------ body limit
def test_body_limit_413_has_cors(client):
    big = json.dumps({"x": "a" * 70_000})
    r = client.post("/api/feedback", content=big, headers={**ORIGIN, **fresh_ip(), "Content-Type": "application/json"})
    assert r.status_code == 413
    assert r.headers.get("access-control-allow-origin") == "http://localhost:5173"


def test_body_limit_chunked_and_upload_path(client):
    def gen():
        for _ in range(100):
            yield b"a" * 1024
    r = client.post("/api/feedback", content=gen(), headers={**fresh_ip(), "Content-Type": "application/json"})
    assert r.status_code == 413                                  # no Content-Length, counted while streaming
    r = client.post("/api/admin/events/e1/images", content=b"x" * 1000,
                    headers={**fresh_ip(), "Content-Length": str(7 * 1024 * 1024)})
    assert r.status_code == 413                                  # over the 6 MB upload cap
    r = client.post("/api/admin/events/e1/images", content=b"x" * 100_000)
    assert r.status_code in (401, 403, 422)                      # above 64 KB but allowed on upload paths


# ------------------------------------------------------------------ rate limiting
def test_feedback_limiter_429_typed_and_per_ip(client, monkeypatch):
    monkeypatch.setattr(data_access, "create_feedback", lambda p: {"id": "f1"})
    body = {"route_quality": "good"}
    ip = fresh_ip()
    codes = [client.post("/api/feedback", json=body, headers={**ip, **ORIGIN}).status_code for _ in range(23)]
    assert codes.count(429) >= 2 and codes[0] != 429
    r = client.post("/api/feedback", json=body, headers={**ip, **ORIGIN})
    assert r.status_code == 429 and r.json()["error"] == "rate_limited" and int(r.headers["retry-after"]) >= 1
    assert isinstance(r.json()["detail"], str)
    assert r.headers.get("access-control-allow-origin")          # CORS survives the 429
    other = client.post("/api/feedback", json=body, headers=fresh_ip())
    assert other.status_code != 429                              # different IP unaffected


def test_login_behaviour_kept_and_limited(client, monkeypatch):
    from fastapi import HTTPException
    def deny(u, p):
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    monkeypatch.setattr(main, "authenticate_admin", deny)
    ip = fresh_ip()
    codes = [client.post("/api/admin/login", json={"username": "a", "password": "b"}, headers=ip).status_code
             for _ in range(7)]
    assert codes[:5] == [401] * 5 and 429 in codes[5:]            # per-username lockout logic untouched; IP bucket on top
    assert client.post("/api/admin/login", json={"username": "a", "password": "b"}, headers=ip).headers["cache-control"] == "no-store"


# ------------------------------------------------------------------ Copilot
def _copilot(client, msg, ip=None, **kw):
    return client.post("/api/copilot/chat", json={"message": msg, "context": {"hasPending": False}},
                       headers=ip or fresh_ip(), **kw)


def test_copilot_cache_normalization_and_query_text(client, monkeypatch):
    monkeypatch.setattr(data_access, "get_locations", lambda: LOCS)
    spy = []
    real = main._copilot.classify
    monkeypatch.setattr(main._copilot, "classify", lambda m, l, c=None: spy.append(m) or real(m, l, c))
    a = _copilot(client, "where is the library").json()
    b = _copilot(client, "  Where is the LIBRARY?? ").json()
    assert len(spy) == 1 and a["intent"] == b["intent"]
    assert b["query_text"] == "  Where is the LIBRARY?? "                 # echoes the caller's text, not the cached one


def test_copilot_locations_cached_and_baked_fallback(client, monkeypatch):
    n = []
    monkeypatch.setattr(data_access, "get_locations", lambda: n.append(1) or LOCS)
    for q in ("library", "canteen", "mechanical department", "eee 302"):
        assert _copilot(client, q).status_code == 200
    assert len(n) == 1                                            # was: one Supabase read per message
    protection._LOC.update(data=None, exp=0.0, task=None)
    def boom():
        raise SupabaseUnavailableError("down")
    monkeypatch.setattr(data_access, "get_locations", boom)
    assert _copilot(client, "hostel").status_code == 200          # served from data/locations.json


def test_copilot_long_message_is_truncated(client, monkeypatch):
    monkeypatch.setattr(data_access, "get_locations", lambda: LOCS)
    seen = []
    real = main._copilot.classify
    monkeypatch.setattr(main._copilot, "classify", lambda m, l, c=None: seen.append(len(m)) or real(m, l, c))
    t = time.perf_counter()
    assert _copilot(client, "library " * 3000).status_code == 200
    assert seen == [300] and time.perf_counter() - t < 1.0


def test_copilot_timeout_returns_typed_busy(client, monkeypatch):
    monkeypatch.setattr(data_access, "get_locations", lambda: LOCS)
    monkeypatch.setenv("COPILOT_TIMEOUT_S", "0.3")
    monkeypatch.setattr(main._copilot, "classify", lambda m, l, c=None: time.sleep(1.0) or {"intent": "x", "raw": m})
    r = _copilot(client, "slow question one", ip=fresh_ip())
    assert r.status_code == 503 and r.json()["error"] == "busy" and r.json()["retry_after"] >= 1
    assert isinstance(r.json()["detail"], str)
    time.sleep(1.2)                                               # let the worker thread finish before the next test


def test_copilot_concurrency_cap_sheds_load(client, monkeypatch):
    monkeypatch.setattr(data_access, "get_locations", lambda: LOCS)
    monkeypatch.setenv("COPILOT_QUEUE_WAIT_S", "0.2")
    monkeypatch.setenv("COPILOT_TIMEOUT_S", "3")
    monkeypatch.setattr(main._copilot, "classify", lambda m, l, c=None: time.sleep(0.6) or {"intent": "x", "raw": m})
    out = []
    def go(i):
        out.append(_copilot(client, f"distinct question number {i}", ip=fresh_ip()).status_code)
    ts = [threading.Thread(target=go, args=(i,)) for i in range(8)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert out.count(200) >= 2 and out.count(503) >= 1 and set(out) <= {200, 503}
    time.sleep(1.5)


def test_copilot_does_not_block_other_endpoints(client, monkeypatch):
    monkeypatch.setattr(data_access, "get_locations", lambda: LOCS)
    monkeypatch.setattr(main._copilot, "classify", lambda m, l, c=None: time.sleep(0.8) or {"intent": "x", "raw": m})
    t = threading.Thread(target=lambda: _copilot(client, "block the workers please", ip=fresh_ip()))
    t.start()
    time.sleep(0.15)
    t0 = time.perf_counter()
    assert client.get("/healthz").status_code == 200
    assert time.perf_counter() - t0 < 0.3
    t.join()


def test_copilot_kill_switch(client, monkeypatch):
    monkeypatch.setenv("COPILOT_DISABLED", "1")
    r = _copilot(client, "anything")
    assert r.status_code == 503 and r.json()["error"] == "disabled"


# ------------------------------------------------------------------ health
def test_healthz_and_db(client, monkeypatch):
    r = client.get("/healthz")
    assert r.status_code == 200 and r.json()["status"] == "ok" and r.headers["cache-control"] == "no-store"
    calls = []
    class T:
        def select(self, *_): return self
        def limit(self, *_): return self
        def execute(self): calls.append(1); return None
    class C:
        def table(self, _): return T()
    import db
    monkeypatch.setattr(db, "get_client", lambda: C())
    health._db_state.update(ok=None, at=0.0, task=None)
    for _ in range(5):
        assert client.get("/healthz/db").status_code == 200
        assert client.get("/api/health").status_code == 200
    assert len(calls) == 1                                        # cached ~30 s, shared with /api/health
    health._db_state.update(ok=None, at=0.0, task=None)
    monkeypatch.setattr(db, "get_client", lambda: (_ for _ in ()).throw(RuntimeError("paused")))
    r = client.get("/healthz/db")
    assert r.status_code == 503 and r.json()["db"] == "unreachable" and "paused" not in r.text


def test_healthz_ip_and_stats(client):
    r = client.get("/healthz/ip", headers={"X-Forwarded-For": "1.1.1.1, 2.2.2.2", "CF-Connecting-IP": "3.3.3.3"})
    assert r.json()["chosen"] == "3.3.3.3"
    assert "counters" in client.get("/healthz/stats").json()


def test_public_routes_keep_working(client, monkeypatch):
    monkeypatch.setattr(data_access, "get_location_async", lambda i: _aret({"id": i, "name": "n", "lat": 1, "lng": 2}))
    r = client.get("/api/locations/library")
    assert r.status_code == 200 and "max-age=300" in r.headers["cache-control"]
    assert client.get("/").status_code == 200


async def _aret(v):
    return v
