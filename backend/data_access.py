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
from datetime import datetime, timedelta, timezone
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


def health_check() -> None:
    """Lightweight Supabase liveness probe for the frontend boot screen.

    Raises SupabaseUnavailableError (the route layer turns that into a
    clean 503) if the database can't be reached right now; returns
    silently on success. Deliberately the cheapest possible round trip —
    one row, one column, no joins — so it's safe to poll frequently while
    the frontend is waiting for a Render cold start to finish."""
    def _run():
        client = get_client()
        client.table("venues").select("id").limit(1).execute()

    _wrap(_run)


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


# ---------------------------------------------------------------------------
# Venue menus  (Phase 4.2 — Food Court Menu)
# ---------------------------------------------------------------------------

MENU_IMAGES_BUCKET = "venue-menus"
_MENU_COLUMNS = "id, venue_id, date, image_url, storage_path, description, created_at, updated_at"


def get_menu(venue_id: str, date: Optional[str] = None) -> Optional[dict]:
    """Return today's (or a specific date's) menu for a venue, or None."""
    def _run():
        client = get_client()
        target_date = date or datetime.now(timezone.utc).date().isoformat()
        result = (
            client.table("venue_menus")
            .select(_MENU_COLUMNS)
            .eq("venue_id", venue_id)
            .eq("date", target_date)
            .limit(1)
            .execute()
        )
        rows = result.data or []
        return rows[0] if rows else None
    return _wrap(_run)


def list_menus(venue_id: str) -> List[dict]:
    """List all menu rows for a venue (admin: see history)."""
    def _run():
        client = get_client()
        result = (
            client.table("venue_menus")
            .select(_MENU_COLUMNS)
            .eq("venue_id", venue_id)
            .order("date", desc=True)
            .execute()
        )
        return result.data or []
    return _wrap(_run)


def upsert_menu(venue_id: str, date: str, image_url: str,
                storage_path: Optional[str], description: Optional[str],
                created_by_admin_id: Optional[str]) -> dict:
    """Insert or replace the menu for (venue_id, date). Returns the row."""
    def _run():
        client = get_client()
        # Delete any existing Storage object for this slot before overwriting
        existing = (
            client.table("venue_menus")
            .select("storage_path")
            .eq("venue_id", venue_id)
            .eq("date", date)
            .limit(1)
            .execute()
        )
        if existing.data and existing.data[0].get("storage_path"):
            try:
                client.storage.from_(MENU_IMAGES_BUCKET).remove([existing.data[0]["storage_path"]])
            except Exception:
                pass  # non-fatal: proceed with upsert even if old file stuck

        result = (
            client.table("venue_menus")
            .upsert(
                {
                    "venue_id": venue_id,
                    "date": date,
                    "image_url": image_url,
                    "storage_path": storage_path,
                    "description": description,
                    "created_by": created_by_admin_id,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                },
                on_conflict="venue_id,date",
            )
            .execute()
        )
        return result.data[0] if result.data else {}
    return _wrap(_run)


def delete_menu(venue_id: str, date: str) -> bool:
    """Delete the menu for (venue_id, date); also removes from Storage."""
    def _run():
        client = get_client()
        existing = (
            client.table("venue_menus")
            .select("storage_path")
            .eq("venue_id", venue_id)
            .eq("date", date)
            .limit(1)
            .execute()
        )
        if existing.data and existing.data[0].get("storage_path"):
            try:
                client.storage.from_(MENU_IMAGES_BUCKET).remove([existing.data[0]["storage_path"]])
            except Exception:
                pass
        result = (
            client.table("venue_menus")
            .delete()
            .eq("venue_id", venue_id)
            .eq("date", date)
            .execute()
        )
        return bool(result.data)
    return _wrap(_run)


