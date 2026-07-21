"""
SSN Campus Navigator - Backend API (Phase 3 — Supabase production backend)

Run locally:
    pip install -r requirements.txt --break-system-packages
    cp .env.example .env   # fill in SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / JWT_SECRET
    uvicorn main:app --reload

Interactive API docs available at http://127.0.0.1:8000/docs

Phase 3 notes
-------------
Every endpoint below has the *same* path, method, and response shape it
had in Phase 2. What changed underneath is the data source: locations,
events, and road-segment open/closed state now live in Supabase Postgres
(+ Storage for uploaded event images) instead of local JSON files. All of
that lives in data_access.py / db.py / auth.py — see SUPABASE_MIGRATION.md
for the full write-up of what moved and, just as importantly, what
deliberately did NOT move (the walkway routing graph + Dijkstra in
utils/router.py, and the Campus Copilot NLU engine in utils/copilot.py
are both untouched).

Admin auth changed from a single shared `?secret=` query param to real
per-admin accounts (bcrypt password hash in the `admins` table + a JWT
issued by POST /api/admin/login). Every /api/admin/* route now requires
`Authorization: Bearer <token>` instead of `?secret=`.
"""

import os
import math
import logging
from typing import List, Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import data_access
from auth import authenticate_admin, create_access_token, get_current_active_admin, require_role, hash_password, generate_password
from db import SupabaseUnavailableError
from utils.qr_generator import generate_event_qr
from utils.router import find_route as _find_route, find_route_from_point as _find_route_from_point
from utils import copilot as _copilot

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ssn-campus-nav")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
STATIC_DIR = os.path.join(BASE_DIR, "static")

app = FastAPI(
    title="SSN Campus Navigator API",
    description="Backend for the Smart Campus Navigation System (SSN College of Engineering)",
    version="0.3.0",
)

# Allow the frontend (Vite dev server, or any device scanning a QR code) to call this API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(SupabaseUnavailableError)
def _supabase_unavailable_handler(request: Request, exc: SupabaseUnavailableError):
    """Database/storage unreachable OR a genuine query/table/bucket error —
    data_access._wrap() turns *any* exception from a Supabase call into
    this one type, so "Service Unavailable" was previously shown for
    everything from a real outage to a missing table/column, a bad query,
    or an unconfigured Storage bucket, with the real cause thrown away.
    That real cause (str(exc), set by _wrap) is exactly what's needed to
    tell those apart, so: always log it server-side, and include it in the
    response too — same as every other endpoint in this file already does
    with str(e) (see e.g. the admin image/menu routes below). A 503 is
    still the right status code (something the backend depends on isn't
    answering correctly right now), it just no longer hides why.
    """
    detail = str(exc) or "unknown error"
    logger.error("Supabase call failed on %s %s: %s", request.method, request.url.path, detail)
    return JSONResponse(
        status_code=503,
        content={"detail": f"Service temporarily unavailable: {detail}"},
    )


@app.on_event("startup")
def _on_startup():
    """Refresh the road-segments JSON mirror from Supabase at boot.

    utils/router.py is untouched and reads road_segments.json straight off
    disk for the closure-penalty logic in Dijkstra. Supabase is the real
    source of truth for open/closed state now, so we resync the mirror file
    here — this is what makes road closures survive a Render redeploy
    (which wipes local disk) without touching router.py at all.
    """
    data_access.sync_road_segments_cache()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def haversine_meters(lat1, lng1, lat2, lng2) -> float:
    """Great-circle distance between two points, in meters."""
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# ---------------------------------------------------------------------------
# Locations
# ---------------------------------------------------------------------------

@app.get("/api/locations")
def list_locations(category: Optional[str] = None):
    """List all campus locations, optionally filtered by category
    (academic, hostel, sports, dining, library, auditorium, admin, gate, parking, medical)."""
    return data_access.get_locations(category)


@app.get("/api/locations/search")
def search_locations(q: str = Query(..., min_length=1, description="Search text")):
    """Search locations by name, department or category (for the search bar / autocomplete)."""
    return data_access.search_locations(q)


@app.get("/api/locations/{location_id}")
def get_location(location_id: str):
    loc = data_access.get_location(location_id)
    if not loc:
        raise HTTPException(status_code=404, detail=f"Location '{location_id}' not found")
    return loc


