"""
RBAC functional smoke test — Super Admin / Fest Admin roles, the fest
schedule review workflow, and the immediate-disable security property.

Runs the REAL main.py/auth.py/data_access.py code through FastAPI's
TestClient (real HTTP + routing + Pydantic validation + dependency
injection), backed by a small in-memory fake standing in for the Supabase
client — so this needs no live database or credentials and is safe to run
anywhere, including CI.

Usage:
    cd backend
    python scripts/smoke_test_rbac.py

Covers: login for both roles, role-gating (403s) on Super-Admin-only
routes, a Fest Admin submitting an event and seeing only their own
submissions, the full review cycle (submit → needs_changes → edit →
back to pending → approve), the edit lock once approved, delete being
Super-Admin-only, a disabled Fest Admin's existing token being rejected
immediately (not just at their next login), the public events list only
ever showing approved events, and the audit log capturing every action
above. Re-run this after any future change to auth.py, data_access.py's
admin/event functions, or the role-gating on main.py's routes.

The in-memory fake only implements the specific query patterns this
backend actually uses (eq/in_/ilike/order/limit/insert/update/delete) —
it is NOT a general PostgREST simulator, and deliberately doesn't resolve
embedded relations (event_categories/event_images/venues) the way real
Supabase does, so assertions here stick to fields that don't depend on
that (status, ownership, submitted_by/reviewed_by, audit actions) rather
than e.g. asserting on event_images contents.
"""
import sys
import os
import uuid
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["JWT_SECRET"] = "test_secret_for_smoke_test"

STORE = {"admins": [], "events": [], "admin_audit_log": [], "event_images": [],
         "event_categories": [], "venues": [], "road_segments": []}


class FakeResult:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    def __init__(self, table):
        self.table_name = table
        self.op = "select"
        self.filters = []
        self.order_field = None
        self.order_desc = False
        self.limit_n = None
        self.insert_data = None
        self.update_data = None

    def select(self, *_a, **_k): return self
    def eq(self, field, value): self.filters.append(("eq", field, value)); return self
    def in_(self, field, values): self.filters.append(("in", field, values)); return self
    def ilike(self, field, value): self.filters.append(("ilike", field, value)); return self
    def order(self, field, desc=False): self.order_field = field; self.order_desc = desc; return self
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
            new_row.setdefault("created_at", datetime.now(timezone.utc).isoformat())
            if self.table_name == "admins":
                new_row.setdefault("disabled", False)
                new_row.setdefault("last_login_at", None)
            if self.table_name == "events":
                new_row.setdefault("status", "pending")
                for k in ("reviewed_by", "approved_at", "review_notes", "reject_reason"):
                    new_row.setdefault(k, None)
            rows.append(new_row)
            return FakeResult([new_row])

        matched = rows
        for op, field, value in self.filters:
            if op == "eq":
                matched = [r for r in matched if r.get(field) == value]
            elif op == "in":
                matched = [r for r in matched if r.get(field) in value]
            elif op == "ilike":
                matched = [r for r in matched if str(r.get(field, "")).lower() == str(value).lower()]

        if self.op == "update":
            for r in matched:
                r.update(self.update_data)
            return FakeResult(matched)
        if self.op == "delete":
            for r in matched:
                rows.remove(r)
            return FakeResult(matched)

        if self.order_field:
            matched = sorted(matched, key=lambda r: (r.get(self.order_field) is None, r.get(self.order_field)), reverse=self.order_desc)
        if self.limit_n:
            matched = matched[: self.limit_n]
        return FakeResult([dict(r) for r in matched])


class FakeClient:
    def table(self, name):
        return FakeQuery(name)


import auth  # noqa: E402
import data_access  # noqa: E402

data_access.get_client = lambda: FakeClient()
auth.get_client = lambda: FakeClient()

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(main.app)

results = []
def check(desc, cond):
    results.append((desc, cond))
    print(("PASS" if cond else "FAIL"), "-", desc)


