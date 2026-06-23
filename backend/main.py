"""
SSN Campus Navigator - Backend API (Phase 2 & 3)

Run locally:
    pip install -r requirements.txt --break-system-packages
    uvicorn main:app --reload

Interactive API docs available at http://127.0.0.1:8000/docs
"""

import json
import math
import os
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from utils.qr_generator import generate_event_qr

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
STATIC_DIR = os.path.join(BASE_DIR, "static")

app = FastAPI(
    title="SSN Campus Navigator API",
    description="Backend for the Smart Campus Navigation System (SSN College of Engineering)",
    version="0.1.0",
)

# Allow the frontend (Vite dev server, or any device scanning a QR code) to call this API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_json(filename: str):
    with open(os.path.join(DATA_DIR, filename), "r", encoding="utf-8") as f:
        return json.load(f)


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
    locations = load_json("locations.json")
    if category:
        locations = [l for l in locations if l["category"].lower() == category.lower()]
    return locations


@app.get("/api/locations/search")
def search_locations(q: str = Query(..., min_length=1, description="Search text")):
    """Search locations by name, department or category (for the search bar / autocomplete)."""
    locations = load_json("locations.json")
    q_lower = q.lower()
    results = [
        l for l in locations
        if q_lower in l["name"].lower()
        or q_lower in (l.get("department") or "").lower()
        or q_lower in l["category"].lower()
    ]
    return results


@app.get("/api/locations/{location_id}")
def get_location(location_id: str):
    locations = load_json("locations.json")
    for l in locations:
        if l["id"] == location_id:
            return l
    raise HTTPException(status_code=404, detail=f"Location '{location_id}' not found")


# ---------------------------------------------------------------------------
# Events (fest schedule)
# ---------------------------------------------------------------------------

@app.get("/api/events")
def list_events(fest: Optional[str] = None, date: Optional[str] = None):
    """List fest events, each enriched with its venue's coordinates.
    Optionally filter by fest name (e.g. 'Invente') or date (YYYY-MM-DD)."""
    events = load_json("events.json")
    locations = {l["id"]: l for l in load_json("locations.json")}

    # Only show verified events to the public
    events = [e for e in events if e.get("status", "verified") == "verified"]
    if fest:
        events = [e for e in events if e["fest"].lower() == fest.lower()]
    if date:
        events = [e for e in events if e["date"] == date]

    for e in events:
        loc = locations.get(e["location_id"])
        if loc:
            e["location"] = {
                "id": loc["id"],
                "name": loc["name"],
                "lat": loc["lat"],
                "lng": loc["lng"],
            }
    return events


@app.get("/api/events/{event_id}")
def get_event(event_id: str):
    """Get full details for one event, including its venue location.
    This is the data that powers the page a fest visitor lands on after scanning a QR code."""
    events = load_json("events.json")
    locations = {l["id"]: l for l in load_json("locations.json")}

    for e in events:
        if e["id"] == event_id:
            loc = locations.get(e["location_id"])
            if loc:
                e["location"] = loc
            return e
    raise HTTPException(status_code=404, detail=f"Event '{event_id}' not found")


@app.get("/api/events/{event_id}/qr")
def get_event_qr(event_id: str):
    """Return a PNG QR code that links directly to this event's page.
    Print this on posters/flyers so visitors from other colleges can scan -> open the
    app (PWA) -> see the event -> tap 'Get Directions'."""
    events = load_json("events.json")
    if not any(e["id"] == event_id for e in events):
        raise HTTPException(status_code=404, detail=f"Event '{event_id}' not found")

    path = os.path.join(STATIC_DIR, "qr", f"{event_id}.png")
    if not os.path.exists(path):
        generate_event_qr(event_id)
    return FileResponse(path, media_type="image/png")


from utils.router import find_route as _find_route, find_route_from_point as _find_route_from_point

# ---------------------------------------------------------------------------
# Routing (Phase 5 — real walkway graph via Dijkstra)
# ---------------------------------------------------------------------------

@app.get("/api/route")
def get_route(
    from_id: Optional[str] = Query(None, description="Starting location id, e.g. 'main-gate'. Omit if using from_lat/from_lng."),
    to_id: str = Query(..., description="Destination location id, e.g. 'eee-block'"),
    from_lat: Optional[float] = Query(None, description="Live GPS latitude — used instead of from_id for on-the-move rerouting."),
    from_lng: Optional[float] = Query(None, description="Live GPS longitude — used instead of from_id for on-the-move rerouting."),
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
    locations = {l["id"]: l for l in load_json("locations.json")}
    if to_id not in locations:
        raise HTTPException(status_code=404, detail=f"Unknown to_id '{to_id}'")
    b = locations[to_id]

    using_coords = from_lat is not None and from_lng is not None

    if not using_coords and not from_id:
        raise HTTPException(status_code=400, detail="Provide either from_id or both from_lat and from_lng")

    try:
        if using_coords:
            result = _find_route_from_point(from_lat, from_lng, to_id)
            from_payload = {"id": None, "name": "Current location", "lat": from_lat, "lng": from_lng}
        else:
            if from_id not in locations:
                raise HTTPException(status_code=404, detail=f"Unknown from_id '{from_id}'")
            a = locations[from_id]
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
        ],
    }


# ---------------------------------------------------------------------------
# Admin — event management (add / verify / reject)
# Protected by a simple secret key set via ADMIN_SECRET env var.
# In production swap this for proper JWT auth.
# ---------------------------------------------------------------------------

import uuid
from datetime import datetime
from pydantic import BaseModel