# ---------------------------------------------------------------------------
# Events (fest schedule)
# ---------------------------------------------------------------------------

@app.get("/api/events")
def list_events(fest: Optional[str] = None, date: Optional[str] = None):
    """List fest events, each enriched with its venue's coordinates.
    Optionally filter by fest name (e.g. 'Invente') or date (YYYY-MM-DD).
    Only verified events are returned — same as Phase 2."""
    return data_access.list_public_events(fest=fest, date=date)


@app.get("/api/events/{event_id}")
def get_event(event_id: str):
    """Get full details for one event, including its venue location.
    This is the data that powers the page a fest visitor lands on after scanning a QR code."""
    event = data_access.get_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail=f"Event '{event_id}' not found")
    return event


@app.get("/api/events/{event_id}/qr")
def get_event_qr(event_id: str):
    """Return a PNG QR code that links directly to this event's page.
    Print this on posters/flyers so visitors from other colleges can scan -> open the
    app (PWA) -> see the event -> tap 'Get Directions'.

    QR PNGs are still generated on local disk and regenerated on demand if
    missing (e.g. after a redeploy) — they're deterministic from event_id,
    so this self-heals without needing Supabase Storage."""
    if not data_access.event_exists(event_id):
        raise HTTPException(status_code=404, detail=f"Event '{event_id}' not found")

    path = os.path.join(STATIC_DIR, "qr", f"{event_id}.png")
    if not os.path.exists(path):
        generate_event_qr(event_id)
    return FileResponse(path, media_type="image/png")


# ---------------------------------------------------------------------------
# Routing (Dijkstra over the walkway graph — untouched in this migration)
# ---------------------------------------------------------------------------

@app.get("/api/route")
def get_route(
    from_id: Optional[str] = Query(None, description="Starting location id, e.g. 'main-gate'. Omit if using from_lat/from_lng."),
    to_id: str = Query(..., description="Destination location id, e.g. 'eee-block'"),
    from_lat: Optional[float] = Query(None, description="Live GPS latitude — used instead of from_id for on-the-move rerouting."),
    from_lng: Optional[float] = Query(None, description="Live GPS longitude — used instead of from_id for on-the-move rerouting."),
    accuracy: Optional[float] = Query(None, description="Reported accuracy (metres) of from_lat/from_lng, if known. Used to sanity-check the nearest-node snap against a farther-but-cheaper-looking candidate — see utils/router.py _nearest_node."),
    prefer_node: Optional[str] = Query(None, description="The walkway node id the in-progress route was last snapped to (its own previous 'snapped_to'), if any. Used to avoid flipping between two comparably-costed branches on GPS noise alone — see utils/router.py _nearest_node."),
):
    """
    Walking route to a campus location.

    Two ways to specify the start:
    - from_id: a named location (e.g. the main gate) — original behaviour,
      used for the initial route from the standard campus entry point.
    - from_lat + from_lng: an arbitrary GPS coordinate, snapped to the
      nearest walkway node — used for automatic recalculation while a user
      is actively navigating and has drifted off the original route.
    """
    b = data_access.get_location(to_id)
    if not b:
        raise HTTPException(status_code=404, detail=f"Unknown to_id '{to_id}'")

    using_coords = from_lat is not None and from_lng is not None

    if not using_coords and not from_id:
        raise HTTPException(status_code=400, detail="Provide either from_id or both from_lat and from_lng")

    try:
        if using_coords:
            result = _find_route_from_point(from_lat, from_lng, to_id, accuracy_m=accuracy, prefer_node_id=prefer_node)
            from_payload = {"id": None, "name": "Current location", "lat": from_lat, "lng": from_lng}
        else:
            a = data_access.get_location(from_id)
            if not a:
                raise HTTPException(status_code=404, detail=f"Unknown from_id '{from_id}'")
            result = _find_route(from_id, to_id)
            from_payload = {"id": a["id"], "name": a["name"], "lat": a["lat"], "lng": a["lng"]}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "from": from_payload,
        "to":   {"id": b["id"], "name": b["name"], "lat": b["lat"], "lng": b["lng"]},
        "distance_m":  result["distance_m"],
        "eta_minutes": result["eta_minutes"],
        "path":        result["path"],
        "source":      result.get("source", "local"),
        "warning":     result.get("warning"),
        "snapped_to":  result.get("snapped_to"),
    }