def upload_menu_image_file(venue_id: str, filename: str,
                           content: bytes, content_type: str) -> tuple:
    """Upload menu image to Supabase Storage; returns (public_url, storage_path)."""
    if content_type not in ALLOWED_IMAGE_CONTENT_TYPES:
        raise ValueError(f"Unsupported image type '{content_type}'.")
    if len(content) > MAX_IMAGE_BYTES:
        raise ValueError(f"Image too large ({len(content)} bytes). Max {MAX_IMAGE_BYTES} bytes.")
    def _run():
        client = get_client()
        safe_name = "".join(c for c in filename if c.isalnum() or c in "._-") or "menu"
        storage_path = f"{venue_id}/{uuid.uuid4().hex}_{safe_name}"
        client.storage.from_(MENU_IMAGES_BUCKET).upload(
            storage_path, content, file_options={"content-type": content_type}
        )
        public = client.storage.from_(MENU_IMAGES_BUCKET).get_public_url(storage_path)
        if isinstance(public, dict):
            public_url = (public.get("publicUrl") or public.get("publicURL")
                          or public.get("data", {}).get("publicUrl"))
        else:
            public_url = public
        if not public_url:
            raise SupabaseUnavailableError("Storage upload succeeded but no public URL returned.")
        return public_url, storage_path
    return _wrap(_run)


def diagnose_menu_system() -> dict:
    """Priority 1 (Phase 4.2.6) — unambiguous self-diagnosis for the
    food-menu backend, so "Unable to reach menu service" never has to be
    debugged by guessing. Deliberately does NOT go through `_wrap` — a
    broken system here must still return a structured report, not itself
    raise a 503. Exposed via GET /api/admin/diagnostics/menu-system
    (admin-only, since it can reveal internal Supabase error detail).

    Each check runs independently so one failure doesn't hide the others
    — e.g. if BOTH the table and the bucket are missing, the report says
    so, rather than stopping at whichever is checked first.
    """
    result = {
        "expected_bucket_name": MENU_IMAGES_BUCKET,
        "client_ok": False, "client_error": None,
        "table_exists": False, "table_error": None,
        "bucket_exists": False, "bucket_error": None, "bucket_public": None,
    }
    try:
        client = get_client()
        result["client_ok"] = True
    except Exception as exc:
        result["client_error"] = str(exc)
        return result  # nothing else is checkable without a client

    # Table check — select(...).limit(1) is enough to prove the table (and
    # PostgREST's schema cache) actually sees `venue_menus`, without
    # depending on there being any rows in it yet.
    try:
        client.table("venue_menus").select("id").limit(1).execute()
        result["table_exists"] = True
    except Exception as exc:
        result["table_error"] = str(exc)

    # Bucket check — get_bucket() is a direct single-bucket lookup (a 404
    # here means "doesn't exist", vs. list_buckets() + search which is
    # both more expensive and less precise about *why* it failed).
    try:
        bucket = client.storage.get_bucket(MENU_IMAGES_BUCKET)
        result["bucket_exists"] = True
        result["bucket_public"] = getattr(bucket, "public", None)
    except Exception as exc:
        result["bucket_error"] = str(exc)

    return result


# ---------------------------------------------------------------------------
# Event image delete  (Phase 4.2 — poster management)
# ---------------------------------------------------------------------------

def delete_event_image(image_id: str, event_id: str) -> bool:
    """Delete one event image row and remove its file from Storage (if any).
    Returns True if a row was deleted, False if not found."""
    def _run():
        client = get_client()
        # Fetch storage_path before deleting the row (cascade would wipe it)
        existing = (
            client.table("event_images")
            .select("id, storage_path, is_poster")
            .eq("id", image_id)
            .eq("event_id", event_id)
            .limit(1)
            .execute()
        )
        if not existing.data:
            return False
        storage_path = existing.data[0].get("storage_path")
        if storage_path:
            try:
                client.storage.from_(EVENT_IMAGES_BUCKET).remove([storage_path])
            except Exception:
                pass  # non-fatal: delete DB row even if Storage remove fails
        result = client.table("event_images").delete().eq("id", image_id).execute()
        return bool(result.data)
    return _wrap(_run)


