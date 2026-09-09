"""
Focused test for the Sept 2026 concurrency fix (async /api/events/{id} +
/api/route reads, in-memory TTL caching with write-path invalidation).

Runs the REAL main.py/data_access.py/db.py code, with data_access's sync
AND async Supabase entry points (get_client / get_async_client) replaced
by small in-memory fakes — same pattern as scripts/smoke_test_rbac.py, so
this needs no live database or credentials. utils/router.py's Dijkstra
graph is NOT faked — it reads the real backend/data/walkway_graph.json
off disk, same as production, so the /api/route smoke check below uses
real location ids that exist in that graph's location_edges.

Usage:
    cd backend
    python scripts/test_concurrency_fix.py

Covers: cache hit vs miss (only a miss hits the fake Supabase layer),
cache invalidation on event update (a stale value is never served past
the write, regardless of TTL), TTL expiry as a backstop, and correctness
under concurrent access to a cold cache (many simultaneous requests for
the same not-yet-cached id all get the right value — a "cache stampede"
of redundant fetches on that first access is a known, accepted trade-off,
not a correctness bug; see test 6 below).
"""
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["JWT_SECRET"] = "test_secret_for_concurrency_fix_test"

STORE = {"venues": [], "events": [], "event_images": [], "event_categories": []}


class FakeResult:
    def __init__(self, data):
        self.data = data


# --- Sync fake (admin/write paths — verify/reject/update/delete_event etc.) ---
class FakeQuery:
    def __init__(self, table):
        self.table_name = table
        self.op = "select"
        self.filters = []
        self.limit_n = None
        self.insert_data = None
        self.update_data = None

    def select(self, *_a, **_k): return self
    def eq(self, field, value): self.filters.append((field, value)); return self
    def limit(self, n): self.limit_n = n; return self

    def insert(self, data):
        self.op = "insert"; self.insert_data = data; return self

    def update(self, data):
        self.op = "update"; self.update_data = data; return self

    def delete(self):
        self.op = "delete"; return self

    def execute(self):
        rows = STORE[self.table_name]
        if self.op == "insert":
            new_row = dict(self.insert_data)
            new_row.setdefault("id", str(uuid.uuid4()))
            rows.append(new_row)
            return FakeResult([new_row])

        matched = rows
        for field, value in self.filters:
            matched = [r for r in matched if r.get(field) == value]

        if self.op == "update":
            for r in matched:
                r.update(self.update_data)
            return FakeResult(matched)
        if self.op == "delete":
            for r in matched:
                rows.remove(r)
            return FakeResult(matched)

        if self.limit_n:
            matched = matched[: self.limit_n]
        return FakeResult([dict(r) for r in matched])


class FakeClient:
    def table(self, name):
        return FakeQuery(name)


# --- Async fake (the new read paths — get_location_async / get_event_async) ---
ASYNC_CALL_COUNTS = {"venues": 0, "events": 0}


class FakeAsyncQuery:
    def __init__(self, table):
        self.table_name = table
        self.filters = []
        self.limit_n = None

    def select(self, *_a, **_k): return self
    def eq(self, field, value): self.filters.append((field, value)); return self
    def limit(self, n): self.limit_n = n; return self

    async def execute(self):
        ASYNC_CALL_COUNTS[self.table_name] = ASYNC_CALL_COUNTS.get(self.table_name, 0) + 1
        rows = STORE[self.table_name]
        matched = rows
        for field, value in self.filters:
            matched = [r for r in matched if r.get(field) == value]
        if self.limit_n:
            matched = matched[: self.limit_n]
        return FakeResult([dict(r) for r in matched])


class FakeAsyncClient:
    def table(self, name):
        return FakeAsyncQuery(name)


async def _fake_get_async_client():
    return FakeAsyncClient()


import data_access  # noqa: E402

data_access.get_client = lambda: FakeClient()
data_access.get_async_client = _fake_get_async_client

results = []
def check(desc, cond):
    results.append((desc, cond))
    print(("PASS" if cond else "FAIL"), "-", desc)