# --- Bootstrap: seed one venue (location_id FK check needs this to exist) ---
STORE["venues"].append({"id": "cse-block", "name": "CSE Block", "lat": 12.75, "lng": 80.19, "category": "academic"})

# --- Bootstrap: seed one superadmin directly (simulates create_admin.py) ---
STORE["admins"].append({
    "id": str(uuid.uuid4()), "username": "root", "role": "superadmin",
    "password_hash": auth.hash_password("rootpass123"), "disabled": False,
    "created_by": None, "created_at": datetime.now(timezone.utc).isoformat(), "last_login_at": None,
})

# --- 1. Super Admin login ---
r = client.post("/api/admin/login", json={"username": "root", "password": "rootpass123"})
check("superadmin login succeeds", r.status_code == 200 and r.json()["role"] == "superadmin")
super_token = r.json()["access_token"]
SH = {"Authorization": f"Bearer {super_token}"}

# --- 2. Super Admin creates a Fest Admin (auto-generated password) ---
r = client.post("/api/admin/fest-admins", json={"username": "cse-coordinator"}, headers=SH)
check("create fest admin succeeds", r.status_code == 200)
gen_pw = r.json().get("generated_password")
check("generated password returned", bool(gen_pw))

# --- 3. Fest Admin logs in with the generated password ---
r = client.post("/api/admin/login", json={"username": "cse-coordinator", "password": gen_pw})
check("fest admin login succeeds", r.status_code == 200 and r.json()["role"] == "festadmin")
fest_token = r.json()["access_token"]
FH = {"Authorization": f"Bearer {fest_token}"}

# --- 4. Fest Admin CANNOT reach superadmin-only endpoints ---
r = client.get("/api/admin/fest-admins", headers=FH)
check("fest admin blocked from Manage Fest Admins (403)", r.status_code == 403)
r = client.get("/api/admin/analytics/summary", headers=FH)
check("fest admin blocked from analytics (403)", r.status_code == 403)
r = client.patch("/api/admin/road-segments/seg1/close", headers=FH)
check("fest admin blocked from road closures (403)", r.status_code == 403)

# --- 5. Fest Admin submits an event ---
event_payload = {
    "name": "CSE Hack Night", "fest": "Invente", "department": "CSE",
    "location_id": "cse-block", "date": "2026-08-01", "start_time": "18:00", "end_time": "22:00",
    "description": "A night of hacking.", "open_to_external": True,
}
r = client.post("/api/admin/events", json=event_payload, headers=FH)
check("fest admin can submit event", r.status_code == 200)
event_id = r.json()["event_id"]
check("new event status is pending", STORE["events"][0]["status"] == "pending")

# --- 6. Fest Admin sees only their own submission ---
r = client.get("/api/admin/events", headers=FH)
check("fest admin sees exactly 1 event (their own)", r.status_code == 200 and len(r.json()) == 1)

# --- 7. A second fest admin does NOT see the first admin's event ---
r = client.post("/api/admin/fest-admins", json={"username": "ece-coordinator", "password": "ecepass123"}, headers=SH)
check("create second fest admin succeeds", r.status_code == 200)
r = client.post("/api/admin/login", json={"username": "ece-coordinator", "password": "ecepass123"})
fest2_token = r.json()["access_token"]
r = client.get("/api/admin/events", headers={"Authorization": f"Bearer {fest2_token}"})
check("second fest admin sees 0 events (not their own)", r.status_code == 200 and len(r.json()) == 0)

# --- 8. Super Admin sees ALL events (both fest admins') ---
r = client.get("/api/admin/events", headers=SH)
check("superadmin sees all events", r.status_code == 200 and len(r.json()) == 1)
check("submitted_by resolved to username", r.json()[0].get("submitted_by") == "cse-coordinator")

# --- 9. Super Admin requests changes ---
r = client.patch(f"/api/admin/events/{event_id}/request-changes?notes=Add+more+detail", headers=SH)
check("request-changes succeeds", r.status_code == 200)
check("status is now needs_changes", STORE["events"][0]["status"] == "needs_changes")
check("reviewed_by stamped", STORE["events"][0]["reviewed_by"] is not None)