def list_event_images(event_id: str) -> List[dict]:
    """Return all image rows for an event, sorted by sort_order."""
    def _run():
        client = get_client()
        result = (
            client.table("event_images")
            .select("id, url, is_poster, sort_order, created_at")
            .eq("event_id", event_id)
            .order("sort_order")
            .execute()
        )
        return result.data or []
    return _wrap(_run)


# ---------------------------------------------------------------------------
# Analytics (Phase X — Feature 2: Navigation Analytics)
#
# Anonymous and aggregate-only by construction: analytics_events never has a
# name, device id, IP, or persistent cross-visit identifier column at all
# (see phaseX_analytics_feedback_migration.sql). `session_id` is a random id
# the frontend mints fresh per app open (sessionStorage) purely to group a
# burst of events from one visit — it is never linked to a person.
#
# GPS accuracy / "weak signal zone" metrics deliberately do NOT come from a
# separate continuous location-sampling stream (that would mean hooking into
# the live GPS pipeline, which is explicitly out of scope, and would be a
# much bigger privacy footprint). Instead they're derived from the accuracy
# figure + snapped walkway node already produced as a side effect of a
# route_requested/reroute call — incidental, coarse (nearest walkway node,
# not a raw coordinate), and only ever a handful of samples per trip.
# ---------------------------------------------------------------------------

ANALYTICS_EVENT_TYPES = {
    "search", "route_requested", "reroute", "trip_started", "trip_completed",
    "trip_cancelled", "event_page_view", "offline_usage",
}
MAX_ANALYTICS_BATCH = 50
WEAK_SIGNAL_THRESHOLD_M = 30


def record_analytics_events(events: List[dict], session_id: Optional[str]) -> int:
    """Insert a batch of anonymized analytics events. Silently drops any
    event whose type isn't recognized (e.g. an older/newer cached frontend
    build) rather than failing the whole batch. Returns rows inserted."""
    rows = []
    for e in (events or [])[:MAX_ANALYTICS_BATCH]:
        event_type = e.get("event_type")
        if event_type not in ANALYTICS_EVENT_TYPES:
            continue
        payload = e.get("payload") if isinstance(e.get("payload"), dict) else {}
        rows.append({"event_type": event_type, "session_id": session_id, "payload": payload})
    if not rows:
        return 0

    def _run():
        client = get_client()
        client.table("analytics_events").insert(rows).execute()
        return len(rows)

    return _wrap(_run)


def _count_by(rows: List[dict], key_fn, top: Optional[int] = None) -> List[dict]:
    """Count occurrences of key_fn(row) across rows, sorted descending.
    Backs every 'Top N' list in the analytics summary below."""
    counts: dict = {}
    for r in rows:
        k = key_fn(r)
        if k is None or k == "":
            continue
        counts[k] = counts.get(k, 0) + 1
    ordered = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    if top:
        ordered = ordered[:top]
    return [{"key": k, "count": c} for k, c in ordered]


