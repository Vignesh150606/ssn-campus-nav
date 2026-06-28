"""
Data access layer — every place the backend used to do
`json.load(open("data/x.json"))` or write one back now goes through here
instead, talking to Supabase Postgres (+ Storage for images).

main.py imports functions from this module; it never touches the
Supabase client directly. This keeps main.py's route bodies almost
identical to the Phase 2 version — only the data source underneath
changed.

Two things are deliberately NOT here, by design (see SUPABASE_MIGRATION.md):
- locations/venues have no write functions — there was never a write
  endpoint for them in Phase 2 either, so none is added here.
- the walkway routing graph (walkway_graph.json) is never touched —
  utils/router.py keeps reading it straight off disk, untouched.
"""
import os
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from db import SupabaseUnavailableError, get_client

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
ROAD_SEGMENTS_CACHE_PATH = os.path.join(DATA_DIR, "road_segments.json")

EVENT_IMAGES_BUCKET = "event-images"
ALLOWED_IMAGE_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # 5 MB

# Embeds events -> event_categories (for the category name) and
# event_images (for poster_url / photo_urls) in a single round trip.
_EVENT_SELECT = (
    "*, event_categories(name), "
    "event_images(id, url, is_poster, sort_order)"
)
_EVENT_SELECT_WITH_VENUE = _EVENT_SELECT + ", venues(id, name, category, department, lat, lng, floors, accessible, description, facilities)"


def _wrap(fn, *args, **kwargs):
    """Run a Supabase call, turning any failure into SupabaseUnavailableError
    so routes can return a clean 503 instead of a raw 500."""
    try:
        return fn(*args, **kwargs)
    except SupabaseUnavailableError:
        raise
    except Exception as exc:
        raise SupabaseUnavailableError(str(exc)) from exc


# ---------------------------------------------------------------------------
# Venues (was: locations.json)
# ---------------------------------------------------------------------------

_VENUE_COLUMNS = "id, name, category, department, lat, lng, floors, accessible, description, facilities"


def get_locations(category: Optional[str] = None) -> List[dict]:
    def _run():
        client = get_client()
        q = client.table("venues").select(_VENUE_COLUMNS)
        if category:
            q = q.ilike("category", category)
        return q.order("name").execute().data or []

    return _wrap(_run)


def search_locations(q: str) -> List[dict]:
    def _run():
        client = get_client()
        pattern = f"%{q}%"
        # PostgREST OR filter across the three fields the old code searched.
        result = (
            client.table("venues")
            .select(_VENUE_COLUMNS)
            .or_(f"name.ilike.{pattern},department.ilike.{pattern},category.ilike.{pattern}")
            .order("name")
            .execute()
        )
        return result.data or []

    return _wrap(_run)


def get_location(location_id: str) -> Optional[dict]:
    def _run():
        client = get_client()
        result = (
            client.table("venues").select(_VENUE_COLUMNS).eq("id", location_id).limit(1).execute()
        )
        rows = result.data or []
        return rows[0] if rows else None

    return _wrap(_run)


def venue_exists(location_id: str) -> bool:
    return get_location(location_id) is not None


# ---------------------------------------------------------------------------
# Event categories — small lookup table, auto-populated from whatever the
# admin types in the (still free-text) category field, so the UI doesn't
# need a fixed dropdown to get a normalized FK.
# ---------------------------------------------------------------------------


def _get_or_create_category_id(client, name: Optional[str]) -> Optional[int]:
    if not name:
        return None
    existing = client.table("event_categories").select("id").eq("name", name).limit(1).execute()
    if existing.data:
        return existing.data[0]["id"]
    created = client.table("event_categories").insert({"name": name}).execute()
    if created.data:
        return created.data[0]["id"]
    # Race condition fallback: someone else inserted it between our select and insert.
    refetch = client.table("event_categories").select("id").eq("name", name).limit(1).execute()
    return refetch.data[0]["id"] if refetch.data else None


# ---------------------------------------------------------------------------
# Events (was: events.json)
# ---------------------------------------------------------------------------


def _serialize_event(row: dict, location_mode: str = "minimal") -> dict:
    """Turn a Supabase row (with embedded event_categories/event_images/venues)
    back into the exact flat shape the frontend has always received."""
    images = row.pop("event_images", None) or []
    images_sorted = sorted(images, key=lambda im: (im.get("sort_order") or 0))
    poster = next((im["url"] for im in images_sorted if im.get("is_poster")), "")
    gallery = [im["url"] for im in images_sorted if not im.get("is_poster")]

    cat = row.pop("event_categories", None)
    category = cat["name"] if cat else None

    venue = row.pop("venues", None)

    out = {
        **row,
        "category": category,
        "poster_url": poster,
        "photo_urls": gallery,
    }
    out.pop("category_id", None)
    out.pop("created_by", None)  # internal admin id — never exposed via the API

    if location_mode == "none":
        return out

    if venue:
        if location_mode == "full":
            out["location"] = venue
        else:  # minimal — matches the old {id, name, lat, lng} subset
            out["location"] = {"id": venue["id"], "name": venue["name"], "lat": venue["lat"], "lng": venue["lng"]}
    return out