# ---------------------------------------------------------------------------
# Static files (QR codes, campus image overlay for the map, etc.)
# ---------------------------------------------------------------------------

os.makedirs(os.path.join(STATIC_DIR, "qr"), exist_ok=True)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def root():
    return {
        "service": "SSN Campus Navigator API",
        "docs": "/docs",
        "endpoints": [
            "/api/locations",
            "/api/locations/search?q=",
            "/api/locations/{id}",
            "/api/events",
            "/api/events/{id}",
            "/api/events/{id}/qr",
            "/api/route?from_id=&to_id=",
            "/api/analytics/events",
            "/api/admin/analytics/summary",
            "/api/feedback",
            "/api/admin/feedback",
            "/api/admin/login",
            "/api/admin/events",
            "/api/admin/fest-admins",
            "/api/admin/audit-log",
            "/api/health",
        ],
    }


@app.get("/api/health")
def health():
    """Phase 4A.1 — polled by the frontend's startup screen to detect when
    the backend has finished waking up after a Render free-tier cold
    start. Confirms both that this process is up *and* that Supabase is
    actually reachable, since "the API responded" and "the API can serve
    real data" are different things on a cold start. Returns 200 only
    when both are true; the SupabaseUnavailableError handler above turns
    a DB hiccup into a clean 503 rather than a raw 500."""
    data_access.health_check()
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Admin — login + event management (add / verify / reject / delete / images)
# Protected by a JWT issued from POST /api/admin/login (see auth.py).
# ---------------------------------------------------------------------------

class AdminLoginRequest(BaseModel):
    username: str
    password: str


@app.post("/api/admin/login")
def admin_login(payload: AdminLoginRequest):
    """Authenticate an admin and issue a JWT.
    Send the returned access_token back as `Authorization: Bearer <token>`
    on every other /api/admin/* request."""
    admin = authenticate_admin(payload.username, payload.password)
    token = create_access_token(admin["id"], admin["username"], admin["role"])
    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in_hours": int(os.environ.get("JWT_EXPIRES_HOURS", "12")),
        "username": admin["username"],
        "role": admin["role"],
    }


class EventCreate(BaseModel):
    name: str
    fest: str                           # e.g. "Invente" or "Instincts"
    department: str
    location_id: str
    date: str                           # YYYY-MM-DD
    start_time: str                     # HH:MM
    end_time: str
    description: str
    open_to_external: bool = True
    # Phase 10 — rich event detail fields
    organizer: Optional[str] = None          # organising club / person
    category: Optional[str] = None           # Workshop, Competition, Performance, Exhibition…
    contact_info: Optional[str] = None       # email or phone
    registration_link: Optional[str] = None  # URL
    poster_url: Optional[str] = None         # hero image URL
    photo_urls: Optional[List[str]] = []     # gallery (0-10 URLs)
    # Phase 11 — room / floor / wing (venue detail for classrooms / labs)
    building: Optional[str] = None           # e.g. "EEE Block"
    room_number: Optional[str] = None        # e.g. "EEE-302"
    floor: Optional[str] = None              # e.g. "3rd Floor"
    wing: Optional[str] = None               # e.g. "Left Wing"


@app.post("/api/admin/events")
def create_event(payload: EventCreate, admin: dict = Depends(get_current_active_admin)):
    """
    Protected — submit a new event for the fest. Both roles can reach this
    (a Fest Admin submitting their own schedule is the main use now).
    Status will be 'pending' until a Super Admin verifies/rejects/requests
    changes via the endpoints below. The event will NOT appear on the
    public /api/events list until verified (= approved).
    """
    try:
        event_id = data_access.create_event(payload.model_dump(), created_by_admin_id=admin["sub"])
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    generate_event_qr(event_id)
    data_access.record_audit(admin["sub"], admin["username"], "fest_submitted", "event", event_id)
    return {"message": "Event submitted — pending verification.", "event_id": event_id}