def _parse_ts(raw: Optional[str]):
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def get_analytics_summary(days: int = 30) -> dict:
    """Aggregate analytics for the admin dashboard, over the last `days`
    days. Fetches raw events once (capped) and aggregates in Python —
    simplest thing that works at campus scale (a few thousand events/day at
    most), and keeps every aggregation reviewable in one place instead of
    scattered hand-written SQL views."""
    days = max(1, min(days, 365))

    def _run():
        client = get_client()
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        return (
            client.table("analytics_events")
            .select("event_type, payload, created_at")
            .gte("created_at", since)
            .order("created_at", desc=True)
            .limit(20000)
            .execute()
        ).data or []

    rows = _wrap(_run)

    by_type: dict = {}
    for r in rows:
        by_type.setdefault(r["event_type"], []).append(r)

    def payload(r):
        return r.get("payload") or {}

    searches         = by_type.get("search", [])
    route_reqs       = by_type.get("route_requested", [])
    reroutes         = by_type.get("reroute", [])
    trip_started     = by_type.get("trip_started", [])
    trip_completed   = by_type.get("trip_completed", [])
    trip_cancelled   = by_type.get("trip_cancelled", [])
    page_views       = by_type.get("event_page_view", [])
    offline_usage    = by_type.get("offline_usage", [])

    distances = [payload(r).get("distance_m") for r in trip_completed if isinstance(payload(r).get("distance_m"), (int, float))]
    durations = [payload(r).get("duration_s") for r in trip_completed if isinstance(payload(r).get("duration_s"), (int, float))]

    gps_rows = route_reqs + reroutes
    accuracies = [payload(r).get("accuracy_m") for r in gps_rows if isinstance(payload(r).get("accuracy_m"), (int, float))]
    weak_signal_rows = [r for r in gps_rows if isinstance(payload(r).get("accuracy_m"), (int, float)) and payload(r)["accuracy_m"] > WEAK_SIGNAL_THRESHOLD_M]

    no_result_searches = [r for r in searches if (payload(r).get("result_count") or 0) == 0]
    total_trips_ended = len(trip_completed) + len(trip_cancelled)
    success_rate = (len(trip_completed) / total_trips_ended) if total_trips_ended else None

    def _bucket_counts(events, fmt):
        buckets: dict = {}
        for r in events:
            dt = _parse_ts(r.get("created_at"))
            if dt is None:
                continue
            key = dt.strftime(fmt)
            buckets[key] = buckets.get(key, 0) + 1
        return sorted(({"period": k, "count": v} for k, v in buckets.items()), key=lambda x: x["period"])

    return {
        "range_days": days,
        "totals": {
            "searches": len(searches),
            "route_requests": len(route_reqs),
            "reroutes": len(reroutes),
            "trips_started": len(trip_started),
            "trips_completed": len(trip_completed),
            "trips_cancelled": len(trip_cancelled),
            "event_page_views": len(page_views),
            "offline_sessions": len(offline_usage),
            "no_result_searches": len(no_result_searches),
            "navigation_success_rate": round(success_rate, 3) if success_rate is not None else None,
            "avg_trip_distance_m": round(sum(distances) / len(distances), 1) if distances else None,
            "avg_trip_duration_s": round(sum(durations) / len(durations), 1) if durations else None,
            "avg_gps_accuracy_m": round(sum(accuracies) / len(accuracies), 1) if accuracies else None,
        },
        "top_searched":              _count_by(searches, lambda r: (payload(r).get("query") or "").strip().lower() or None, top=15),
        "no_result_search_terms":    _count_by(no_result_searches, lambda r: (payload(r).get("query") or "").strip().lower() or None, top=15),
        "top_destinations":          _count_by(trip_started, lambda r: payload(r).get("destination_id"), top=15),
        "top_starting_points":       _count_by(route_reqs, lambda r: payload(r).get("from_id") or ("Live GPS" if payload(r).get("from_gps") else None), top=15),
        "most_rerouted_destinations": _count_by(reroutes, lambda r: payload(r).get("destination_id"), top=15),
        "most_cancelled_destinations": _count_by(trip_cancelled, lambda r: payload(r).get("destination_id"), top=15),
        "most_viewed_events":        _count_by(page_views, lambda r: payload(r).get("event_id"), top=15),
        "gps_weak_signal_zones":     _count_by(weak_signal_rows, lambda r: payload(r).get("snapped_to"), top=15),
        "daily_usage":   _bucket_counts(trip_started, "%Y-%m-%d"),
        "weekly_usage":  _bucket_counts(trip_started, "%G-W%V"),
        "monthly_usage": _bucket_counts(trip_started, "%Y-%m"),
    }


# ---------------------------------------------------------------------------
# Route feedback (Phase X — Feature 3: Route Feedback System)
# ---------------------------------------------------------------------------