ADMIN_SECRET = os.environ.get("ADMIN_SECRET", "ssnadmin123")  # change before deploying


def check_admin(secret: str):
    if secret != ADMIN_SECRET:
        raise HTTPException(status_code=401, detail="Invalid admin secret")


def save_events(events: list):
    with open(os.path.join(DATA_DIR, "events.json"), "w", encoding="utf-8") as f:
        json.dump(events, f, indent=2, ensure_ascii=False)
        f.write("\n")


class EventCreate(BaseModel):
    name: str
    fest: str                   # e.g. "Invente" or "Instincts"
    department: str
    location_id: str
    date: str                   # YYYY-MM-DD
    start_time: str             # HH:MM
    end_time: str
    description: str
    open_to_external: bool = True


@app.post("/api/admin/events")
def create_event(payload: EventCreate, secret: str = Query(...)):
    """
    Dev/organiser endpoint — submit a new event for the fest.
    Status will be 'pending' until an admin verifies it via PATCH.
    The event will NOT appear on the public /api/events list until verified.
    """
    check_admin(secret)

    # Verify location exists
    locations = {l["id"]: l for l in load_json("locations.json")}
    if payload.location_id not in locations:
        raise HTTPException(
            status_code=400,
            detail=f"location_id '{payload.location_id}' not found. "
                   f"Valid ids: {list(locations.keys())}",
        )

    events = load_json("events.json")
    slug = payload.name.lower().replace(" ", "-").replace("/", "-")[:40]
    event_id = f"{slug}-{uuid.uuid4().hex[:6]}"

    new_event = {
        "id": event_id,
        **payload.model_dump(),
        "status": "pending",
        "created_at": datetime.utcnow().isoformat(),
    }
    events.append(new_event)
    save_events(events)
    generate_event_qr(event_id)

    return {"message": "Event submitted — pending verification.", "event_id": event_id}


@app.patch("/api/admin/events/{event_id}/verify")
def verify_event(event_id: str, secret: str = Query(...)):
    """Mark an event as verified — it will now appear on the public schedule."""
    check_admin(secret)
    events = load_json("events.json")
    for e in events:
        if e["id"] == event_id:
            e["status"] = "verified"
            save_events(events)
            return {"message": f"Event '{event_id}' verified and now public."}
    raise HTTPException(status_code=404, detail=f"Event '{event_id}' not found")


@app.patch("/api/admin/events/{event_id}/reject")
def reject_event(event_id: str, secret: str = Query(...), reason: str = ""):
    """Reject / hide an event from the public schedule."""
    check_admin(secret)
    events = load_json("events.json")
    for e in events:
        if e["id"] == event_id:
            e["status"] = "rejected"
            e["reject_reason"] = reason
            save_events(events)
            return {"message": f"Event '{event_id}' rejected."}
    raise HTTPException(status_code=404, detail=f"Event '{event_id}' not found")


@app.get("/api/admin/events")
def list_all_events_admin(secret: str = Query(...)):
    """List ALL events including pending and rejected — for the admin dashboard."""
    check_admin(secret)
    events = load_json("events.json")
    locations = {l["id"]: l for l in load_json("locations.json")}
    for e in events:
        loc = locations.get(e["location_id"])
        if loc:
            e["location"] = {"id": loc["id"], "name": loc["name"], "lat": loc["lat"], "lng": loc["lng"]}
    return events


@app.delete("/api/admin/events/{event_id}")
def delete_event(event_id: str, secret: str = Query(...)):
    """Permanently delete an event."""
    check_admin(secret)
    events = load_json("events.json")
    filtered = [e for e in events if e["id"] != event_id]
    if len(filtered) == len(events):
        raise HTTPException(status_code=404, detail=f"Event '{event_id}' not found")
    save_events(filtered)
    # Remove QR code if it exists
    qr_path = os.path.join(STATIC_DIR, "qr", f"{event_id}.png")
    if os.path.exists(qr_path):
        os.remove(qr_path)
    return {"message": f"Event '{event_id}' deleted."}


# ---------------------------------------------------------------------------
# Road segments — admin can close/open segments for construction etc.
# ---------------------------------------------------------------------------

SEG_PATH = os.path.join(DATA_DIR, "road_segments.json")

def load_segments():
    with open(SEG_PATH) as f:
        return json.load(f)

def save_segments(segs):
    with open(SEG_PATH, 'w') as f:
        json.dump(segs, f, indent=2)


@app.get("/api/road-segments")
def get_road_segments():
    """Public — list all road segments and their open/closed status."""
    return load_segments()


@app.patch("/api/admin/road-segments/{seg_id}/close")
def close_segment(seg_id: str, secret: str = Query(...)):
    """Admin — mark a road segment as closed (construction, event, etc.)."""
    check_admin(secret)
    segs = load_segments()
    for s in segs:
        if s['id'] == seg_id:
            s['closed'] = True
            save_segments(segs)
            return {"message": f"Segment '{s['name']}' closed. Routes will avoid this road."}
    raise HTTPException(status_code=404, detail=f"Segment '{seg_id}' not found")


@app.patch("/api/admin/road-segments/{seg_id}/open")
def open_segment(seg_id: str, secret: str = Query(...)):
    """Admin — reopen a previously closed road segment."""
    check_admin(secret)
    segs = load_segments()
    for s in segs:
        if s['id'] == seg_id:
            s['closed'] = False
            save_segments(segs)
            return {"message": f"Segment '{s['name']}' reopened."}
    raise HTTPException(status_code=404, detail=f"Segment '{seg_id}' not found")