class EventUpdate(BaseModel):
    """Same field set as EventCreate, all optional — a PATCH, not a PUT.
    Only fields actually present in the request body are changed (see
    exclude_unset=True below); everything else on the event is left as-is.
    Does not include poster_url/photo_urls — image management stays on the
    existing /images endpoints, unchanged."""
    name: Optional[str] = None
    fest: Optional[str] = None
    department: Optional[str] = None
    location_id: Optional[str] = None
    date: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    description: Optional[str] = None
    open_to_external: Optional[bool] = None
    organizer: Optional[str] = None
    category: Optional[str] = None
    contact_info: Optional[str] = None
    registration_link: Optional[str] = None
    building: Optional[str] = None
    room_number: Optional[str] = None
    floor: Optional[str] = None
    wing: Optional[str] = None


@app.patch("/api/admin/events/{event_id}")
def edit_event(event_id: str, payload: EventUpdate, admin: dict = Depends(get_current_active_admin)):
    """Edit an event's core fields. New endpoint — there wasn't one before
    Fest Admin accounts existed (Super Admins only ever verified/rejected/
    deleted). Super Admin can edit anything, any time, status unchanged.
    Fest Admin can only edit their own submission, and only before it's
    approved — see data_access.update_event for the exact rule and what
    happens to its status on a successful edit."""
    outcome = data_access.update_event(
        event_id, payload.model_dump(exclude_unset=True), admin["sub"], admin["role"]
    )
    if outcome == "not_found":
        raise HTTPException(status_code=404, detail=f"Event '{event_id}' not found")
    if outcome == "forbidden":
        raise HTTPException(status_code=403, detail="You can only edit fest schedules you submitted yourself.")
    if outcome == "locked":
        raise HTTPException(status_code=409, detail="This event is already approved and can no longer be edited. Contact a Super Admin.")
    data_access.record_audit(admin["sub"], admin["username"], "fest_updated", "event", event_id)
    return {"message": f"Event '{event_id}' updated."}


@app.patch("/api/admin/events/{event_id}/verify")
def verify_event(event_id: str, admin: dict = Depends(require_role("superadmin"))):
    """Mark an event as verified (= Approved) — it will now appear on the
    public schedule. Super Admin only."""
    if not data_access.verify_event(event_id, reviewer_id=admin["sub"]):
        raise HTTPException(status_code=404, detail=f"Event '{event_id}' not found")
    data_access.record_audit(admin["sub"], admin["username"], "fest_approved", "event", event_id)
    return {"message": f"Event '{event_id}' verified and now public."}


@app.patch("/api/admin/events/{event_id}/reject")
def reject_event(event_id: str, reason: str = "", admin: dict = Depends(require_role("superadmin"))):
    """Reject / hide an event from the public schedule. Super Admin only."""
    if not data_access.reject_event(event_id, reason, reviewer_id=admin["sub"]):
        raise HTTPException(status_code=404, detail=f"Event '{event_id}' not found")
    data_access.record_audit(admin["sub"], admin["username"], "fest_rejected", "event", event_id, {"reason": reason})
    return {"message": f"Event '{event_id}' rejected."}


@app.patch("/api/admin/events/{event_id}/request-changes")
def request_changes(event_id: str, notes: str = "", admin: dict = Depends(require_role("superadmin"))):
    """Third review outcome: send it back to the Fest Admin with notes on
    what to change, instead of an outright reject. Super Admin only."""
    if not notes.strip():
        raise HTTPException(status_code=400, detail="Add a note explaining what needs to change.")
    if not data_access.request_changes_event(event_id, notes, reviewer_id=admin["sub"]):
        raise HTTPException(status_code=404, detail=f"Event '{event_id}' not found")
    data_access.record_audit(admin["sub"], admin["username"], "fest_needs_changes", "event", event_id, {"notes": notes})
    return {"message": f"Event '{event_id}' sent back for changes."}


@app.get("/api/admin/events")
def list_all_events_admin(admin: dict = Depends(get_current_active_admin)):
    """List events for the admin dashboard. Super Admin sees every event;
    a Fest Admin only sees the ones they submitted themselves (enforced in
    data_access, not just hidden client-side)."""
    return data_access.list_all_events_admin(requesting_admin_id=admin["sub"], requesting_role=admin["role"])