def list_public_events(fest: Optional[str] = None, date: Optional[str] = None) -> List[dict]:
    def _run():
        client = get_client()
        q = client.table("events").select(_EVENT_SELECT_WITH_VENUE).eq("status", "verified")
        if fest:
            q = q.ilike("fest", fest)
        if date:
            q = q.eq("date", date)
        rows = q.order("created_at").execute().data or []
        return [_serialize_event(r, location_mode="minimal") for r in rows]

    return _wrap(_run)


def get_event(event_id: str) -> Optional[dict]:
    def _run():
        client = get_client()
        result = (
            client.table("events")
            .select(_EVENT_SELECT_WITH_VENUE)
            .eq("id", event_id)
            .limit(1)
            .execute()
        )
        rows = result.data or []
        if not rows:
            return None
        return _serialize_event(rows[0], location_mode="full")

    return _wrap(_run)


def event_exists(event_id: str) -> bool:
    def _run():
        client = get_client()
        result = client.table("events").select("id").eq("id", event_id).limit(1).execute()
        return bool(result.data)

    return _wrap(_run)


def list_all_events_admin() -> List[dict]:
    def _run():
        client = get_client()
        rows = client.table("events").select(_EVENT_SELECT_WITH_VENUE).order("created_at").execute().data or []
        return [_serialize_event(r, location_mode="minimal") for r in rows]

    return _wrap(_run)


def _slugify_event_id(name: str) -> str:
    slug = name.lower().strip().replace(" ", "-").replace("/", "-")[:40]
    return f"{slug}-{uuid.uuid4().hex[:6]}"