FEEDBACK_SCREENSHOTS_BUCKET = "route-feedback-screenshots"
FEEDBACK_CATEGORIES = {
    "incorrect_route", "blocked_path", "construction", "wrong_destination",
    "poor_gps", "voice_issue", "other",
}
_FEEDBACK_COLUMNS = (
    "id, destination_id, destination_name, rating, accurate, categories, "
    "comment, screenshot_url, distance_m, arrived, status, resolution, "
    "admin_notes, created_at, updated_at"
)


def create_feedback(payload: dict) -> dict:
    """Public — submit route feedback. `payload` is pre-validated by the
    FeedbackCreate pydantic model in main.py; any category not in
    FEEDBACK_CATEGORIES is silently dropped (not rejected) so an older
    cached frontend build can never hard-fail a submission."""
    def _run():
        client = get_client()
        categories = [c for c in (payload.get("categories") or []) if c in FEEDBACK_CATEGORIES]
        row = {
            "destination_id":   payload.get("destination_id"),
            "destination_name": payload.get("destination_name"),
            "rating":           payload.get("rating"),
            "accurate":         payload.get("accurate"),
            "categories":       categories,
            "comment":          ((payload.get("comment") or "").strip()[:2000]) or None,
            "distance_m":       payload.get("distance_m"),
            "arrived":          bool(payload.get("arrived")),
        }
        result = client.table("route_feedback").insert(row).execute()
        return result.data[0] if result.data else row

    return _wrap(_run)


def attach_feedback_screenshot(feedback_id: str, url: str, storage_path: str) -> Optional[dict]:
    def _run():
        client = get_client()
        result = (
            client.table("route_feedback")
            .update({"screenshot_url": url, "screenshot_storage_path": storage_path})
            .eq("id", feedback_id)
            .execute()
        )
        return result.data[0] if result.data else None

    return _wrap(_run)


def upload_feedback_screenshot_file(feedback_id: str, filename: str, content: bytes, content_type: str) -> tuple:
    """Same validation + Storage-upload pattern already used for event and
    menu images above."""
    if content_type not in ALLOWED_IMAGE_CONTENT_TYPES:
        raise ValueError(f"Unsupported image type '{content_type}'. Allowed: jpeg, png, webp, gif.")
    if len(content) > MAX_IMAGE_BYTES:
        raise ValueError(f"Image too large ({len(content)} bytes). Max {MAX_IMAGE_BYTES} bytes.")

    def _run():
        client = get_client()
        safe_name = "".join(c for c in filename if c.isalnum() or c in "._-") or "screenshot"
        storage_path = f"{feedback_id}/{uuid.uuid4().hex}_{safe_name}"
        client.storage.from_(FEEDBACK_SCREENSHOTS_BUCKET).upload(
            storage_path, content, file_options={"content-type": content_type}
        )
        public = client.storage.from_(FEEDBACK_SCREENSHOTS_BUCKET).get_public_url(storage_path)
        if isinstance(public, dict):
            public_url = (public.get("publicUrl") or public.get("publicURL")
                          or public.get("data", {}).get("publicUrl"))
        else:
            public_url = public
        if not public_url:
            raise SupabaseUnavailableError("Storage upload succeeded but no public URL was returned.")
        return public_url, storage_path

    return _wrap(_run)


def list_feedback_admin(status: Optional[str] = None, limit: int = 200) -> List[dict]:
    def _run():
        client = get_client()
        q = client.table("route_feedback").select(_FEEDBACK_COLUMNS).order("created_at", desc=True).limit(limit)
        if status:
            q = q.eq("status", status)
        return q.execute().data or []

    return _wrap(_run)


def update_feedback_status(feedback_id: str, status: Optional[str], resolution: Optional[str],
                           admin_notes: Optional[str]) -> Optional[dict]:
    def _run():
        client = get_client()
        updates = {}
        if status is not None:
            updates["status"] = status
        if resolution is not None:
            updates["resolution"] = resolution
        if admin_notes is not None:
            updates["admin_notes"] = admin_notes
        if not updates:
            return None
        result = client.table("route_feedback").update(updates).eq("id", feedback_id).execute()
        return result.data[0] if result.data else None

    return _wrap(_run)