@app.delete("/api/admin/events/{event_id}")
def delete_event(event_id: str, admin: dict = Depends(require_role("superadmin"))):
    """Permanently delete an event (its images are removed too, via
    cascade). Super Admin only — Fest Admins can edit/resubmit but not
    delete outright."""
    if not data_access.delete_event(event_id):
        raise HTTPException(status_code=404, detail=f"Event '{event_id}' not found")
    # Remove QR code if it exists
    qr_path = os.path.join(STATIC_DIR, "qr", f"{event_id}.png")
    if os.path.exists(qr_path):
        os.remove(qr_path)
    data_access.record_audit(admin["sub"], admin["username"], "fest_deleted", "event", event_id)
    return {"message": f"Event '{event_id}' deleted."}


def _authorize_event_access(event_id: str, admin: dict) -> None:
    """Shared check for the image endpoints below: Super Admin can touch
    any event's images; a Fest Admin only their own. Raises 404/403 as
    appropriate; returns normally if access is allowed."""
    meta = data_access.get_event_meta(event_id)
    if not meta:
        raise HTTPException(status_code=404, detail=f"Event '{event_id}' not found")
    if admin["role"] != "superadmin" and meta["created_by"] != admin["sub"]:
        raise HTTPException(status_code=403, detail="You can only manage images on fest schedules you submitted yourself.")


@app.post("/api/admin/events/{event_id}/images")
async def upload_event_image(
    event_id: str,
    file: UploadFile = File(...),
    is_poster: bool = Form(False),
    admin: dict = Depends(get_current_active_admin),
):
    """New in Phase 3 — uploads an image file to Supabase Storage and returns
    its public URL. The admin dashboard drops that URL straight into the
    existing poster_url / photo_urls text field, so event creation/edit
    itself is completely unchanged; this just gives that field a real
    "Upload" option alongside pasting an external URL."""
    _authorize_event_access(event_id, admin)

    content = await file.read()
    try:
        public_url, storage_path = data_access.upload_event_image_file(
            event_id,
            file.filename or "image",
            content,
            file.content_type or "application/octet-stream",
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    data_access.add_event_image(event_id, public_url, storage_path, is_poster)
    return {"url": public_url, "is_poster": is_poster}


@app.get("/api/admin/events/{event_id}/images")
def list_event_images(event_id: str, admin: dict = Depends(get_current_active_admin)):
    """Phase 4.2 — list all image rows for an event (for poster management UI)."""
    _authorize_event_access(event_id, admin)
    return data_access.list_event_images(event_id)


@app.delete("/api/admin/events/{event_id}/images/{image_id}")
def delete_event_image(event_id: str, image_id: str, admin: dict = Depends(get_current_active_admin)):
    """Phase 4.2 — delete one image from an event (removes from Storage too)."""
    _authorize_event_access(event_id, admin)
    if not data_access.delete_event_image(image_id, event_id):
        raise HTTPException(status_code=404, detail="Image not found.")
    return {"message": "Image deleted."}


# ---------------------------------------------------------------------------
# Manage Fest Admins (RBAC) — Super Admin only.
#
# There's deliberately no equivalent set of routes for managing OTHER
# Super Admins — that stays a CLI-only action (scripts/create_admin.py),
# same as it was before Fest Admin accounts existed. No HTTP route in this
# file can create, promote, or modify a superadmin account.
# ---------------------------------------------------------------------------

class FestAdminCreate(BaseModel):
    username: str
    password: Optional[str] = None  # omit to auto-generate one (returned once in the response)


@app.get("/api/admin/fest-admins")
def list_fest_admins(admin: dict = Depends(require_role("superadmin"))):
    """List every Fest Admin account, who created it, and its status."""
    return data_access.list_fest_admins()


@app.post("/api/admin/fest-admins")
def create_fest_admin(payload: FestAdminCreate, admin: dict = Depends(require_role("superadmin"))):
    """Create a new Fest Admin account. Leave password blank to have one
    generated — it's only ever returned in this response (bcrypt is one-
    way, so this is the only chance to see or copy it); note it down or
    hand it to the coordinator directly."""
    username = payload.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username can't be empty.")

    password = payload.password or generate_password()
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")

    try:
        data_access.create_fest_admin(username, hash_password(password), created_by_id=admin["sub"])
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))

    data_access.record_audit(admin["sub"], admin["username"], "fest_admin_created", "admin", username)
    return {
        "message": f"Fest Admin '{username}' created.",
        "username": username,
        # Only present when we generated it — the frontend shows this once,
        # in a "copy and share with the coordinator" panel, and never again.
        "generated_password": password if not payload.password else None,
    }