# --- Fixtures: one venue matching a real walkway_graph.json location id,
# one event pointing at it (mirrors the real events/venues shape closely
# enough for _serialize_event; embedded relations like event_images stay
# empty, same simplification scripts/smoke_test_rbac.py already makes) ---
STORE["venues"].append({
    "id": "cse-block", "name": "CSE Block", "category": "academic",
    "department": "CSE", "lat": 12.75, "lng": 80.19,
    "floors": None, "accessible": True, "description": "", "facilities": None,
})
EVENT_ID = "test-event-" + uuid.uuid4().hex[:8]
STORE["events"].append({
    "id": EVENT_ID, "name": "Original Name", "fest": "Invente", "department": "CSE",
    "location_id": "cse-block", "date": "2026-09-12", "start_time": "10:00", "end_time": "17:00",
    "status": "verified", "created_by": "admin-1", "reviewed_by": None,
    "approved_at": None, "review_notes": None, "reject_reason": None,
    "created_at": datetime.now(timezone.utc).isoformat(), "updated_at": datetime.now(timezone.utc).isoformat(),
})


async def main():
    # 1. Cold cache -> miss, correct value, one fake Supabase call.
    data_access._EVENT_CACHE.invalidate(EVENT_ID)
    ASYNC_CALL_COUNTS["events"] = 0
    ev = await data_access.get_event_async(EVENT_ID)
    check("get_event_async cold-cache returns correct name", ev is not None and ev["name"] == "Original Name")
    check("get_event_async cold-cache is a cache miss (1 Supabase call)", ASYNC_CALL_COUNTS["events"] == 1)

    # 2. Warm cache -> hit, no additional Supabase call.
    ev2 = await data_access.get_event_async(EVENT_ID)
    check("get_event_async warm-cache still correct", ev2["name"] == "Original Name")
    check("get_event_async warm-cache is a cache hit (still 1 Supabase call)", ASYNC_CALL_COUNTS["events"] == 1)

    # 3. Admin update -> must invalidate, not just wait out the TTL.
    result = data_access.update_event(EVENT_ID, {"name": "Renamed Event"}, "admin-1", "superadmin")
    check("update_event succeeds", result == "ok")
    ev3 = await data_access.get_event_async(EVENT_ID)
    check("get_event_async reflects update immediately (invalidation, not TTL wait)", ev3["name"] == "Renamed Event")
    check("...and it was a real re-fetch, not a stale hit (2 Supabase calls total)", ASYNC_CALL_COUNTS["events"] == 2)

    # 4. Delete -> subsequent read is None, cache doesn't resurrect it.
    data_access.delete_event(EVENT_ID)
    ev4 = await data_access.get_event_async(EVENT_ID)
    check("get_event_async returns None after delete_event", ev4 is None)

    # 5. Venue cache: same hit/miss behaviour on the read-only path.
    ASYNC_CALL_COUNTS["venues"] = 0
    loc1 = await data_access.get_location_async("cse-block")
    loc2 = await data_access.get_location_async("cse-block")
    check("get_location_async returns correct venue", loc1 is not None and loc1["name"] == "CSE Block")
    check("get_location_async caches across calls (1 Supabase call for 2 reads)", ASYNC_CALL_COUNTS["venues"] == 1)

    # 6. TTL expiry backstop, tested directly against _TTLCache (not the
    # full 30s production TTL — would make this test slow for no reason).
    from data_access import _TTLCache
    tiny_cache = _TTLCache(ttl_seconds=0.05, max_entries=10)
    tiny_cache.set("k", "v")
    _, hit_immediately = tiny_cache.get("k")
    await asyncio.sleep(0.1)
    _, hit_after_ttl = tiny_cache.get("k")
    check("_TTLCache serves a fresh entry", hit_immediately is True)
    check("_TTLCache expires an entry past its TTL", hit_after_ttl is False)

    # 7. Concurrency + request coalescing: many simultaneous requests for
    # the same COLD key (the "everyone scans the QR poster at once"
    # scenario) all resolve to the correct value AND only trigger ONE
    # real Supabase call between them — the singleflight coalescing in
    # get_location_async/get_event_async (_VENUE_FETCH_INFLIGHT /
    # _EVENT_FETCH_INFLIGHT) means concurrent misses share the one
    # in-flight fetch instead of each firing their own.
    STORE["venues"].append({
        "id": "main-gate", "name": "Main Gate / Entrance", "category": "gate",
        "department": None, "lat": 12.75137, "lng": 80.204085,
        "floors": None, "accessible": True, "description": "", "facilities": None,
    })
    data_access._VENUE_CACHE.invalidate("main-gate")
    ASYNC_CALL_COUNTS["venues"] = 0
    concurrent_results = await asyncio.gather(*[data_access.get_location_async("main-gate") for _ in range(25)])
    check(
        "25 concurrent get_location_async calls on a cold key all return the correct venue",
        all(r is not None and r["name"] == "Main Gate / Entrance" for r in concurrent_results),
    )
    check(
        "...and only 1 real Supabase call was made for all 25 (coalesced, not a stampede)",
        ASYNC_CALL_COUNTS["venues"] == 1,
    )

    # Same coalescing check on the event path — this is the hotter of the
    # two in a real event (many visitors, one shared event_id).
    STORE["events"].append({
        "id": "coalesce-event", "name": "Coalesce Test Event", "fest": "Invente", "department": "CSE",
        "location_id": "cse-block", "date": "2026-09-12", "start_time": "10:00", "end_time": "17:00",
        "status": "verified", "created_by": "admin-1", "reviewed_by": None,
        "approved_at": None, "review_notes": None, "reject_reason": None,
        "created_at": datetime.now(timezone.utc).isoformat(), "updated_at": datetime.now(timezone.utc).isoformat(),
    })
    ASYNC_CALL_COUNTS["events"] = 0
    concurrent_event_results = await asyncio.gather(*[data_access.get_event_async("coalesce-event") for _ in range(25)])
    check(
        "25 concurrent get_event_async calls on a cold key all return the correct event",
        all(r is not None and r["name"] == "Coalesce Test Event" for r in concurrent_event_results),
    )
    check(
        "...and only 1 real Supabase call was made for all 25 (coalesced, not a stampede)",
        ASYNC_CALL_COUNTS["events"] == 1,
    )

    # 8. Endpoint-level smoke test (TestClient drives the real async route
    # handlers end-to-end, including FastAPI's request/response cycle).
    from fastapi.testclient import TestClient
    import main as main_module
    client = TestClient(main_module.app)

    r = client.get("/api/graph")
    check("/api/graph 200", r.status_code == 200 and "nodes" in r.json())

    STORE["events"].append({
        "id": "smoke-event", "name": "Smoke Event", "fest": "Invente", "department": "CSE",
        "location_id": "cse-block", "date": "2026-09-12", "start_time": "10:00", "end_time": "17:00",
        "status": "verified", "created_by": "admin-1", "reviewed_by": None,
        "approved_at": None, "review_notes": None, "reject_reason": None,
        "created_at": datetime.now(timezone.utc).isoformat(), "updated_at": datetime.now(timezone.utc).isoformat(),
    })
    r = client.get("/api/events/smoke-event")
    check("/api/events/{id} 200 via TestClient (async handler)", r.status_code == 200 and r.json()["name"] == "Smoke Event")

    r = client.get("/api/events/does-not-exist")
    check("/api/events/{id} 404 for unknown id preserved", r.status_code == 404)

    # main-gate -> cse-block: both real walkway_graph.json location ids,
    # so utils/router.py's untouched Dijkstra can actually route between them.
    r = client.get("/api/route", params={"from_id": "main-gate", "to_id": "cse-block"})
    check("/api/route 200 via TestClient (async handler)", r.status_code == 200 and "distance_m" in r.json())

    r = client.get("/api/route", params={"to_id": "does-not-exist"})
    check("/api/route 404 for unknown to_id preserved", r.status_code == 404)

    print()
    passed = sum(1 for _, c in results if c)
    print(f"{passed}/{len(results)} checks passed")
    if passed != len(results):
        sys.exit(1)


asyncio.run(main())