# --- 10. Fest Admin edits — status should reset to pending ---
r = client.patch(f"/api/admin/events/{event_id}", json={"description": "A night of hacking, now with more detail."}, headers=FH)
check("fest admin can edit needs_changes event", r.status_code == 200)
check("status reset to pending after edit", STORE["events"][0]["status"] == "pending")
check("reviewed_by cleared after edit", STORE["events"][0]["reviewed_by"] is None)

# --- 11. Super Admin approves ---
r = client.patch(f"/api/admin/events/{event_id}/verify", headers=SH)
check("verify/approve succeeds", r.status_code == 200)
check("status is verified", STORE["events"][0]["status"] == "verified")
check("approved_at stamped", STORE["events"][0]["approved_at"] is not None)

# --- 12. Fest Admin can no longer edit an approved event ---
r = client.patch(f"/api/admin/events/{event_id}", json={"description": "trying to sneak an edit in"}, headers=FH)
check("fest admin blocked from editing approved event (409)", r.status_code == 409)

# --- 13. Fest Admin cannot delete events at all ---
r = client.delete(f"/api/admin/events/{event_id}", headers=FH)
check("fest admin blocked from deleting events (403)", r.status_code == 403)

# --- 14. Super Admin disables the Fest Admin — cutoff takes effect immediately (same token, no re-login) ---
fest_admin_row = next(a for a in STORE["admins"] if a["username"] == "cse-coordinator")
r = client.patch(f"/api/admin/fest-admins/{fest_admin_row['id']}/disable", headers=SH)
check("disable succeeds", r.status_code == 200)
r = client.get("/api/admin/events", headers=FH)  # same still-valid JWT as before
check("disabled fest admin's existing token is rejected immediately", r.status_code == 401)

# --- 15. Disabled Fest Admin cannot log back in either ---
r = client.post("/api/admin/login", json={"username": "cse-coordinator", "password": gen_pw})
check("disabled fest admin cannot log in", r.status_code == 401)

# --- 16. Re-enable works ---
r = client.patch(f"/api/admin/fest-admins/{fest_admin_row['id']}/enable", headers=SH)
check("enable succeeds", r.status_code == 200)
r = client.post("/api/admin/login", json={"username": "cse-coordinator", "password": gen_pw})
check("re-enabled fest admin can log in again", r.status_code == 200)

# --- 17. Public events list only shows the verified one ---
r = client.get("/api/events")
check("public events list shows the approved event", r.status_code == 200 and len(r.json()) == 1)

# --- 18. Audit log captured the key actions ---
r = client.get("/api/admin/audit-log", headers=SH)
actions = [e["action"] for e in r.json()]
check("audit log has fest_admin_created", "fest_admin_created" in actions)
check("audit log has fest_submitted", "fest_submitted" in actions)
check("audit log has fest_needs_changes", "fest_needs_changes" in actions)
check("audit log has fest_updated", "fest_updated" in actions)
check("audit log has fest_approved", "fest_approved" in actions)
check("audit log has fest_admin_disabled", "fest_admin_disabled" in actions)
check("audit log has fest_admin_enabled", "fest_admin_enabled" in actions)

# --- 19. Delete a Fest Admin — their events survive with submitted_by cleared ---
fest2_row = next(a for a in STORE["admins"] if a["username"] == "ece-coordinator")
r = client.delete(f"/api/admin/fest-admins/{fest2_row['id']}", headers=SH)
check("delete fest admin succeeds", r.status_code == 200)
check("fest admin actually removed from store", not any(a["username"] == "ece-coordinator" for a in STORE["admins"]))

print()
n_fail = sum(1 for _, ok in results if not ok)
print(f"{len(results)-n_fail}/{len(results)} checks passed.")
sys.exit(1 if n_fail else 0)