@app.patch("/api/admin/fest-admins/{admin_id}/disable")
def disable_fest_admin(admin_id: str, admin: dict = Depends(require_role("superadmin"))):
    if not data_access.set_admin_disabled(admin_id, True):
        raise HTTPException(status_code=404, detail="Fest Admin not found.")
    data_access.record_audit(admin["sub"], admin["username"], "fest_admin_disabled", "admin", admin_id)
    return {"message": "Fest Admin disabled. Their session is cut off on their very next request."}


@app.patch("/api/admin/fest-admins/{admin_id}/enable")
def enable_fest_admin(admin_id: str, admin: dict = Depends(require_role("superadmin"))):
    if not data_access.set_admin_disabled(admin_id, False):
        raise HTTPException(status_code=404, detail="Fest Admin not found.")
    data_access.record_audit(admin["sub"], admin["username"], "fest_admin_enabled", "admin", admin_id)
    return {"message": "Fest Admin re-enabled."}


class PasswordResetRequest(BaseModel):
    password: Optional[str] = None  # omit to auto-generate one (returned once in the response)


@app.post("/api/admin/fest-admins/{admin_id}/reset-password")
def reset_fest_admin_password(admin_id: str, payload: PasswordResetRequest, admin: dict = Depends(require_role("superadmin"))):
    password = payload.password or generate_password()
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    if not data_access.reset_admin_password(admin_id, hash_password(password)):
        raise HTTPException(status_code=404, detail="Fest Admin not found.")
    data_access.record_audit(admin["sub"], admin["username"], "password_reset", "admin", admin_id)
    return {
        "message": "Password reset.",
        "generated_password": password if not payload.password else None,
    }


@app.delete("/api/admin/fest-admins/{admin_id}")
def delete_fest_admin(admin_id: str, admin: dict = Depends(require_role("superadmin"))):
    """Deletes the account. Events they submitted are NOT deleted — see
    data_access.delete_admin's docstring (created_by on those rows just
    goes to null via ON DELETE SET NULL)."""
    if not data_access.delete_admin(admin_id):
        raise HTTPException(status_code=404, detail="Fest Admin not found.")
    data_access.record_audit(admin["sub"], admin["username"], "fest_admin_deleted", "admin", admin_id)
    return {"message": "Fest Admin deleted."}


@app.get("/api/admin/audit-log")
def get_audit_log(limit: int = Query(200, ge=1, le=1000), admin: dict = Depends(require_role("superadmin"))):
    """Recent admin actions: Fest Admin created/disabled/enabled/deleted,
    password resets, fest schedule submitted/approved/rejected/sent-back/
    updated. Newest first."""
    return data_access.list_audit_log(limit)


# ---------------------------------------------------------------------------
# Road segments — admin can close/open segments for construction etc.
# Super Admin only — a Fest Admin has no reason to touch routing/roads.
# ---------------------------------------------------------------------------

@app.get("/api/road-segments")
def get_road_segments():
    """Public — list all road segments and their open/closed status."""
    return data_access.get_road_segments()


@app.patch("/api/admin/road-segments/{seg_id}/close")
def close_segment(seg_id: str, admin: dict = Depends(require_role("superadmin"))):
    """Admin — mark a road segment as closed (construction, event, etc.)."""
    seg = data_access.set_segment_closed(seg_id, True)
    if not seg:
        raise HTTPException(status_code=404, detail=f"Segment '{seg_id}' not found")
    return {"message": f"Segment '{seg['name']}' closed. Routes will avoid this road."}


@app.patch("/api/admin/road-segments/{seg_id}/open")
def open_segment(seg_id: str, admin: dict = Depends(require_role("superadmin"))):
    """Admin — reopen a previously closed road segment."""
    seg = data_access.set_segment_closed(seg_id, False)
    if not seg:
        raise HTTPException(status_code=404, detail=f"Segment '{seg_id}' not found")
    return {"message": f"Segment '{seg['name']}' reopened."}


# ---------------------------------------------------------------------------
# Venue menus — food court menu images (Phase 4.2)
# ---------------------------------------------------------------------------