def create_event(payload: dict, created_by_admin_id: Optional[str] = None) -> str:
    """payload matches the EventCreate pydantic model's .model_dump().
    Returns the new event's id. Raises ValueError if location_id is unknown
    (main.py turns that into the same 400 response as before)."""

    def _run():
        client = get_client()

        if not venue_exists(payload["location_id"]):
            raise ValueError(f"location_id '{payload['location_id']}' not found.")

        event_id = _slugify_event_id(payload["name"])
        category_id = _get_or_create_category_id(client, payload.get("category"))

        row = {
            "id": event_id,
            "name": payload["name"],
            "fest": payload["fest"],
            "department": payload["department"],
            "location_id": payload["location_id"],
            "date": payload["date"],
            "start_time": payload["start_time"],
            "end_time": payload["end_time"],
            "description": payload["description"],
            "open_to_external": payload.get("open_to_external", True),
            "organizer": payload.get("organizer"),
            "category_id": category_id,
            "contact_info": payload.get("contact_info"),
            "registration_link": payload.get("registration_link"),
            "building": payload.get("building"),
            "room_number": payload.get("room_number"),
            "floor": payload.get("floor"),
            "wing": payload.get("wing"),
            "status": "pending",
            "created_by": created_by_admin_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        client.table("events").insert(row).execute()

        # Normalize poster_url / photo_urls (plain strings on the old model)
        # into event_images rows.
        images_to_insert = []
        poster_url = (payload.get("poster_url") or "").strip()
        if poster_url:
            images_to_insert.append(
                {"event_id": event_id, "url": poster_url, "is_poster": True, "sort_order": 0}
            )
        for i, url in enumerate(payload.get("photo_urls") or []):
            url = (url or "").strip()
            if url:
                images_to_insert.append(
                    {"event_id": event_id, "url": url, "is_poster": False, "sort_order": i}
                )
        if images_to_insert:
            client.table("event_images").insert(images_to_insert).execute()

        return event_id

    return _wrap(_run)


def verify_event(event_id: str) -> bool:
    def _run():
        client = get_client()
        result = (
            client.table("events")
            .update({"status": "verified", "updated_at": datetime.now(timezone.utc).isoformat()})
            .eq("id", event_id)
            .execute()
        )
        return bool(result.data)

    return _wrap(_run)


def reject_event(event_id: str, reason: str = "") -> bool:
    def _run():
        client = get_client()
        result = (
            client.table("events")
            .update(
                {
                    "status": "rejected",
                    "reject_reason": reason,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            )
            .eq("id", event_id)
            .execute()
        )
        return bool(result.data)

    return _wrap(_run)


def delete_event(event_id: str) -> bool:
    def _run():
        client = get_client()
        # event_images rows are removed automatically (ON DELETE CASCADE).
        result = client.table("events").delete().eq("id", event_id).execute()
        return bool(result.data)

    return _wrap(_run)


def add_event_image(event_id: str, url: str, storage_path: Optional[str], is_poster: bool) -> dict:
    """Used by the new /api/admin/events/{id}/images upload endpoint.
    If is_poster=True, any existing poster row for this event is replaced
    (mirrors the old behaviour where poster_url was a single field)."""

    def _run():
        client = get_client()
        if is_poster:
            client.table("event_images").delete().eq("event_id", event_id).eq("is_poster", True).execute()
            sort_order = 0
        else:
            existing = (
                client.table("event_images")
                .select("sort_order")
                .eq("event_id", event_id)
                .eq("is_poster", False)
                .order("sort_order", desc=True)
                .limit(1)
                .execute()
            )
            sort_order = (existing.data[0]["sort_order"] + 1) if existing.data else 0

        result = (
            client.table("event_images")
            .insert(
                {
                    "event_id": event_id,
                    "url": url,
                    "storage_path": storage_path,
                    "is_poster": is_poster,
                    "sort_order": sort_order,
                }
            )
            .execute()
        )
        return result.data[0] if result.data else {"event_id": event_id, "url": url}

    return _wrap(_run)


def upload_event_image_file(event_id: str, filename: str, content: bytes, content_type: str) -> str:
    """Uploads raw bytes to the `event-images` Supabase Storage bucket and
    returns the public URL. Raises ValueError for invalid type/size — the
    route turns that into a 400."""
    if content_type not in ALLOWED_IMAGE_CONTENT_TYPES:
        raise ValueError(f"Unsupported image type '{content_type}'. Allowed: jpeg, png, webp, gif.")
    if len(content) > MAX_IMAGE_BYTES:
        raise ValueError(f"Image too large ({len(content)} bytes). Max {MAX_IMAGE_BYTES} bytes.")

    def _run():
        client = get_client()
        safe_name = "".join(c for c in filename if c.isalnum() or c in "._-") or "image"
        storage_path = f"{event_id}/{uuid.uuid4().hex}_{safe_name}"
        client.storage.from_(EVENT_IMAGES_BUCKET).upload(
            storage_path, content, file_options={"content-type": content_type}
        )
        public = client.storage.from_(EVENT_IMAGES_BUCKET).get_public_url(storage_path)
        # supabase-py has returned either a plain string or a nested dict
        # across versions — handle both defensively rather than pin one.
        if isinstance(public, dict):
            public_url = (
                public.get("publicUrl")
                or public.get("publicURL")
                or public.get("data", {}).get("publicUrl")
            )
        else:
            public_url = public
        if not public_url:
            raise SupabaseUnavailableError("Storage upload succeeded but no public URL was returned.")
        return public_url, storage_path

    public_url, storage_path = _wrap(_run)
    return public_url, storage_path


# ---------------------------------------------------------------------------
# Road segments (was: road_segments.json, mutated in place)
#
# router.py reads road_segments.json directly off disk and is NOT modified
# by this migration (it's part of the untouched routing engine). So Supabase
# is the source of truth, but every write here also rewrites the local JSON
# mirror file at the same path router.py already reads — keeping router.py
# at zero lines changed while still surviving redeploys (the mirror is
# resynced from Supabase on every backend startup, see main.py's startup
# event).
# ---------------------------------------------------------------------------


def _segment_row_to_legacy_shape(row: dict) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row.get("description"),
        "closed": row["closed"],
        "bbox": {
            "lat_min": row["lat_min"],
            "lat_max": row["lat_max"],
            "lng_min": row["lng_min"],
            "lng_max": row["lng_max"],
        },
    }


def get_road_segments() -> List[dict]:
    def _run():
        client = get_client()
        rows = client.table("road_segments").select("*").order("id").execute().data or []
        return [_segment_row_to_legacy_shape(r) for r in rows]

    return _wrap(_run)


def sync_road_segments_cache() -> None:
    """Rebuild the local JSON mirror from Supabase. Call on backend startup
    and after every segment mutation. Never raises — if Supabase is briefly
    unreachable at boot, router.py just keeps using whatever mirror file
    (if any) is already on disk."""
    try:
        segments = get_road_segments()
    except SupabaseUnavailableError:
        return
    import json

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(ROAD_SEGMENTS_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(segments, f, indent=2)


def set_segment_closed(seg_id: str, closed: bool) -> Optional[dict]:
    def _run():
        client = get_client()
        result = (
            client.table("road_segments")
            .update({"closed": closed, "updated_at": datetime.now(timezone.utc).isoformat()})
            .eq("id", seg_id)
            .execute()
        )
        return result.data[0] if result.data else None

    row = _wrap(_run)
    if row:
        sync_road_segments_cache()
        return _segment_row_to_legacy_shape(row)
    return None