def _friendly_menu_error(exc: Exception, action: str) -> HTTPException:
    """Priority 2 (Phase 4.2.5) — the global SupabaseUnavailableError handler
    above deliberately includes the raw backend detail (e.g. a PGRST205
    "table not found" message, or a storage "Bucket not found" error) —
    genuinely useful for general API debugging, and left as-is everywhere
    else. The food-menu widgets are public-facing UI, though, and showing
    that raw detail there means a random visitor sees a database error
    code. This logs the full real error (for debugging) and returns a
    short, friendly, food-menu-specific message instead — never the raw
    Supabase JSON/exception text.
    """
    logger.error("Venue menu %s failed: %s", action, exc)
    return HTTPException(status_code=503, detail="Unable to reach menu service. Please try again shortly.")


@app.get("/api/locations/{venue_id}/menu")
def get_venue_menu(venue_id: str, date: Optional[str] = Query(None, description="YYYY-MM-DD, defaults to today")):
    """Public — get today's menu image for a food court / dining venue."""
    try:
        if not data_access.venue_exists(venue_id):
            raise HTTPException(status_code=404, detail=f"Venue '{venue_id}' not found")
        menu = data_access.get_menu(venue_id, date)
    except SupabaseUnavailableError as e:
        raise _friendly_menu_error(e, "read") from e
    if not menu:
        raise HTTPException(status_code=404, detail="Today's menu has not been uploaded.")
    return menu


@app.post("/api/admin/locations/{venue_id}/menu")
async def upload_venue_menu(
    venue_id: str,
    file: UploadFile = File(...),
    date: str = Form(..., description="YYYY-MM-DD"),
    description: Optional[str] = Form(None),
    admin: dict = Depends(require_role("superadmin")),
):
    """Admin — upload (or replace) the menu image for a venue on a specific date."""
    try:
        if not data_access.venue_exists(venue_id):
            raise HTTPException(status_code=404, detail=f"Venue '{venue_id}' not found")
        content = await file.read()
        try:
            public_url, storage_path = data_access.upload_menu_image_file(
                venue_id, file.filename or "menu", content, file.content_type or "image/jpeg"
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        menu = data_access.upsert_menu(venue_id, date, public_url, storage_path, description, admin["sub"])
    except SupabaseUnavailableError as e:
        # Admin panel — friendly summary in the response, full detail in the
        # server log; VenueMenuAdmin.jsx still surfaces e.message to the
        # admin directly, which is fine (it's an operator screen, not
        # public UI), but the message itself should still be actionable
        # rather than a raw PostgREST/Storage error string.
        raise _friendly_menu_error(e, "upload") from e
    return menu


@app.delete("/api/admin/locations/{venue_id}/menu")
def delete_venue_menu(
    venue_id: str,
    date: str = Query(..., description="YYYY-MM-DD"),
    admin: dict = Depends(require_role("superadmin")),
):
    """Admin — delete the menu for a venue on a specific date."""
    try:
        deleted = data_access.delete_menu(venue_id, date)
    except SupabaseUnavailableError as e:
        raise _friendly_menu_error(e, "delete") from e
    if not deleted:
        raise HTTPException(status_code=404, detail="No menu found for that venue/date.")
    return {"message": "Menu deleted."}


@app.get("/api/admin/diagnostics/menu-system")
def diagnose_menu_system(admin: dict = Depends(require_role("superadmin"))):
    """Priority 1 (Phase 4.2.6) — hit this once (logged in as admin) to get
    an unambiguous answer to "what exactly is broken", instead of
    inferring it from the generic 503 the public endpoints intentionally
    return. See data_access.diagnose_menu_system's docstring."""
    return data_access.diagnose_menu_system()


# ---------------------------------------------------------------------------
# Analytics (Phase X — Feature 2: Navigation Analytics)
#
# Anonymous, aggregate-only — no auth on the ingest side because there is no
# identity to authenticate: session_id is a random id the frontend mints
# fresh per app open and never persists across visits. See
# data_access.py's Analytics section for exactly what is (and isn't) stored.
# ---------------------------------------------------------------------------

class AnalyticsEvent(BaseModel):
    event_type: str
    payload: Optional[dict] = None


class AnalyticsBatch(BaseModel):
    session_id: Optional[str] = None
    events: List[AnalyticsEvent]


@app.post("/api/analytics/events")
def ingest_analytics(body: AnalyticsBatch):
    """Public — batched analytics ingestion (the frontend queues events and
    flushes periodically / on reconnect rather than one request per event).
    Never fails a whole batch over one bad event — unrecognized event types
    are silently dropped server-side."""
    inserted = data_access.record_analytics_events(
        [e.model_dump() for e in body.events], body.session_id
    )
    return {"inserted": inserted}


@app.get("/api/admin/analytics/summary")
def analytics_summary(days: int = Query(30, ge=1, le=365), admin: dict = Depends(require_role("superadmin"))):
    """Admin — aggregated analytics for the dashboard: top searches, top
    destinations/starting points, daily/weekly/monthly usage, reroute and
    cancellation hotspots, GPS weak-signal zones, success rate, etc."""
    return data_access.get_analytics_summary(days)


# ---------------------------------------------------------------------------
# Route feedback (Phase X — Feature 3: Route Feedback System)
# ---------------------------------------------------------------------------

class FeedbackCreate(BaseModel):
    destination_id: Optional[str] = None
    destination_name: Optional[str] = None
    rating: Optional[int] = None
    accurate: Optional[bool] = None
    categories: Optional[List[str]] = []
    comment: Optional[str] = None
    distance_m: Optional[float] = None
    arrived: bool = False


class FeedbackStatusUpdate(BaseModel):
    status: Optional[str] = None
    resolution: Optional[str] = None
    admin_notes: Optional[str] = None


@app.post("/api/feedback")
def submit_feedback(body: FeedbackCreate):
    """Public — submit route feedback (shown when navigation ends or the
    destination is reached). Returns the new feedback id so the frontend
    can optionally follow up with POST /api/feedback/{id}/screenshot."""
    row = data_access.create_feedback(body.model_dump())
    return {"message": "Thanks for the feedback!", "feedback_id": row.get("id")}


@app.post("/api/feedback/{feedback_id}/screenshot")
async def upload_feedback_screenshot(feedback_id: str, file: UploadFile = File(...)):
    """Public — optional screenshot attach. Same create-then-attach pattern
    as the existing event-image upload flow above."""
    content = await file.read()
    try:
        public_url, storage_path = data_access.upload_feedback_screenshot_file(
            feedback_id, file.filename or "screenshot", content,
            file.content_type or "application/octet-stream",
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    row = data_access.attach_feedback_screenshot(feedback_id, public_url, storage_path)
    if not row:
        raise HTTPException(status_code=404, detail=f"Feedback '{feedback_id}' not found")
    return {"url": public_url}


@app.get("/api/admin/feedback")
def list_feedback(status: Optional[str] = Query(None), admin: dict = Depends(require_role("superadmin"))):
    """Admin — list route feedback, optionally filtered by status
    (pending / reviewed / resolved), newest first."""
    return data_access.list_feedback_admin(status)


@app.patch("/api/admin/feedback/{feedback_id}")
def update_feedback(feedback_id: str, body: FeedbackStatusUpdate, admin: dict = Depends(require_role("superadmin"))):
    """Admin — move feedback through pending -> reviewed -> resolved and
    record accepted / rejected / fixed once actioned."""
    row = data_access.update_feedback_status(feedback_id, body.status, body.resolution, body.admin_notes)
    if not row:
        raise HTTPException(status_code=404, detail=f"Feedback '{feedback_id}' not found")
    return row


# ---------------------------------------------------------------------------
# Campus Copilot — text understanding only.
#
# This endpoint classifies the message and resolves any building/department
# it names against the *existing* venues data. It does not know about
# the caller's GPS position and does not duplicate the routing, events, or
# nearby-facility logic that already exists elsewhere — the frontend uses
# the existing /api/locations, /api/events, /api/route etc. (and the
# existing utils/facilities.js helpers) to act on whatever this returns.
# See utils/copilot.py for the engine itself — it is unmodified by this
# migration; only where main.py gets the `locations` list from changed.
# ---------------------------------------------------------------------------


class CopilotChatRequest(BaseModel):
    message: str
    context: Optional[dict] = None


@app.post("/api/copilot/chat")
def copilot_chat(body: CopilotChatRequest):
    """Public — classify one chatbot message. Stateless: the caller (the
    frontend) is responsible for holding conversation state and deciding
    what to do with the returned intent/entities."""
    locations = data_access.get_locations()
    result = _copilot.classify(body.message, locations, body.context)
    return result