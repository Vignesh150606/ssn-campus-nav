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
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher

from db import SupabaseUnavailableError, get_client

logger = logging.getLogger("ssn-campus-nav.data_access")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
ROAD_SEGMENTS_CACHE_PATH = os.path.join(DATA_DIR, "road_segments.json")

EVENT_IMAGES_BUCKET = "event-images"
ALLOWED_IMAGE_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # 5 MB

# Item 11 fix — file signatures ("magic bytes") for each allowed image
# type, checked against the actual uploaded content. Previously the only
# type check anywhere in the upload path was `content_type not in
# ALLOWED_IMAGE_CONTENT_TYPES` — but content_type is the client-supplied
# multipart Content-Type header, which a request can set to anything
# regardless of what bytes actually follow. That let any file at all
# (including e.g. an .svg or .html with embedded script) through the
# allowlist just by claiming to be `image/png`, to a public Storage bucket
# that's loaded directly into <img> tags on the admin dashboard.
_IMAGE_MAGIC_PREFIXES = {
    b"\xff\xd8\xff": "image/jpeg",
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"GIF87a": "image/gif",
    b"GIF89a": "image/gif",
}


def _sniff_image_content_type(content: bytes) -> str | None:
    for magic, mime in _IMAGE_MAGIC_PREFIXES.items():
        if content.startswith(magic):
            return mime
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":  # WEBP: RIFF....WEBP
        return "image/webp"
    return None


def validate_image_upload(content: bytes, content_type: str) -> None:
    """Shared by upload_event_image_file / upload_menu_image_file — was
    three separately-maintained copies of the same two checks (claimed-type
    allowlist + size) before consolidating here; the third caller,
    upload_feedback_screenshot_file, was removed along with the feedback
    screenshot-upload feature itself (see delete_feedback below).
    Neither original copy ever looked at the actual bytes. Now also sniffs the real
    file signature and requires it to match a genuine allowed image type,
    independent of what the client claims. The size check stays here too
    as defense-in-depth even though callers now also bound how many bytes
    they ever read off the wire in the first place (see main.py)."""
    if content_type not in ALLOWED_IMAGE_CONTENT_TYPES:
        raise ValueError(f"Unsupported image type '{content_type}'. Allowed: jpeg, png, webp, gif.")
    if len(content) > MAX_IMAGE_BYTES:
        raise ValueError(f"Image too large ({len(content)} bytes). Max {MAX_IMAGE_BYTES} bytes.")
    sniffed = _sniff_image_content_type(content)
    if sniffed is None:
        raise ValueError("File content doesn't match a recognized image format (checked the actual file bytes, not just the claimed type).")
    if sniffed != content_type:
        raise ValueError(f"File content looks like '{sniffed}' but was uploaded as '{content_type}'.")

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


def get_locations(category: str | None = None) -> list[dict]:
    def _run():
        client = get_client()
        q = client.table("venues").select(_VENUE_COLUMNS)
        if category:
            q = q.ilike("category", category)
        return q.order("name").execute().data or []

    return _wrap(_run)


# Bug fix (search intelligence) — campus abbreviation/alias gaps. Most
# department abbreviations already work today purely by accident of the
# existing substring search (e.g. "CSE" matches because the venue's `name`
# literally contains "CSE Block") — verified against backend/data/
# locations.json, the one real sample of this campus's actual naming.
# "BME" is a genuine, confirmed gap that same check turned up: the venue is
# named "Biomedical / Chemical Block" / department "Biomedical and Chemical
# Engineering" — neither contains the substring "BME" anywhere, even
# though that's exactly how it's labelled on the map. Each entry here is
# additive (widens the OR filter with one more term), so worst case it
# returns the same results as before — it can only surface matches that
# were being missed, never hide ones that already worked.
_SEARCH_FILTER_UNSAFE_RE = re.compile(r"[,()]")

_SEARCH_ALIASES = {
    "bme": "biomedical",
    "biomedical": "bme",
    "cdc": "career development",
    "admin": "administration",
    # Confirmed via utils/copilot.py's own NEED_ALIASES/LOCATION_ALIASES —
    # "mess" is real campus slang for the canteen there, but the venue
    # search endpoint had no way to know that until now.
    "mess": "canteen",
}

_FUZZY_MIN_QUERY_LEN = 3
_FUZZY_MIN_RATIO = 0.7
_FUZZY_MAX_RESULTS = 8


def _relevance_rank(row: dict, ql: str) -> tuple:
    """Lower sorts first. Bug fix (search intelligence) — the previous
    `.order("name")` was purely alphabetical, so a location whose NAME
    starts with the query (the obvious best match) could rank below one
    that merely happens to contain those letters somewhere inside a
    longer, unrelated department string. This ranks an exact/prefix/
    whole-word match on `name` above a same-substring match buried in
    `department` or `category`, which is what "intelligent scoring"
    actually means for a place-search box like this one."""
    name = (row.get("name") or "").lower()
    dept = (row.get("department") or "").lower()
    cat = (row.get("category") or "").lower()
    word_in_name = re.search(rf"\b{re.escape(ql)}", name) is not None
    word_in_dept = re.search(rf"\b{re.escape(ql)}", dept) is not None
    if name == ql:
        tier = 0
    elif name.startswith(ql):
        tier = 1
    elif word_in_name:
        tier = 2
    elif ql in name:
        tier = 3
    elif dept.startswith(ql) or word_in_dept:
        tier = 4
    elif ql in dept:
        tier = 5
    elif ql in cat:
        tier = 6
    else:
        tier = 7
    return (tier, name)


def search_locations(q: str) -> list[dict]:
    def _run():
        client = get_client()
        ql = q.strip().lower()

        # Item 9 fix — `,` separates conditions and `()` group them in
        # PostgREST's `.or_()` filter-string DSL. The raw query used to go
        # straight into the f-string below, so a search containing a comma
        # or parenthesis could break the filter's own syntax (malformed
        # request rejected by PostgREST) or be parsed as filter structure
        # never intended by the query, instead of just being treated as
        # search text. Ordinary building/department name searches never
        # contain these characters, so this doesn't change normal results;
        # the `%wildcards%` PostgREST ilike syntax around the value below
        # is unaffected.
        ql_safe = _SEARCH_FILTER_UNSAFE_RE.sub("", ql)

        patterns = {ql_safe}
        alias = _SEARCH_ALIASES.get(ql)
        if alias:
            patterns.add(alias)
        patterns.discard("")  # an all-special-characters query sanitizes to empty — nothing to filter on

        if not patterns:
            return []

        # PostgREST OR filter across the three fields the old code
        # searched, now unioned across the query plus any known alias.
        or_clause = ",".join(
            f"name.ilike.%{p}%,department.ilike.%{p}%,category.ilike.%{p}%"
            for p in patterns
        )
        result = (
            client.table("venues")
            .select(_VENUE_COLUMNS)
            .or_(or_clause)
            .execute()
        )
        rows = result.data or []

        # Bug fix (search intelligence) — typo tolerance. A misspelled
        # query ("libary", "hostle") matches nothing under plain ILIKE.
        # This campus only has ~30 venues total, so on a genuine
        # zero-result search it's cheap and safe to fetch the full table
        # once and fuzzy-score it locally — no new dependency (difflib is
        # stdlib) and no assumption about Postgres extensions (pg_trgm
        # etc.) being enabled on this Supabase project, which can't be
        # verified from here. Only triggers on a true zero-result search,
        # so it can't ever downgrade a query that was already matching.
        if not rows and len(ql) >= _FUZZY_MIN_QUERY_LEN:
            all_rows = client.table("venues").select(_VENUE_COLUMNS).execute().data or []
            scored = []
            for row in all_rows:
                fields = [row.get("name") or "", row.get("department") or "", row.get("category") or ""]
                best = 0.0
                for f in fields:
                    fl = f.lower()
                    if not fl:
                        continue
                    best = max(best, SequenceMatcher(None, ql, fl).ratio())
                    # Also score against individual words, so a typo in one
                    # word of a longer name/department isn't diluted by the
                    # rest of the string being unrelated in length.
                    for word in fl.split():
                        best = max(best, SequenceMatcher(None, ql, word).ratio())
                if best >= _FUZZY_MIN_RATIO:
                    scored.append((best, row))
            scored.sort(key=lambda t: -t[0])
            return [row for _, row in scored[:_FUZZY_MAX_RESULTS]]

        rows.sort(key=lambda r: _relevance_rank(r, ql))
        return rows

    return _wrap(_run)


def get_location(location_id: str) -> dict | None:
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


def _get_or_create_category_id(client, name: str | None) -> int | None:
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


def _serialize_event(row: dict, location_mode: str = "minimal", admin_names: dict | None = None) -> dict:
    """Turn a Supabase row (with embedded event_categories/event_images/venues)
    back into the exact flat shape the frontend has always received.

    admin_names, if given, is a {admin_id: username} lookup — pass this
    (built once per list by list_all_events_admin, see below) to also
    resolve created_by/reviewed_by into human-readable submitted_by /
    reviewed_by usernames for the admin dashboard's Events tab. Left out
    entirely (not just null) for the public-facing calls (list_public_events
    / get_event), same as created_by always was — never expose who
    submitted/reviewed an event to a public visitor."""
    images = row.pop("event_images", None) or []
    images_sorted = sorted(images, key=lambda im: (im.get("sort_order") or 0))
    poster = next((im["url"] for im in images_sorted if im.get("is_poster")), "")
    gallery = [im["url"] for im in images_sorted if not im.get("is_poster")]

    cat = row.pop("event_categories", None)
    category = cat["name"] if cat else None

    venue = row.pop("venues", None)

    created_by_id = row.pop("created_by", None)
    reviewed_by_id = row.pop("reviewed_by", None)

    out = {
        **row,
        "category": category,
        "poster_url": poster,
        "photo_urls": gallery,
        # New unified reviewer-comment field. Pre-migration rejected events
        # only have reject_reason set (review_notes will be null on those) —
        # fall back so the admin UI has one field to read regardless of
        # which review action (old or new) produced it.
        "review_notes": row.get("review_notes") or row.get("reject_reason"),
    }
    out.pop("category_id", None)

    if admin_names is not None:
        out["submitted_by"] = admin_names.get(created_by_id) if created_by_id else None
        out["reviewed_by"] = admin_names.get(reviewed_by_id) if reviewed_by_id else None

    if location_mode == "none":
        return out

    if venue:
        if location_mode == "full":
            out["location"] = venue
        else:  # minimal — matches the old {id, name, lat, lng} subset
            out["location"] = {"id": venue["id"], "name": venue["name"], "lat": venue["lat"], "lng": venue["lng"]}
    return out


def list_public_events(fest: str | None = None, date: str | None = None) -> list[dict]:
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


def get_event(event_id: str) -> dict | None:
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


def get_event_meta(event_id: str) -> dict | None:
    """Just {id, created_by, status} — for authorization checks (does this
    Fest Admin own this event? is it still editable?) without pulling and
    serializing the full row. Distinct from get_event(), which is the
    public-shaped read and never exposes created_by."""
    def _run():
        client = get_client()
        rows = client.table("events").select("id, created_by, status").eq("id", event_id).limit(1).execute().data or []
        return rows[0] if rows else None

    return _wrap(_run)


def event_exists(event_id: str) -> bool:
    def _run():
        client = get_client()
        result = client.table("events").select("id").eq("id", event_id).limit(1).execute()
        return bool(result.data)

    return _wrap(_run)


def list_all_events_admin(requesting_admin_id: str | None = None, requesting_role: str | None = None) -> list[dict]:
    """List events for the admin dashboard.

    A Super Admin sees every event (unchanged from before the Fest Admin
    role existed). A Fest Admin only sees events they submitted themselves
    — "View status of their submitted schedules", not everyone's — enforced
    here server-side (not just hidden in the UI) since main.py always
    passes the requesting admin's own id/role through from the JWT."""
    def _run():
        client = get_client()
        q = client.table("events").select(_EVENT_SELECT_WITH_VENUE)
        if requesting_role == "festadmin":
            q = q.eq("created_by", requesting_admin_id)
        rows = q.order("created_at").execute().data or []

        admin_ids = {r.get("created_by") for r in rows if r.get("created_by")}
        admin_ids |= {r.get("reviewed_by") for r in rows if r.get("reviewed_by")}
        admin_names = {}
        if admin_ids:
            admin_rows = client.table("admins").select("id, username").in_("id", list(admin_ids)).execute().data or []
            admin_names = {a["id"]: a["username"] for a in admin_rows}

        return [_serialize_event(r, location_mode="minimal", admin_names=admin_names) for r in rows]

    return _wrap(_run)


def _slugify_event_id(name: str) -> str:
    slug = name.lower().strip().replace(" ", "-").replace("/", "-")[:40]
    return f"{slug}-{uuid.uuid4().hex[:6]}"


def create_event(payload: dict, created_by_admin_id: str | None = None) -> str:
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


def verify_event(event_id: str, reviewer_id: str | None = None) -> bool:
    def _run():
        client = get_client()
        now = datetime.now(timezone.utc).isoformat()
        result = (
            client.table("events")
            .update({
                "status": "verified",
                "reviewed_by": reviewer_id,
                "approved_at": now,
                "updated_at": now,
            })
            .eq("id", event_id)
            .execute()
        )
        return bool(result.data)

    return _wrap(_run)


def reject_event(event_id: str, reason: str = "", reviewer_id: str | None = None) -> bool:
    def _run():
        client = get_client()
        result = (
            client.table("events")
            .update(
                {
                    "status": "rejected",
                    "reject_reason": reason,
                    # review_notes mirrors reject_reason going forward — see
                    # its column comment in the RBAC migration for why both
                    # are written.
                    "review_notes": reason,
                    "reviewed_by": reviewer_id,
                    "approved_at": None,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            )
            .eq("id", event_id)
            .execute()
        )
        return bool(result.data)

    return _wrap(_run)


def request_changes_event(event_id: str, notes: str, reviewer_id: str | None = None) -> bool:
    """The third review outcome alongside verify/reject — sends the
    submission back to the Fest Admin with review_notes explaining what
    needs to change, without deleting or fully rejecting it. They can edit
    and it comes back to 'pending' automatically (see update_event)."""
    def _run():
        client = get_client()
        result = (
            client.table("events")
            .update(
                {
                    "status": "needs_changes",
                    "review_notes": notes,
                    "reviewed_by": reviewer_id,
                    "approved_at": None,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            )
            .eq("id", event_id)
            .execute()
        )
        return bool(result.data)

    return _wrap(_run)


def update_event(event_id: str, payload: dict, requesting_admin_id: str, requesting_role: str) -> str:
    """Edit an existing event's core fields. Images go through the separate
    /images endpoints, unchanged — this never touches poster_url/photo_urls.

    Returns 'ok' / 'not_found' / 'forbidden' / 'locked' so main.py can map
    each to the right HTTP status without a second lookup to explain why.

    Super Admin: can edit any event in any status; status itself is left
    untouched — this is a content fix, not a resubmission.
    Fest Admin: only their own event ("Edit their own submitted schedules"),
    and only while it's not yet approved ("...until approved") — pending,
    needs_changes, or rejected are all still editable, verified is locked.
    A successful Fest Admin edit resets status back to 'pending' and clears
    the previous review (reviewed_by/approved_at/review_notes) — editing
    after "needs changes" or "rejected" is a fresh submission for review.
    `payload` should already be pre-filtered to only the keys the caller
    actually provided (main.py does this via Pydantic's
    exclude_unset=True) — every key present here gets written, including
    an explicit null."""
    def _run():
        client = get_client()
        existing = (
            client.table("events").select("id, created_by, status").eq("id", event_id).limit(1).execute().data
        )
        if not existing:
            return "not_found"
        ev = existing[0]

        if requesting_role != "superadmin":
            if ev["created_by"] != requesting_admin_id:
                return "forbidden"
            if ev["status"] == "verified":
                return "locked"

        updates = dict(payload)
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()

        if requesting_role != "superadmin":
            updates["status"] = "pending"
            updates["reviewed_by"] = None
            updates["approved_at"] = None
            updates["review_notes"] = None

        if "category" in updates:
            updates["category_id"] = _get_or_create_category_id(client, updates.pop("category"))

        if updates.get("location_id") and not venue_exists(updates["location_id"]):
            raise ValueError(f"location_id '{updates['location_id']}' not found.")

        client.table("events").update(updates).eq("id", event_id).execute()
        return "ok"

    return _wrap(_run)


def delete_event(event_id: str) -> bool:
    def _run():
        client = get_client()
        # event_images rows are removed automatically (ON DELETE CASCADE).
        result = client.table("events").delete().eq("id", event_id).execute()
        return bool(result.data)

    return _wrap(_run)


def add_event_image(event_id: str, url: str, storage_path: str | None, is_poster: bool) -> dict:
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
    validate_image_upload(content, content_type)

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
# Fest Admin accounts (RBAC) — Super Admin can create/list/disable/enable/
# delete/reset-password on 'festadmin' accounts. There's deliberately no
# equivalent for managing OTHER Super Admins here (or in main.py) — bootstrap
# / promote a Super Admin via scripts/create_admin.py, same as before this
# feature existed. Keeping that out of the API surface means there's no
# HTTP route that can ever create or modify a superadmin account, which is
# exactly the privilege boundary the RBAC redesign is for.
# ---------------------------------------------------------------------------

def list_fest_admins() -> list[dict]:
    """For the "Manage Fest Admins" page — includes who created each one
    (resolved to a username, not just an id) and current status."""
    def _run():
        client = get_client()
        rows = (
            client.table("admins")
            .select("id, username, disabled, created_by, created_at, last_login_at")
            .eq("role", "festadmin")
            .order("created_at", desc=True)
            .execute()
            .data or []
        )
        creator_ids = {r["created_by"] for r in rows if r.get("created_by")}
        creator_names = {}
        if creator_ids:
            creators = client.table("admins").select("id, username").in_("id", list(creator_ids)).execute().data or []
            creator_names = {c["id"]: c["username"] for c in creators}
        for r in rows:
            r["created_by_username"] = creator_names.get(r.pop("created_by"))
        return rows

    return _wrap(_run)


def get_admin(admin_id: str) -> dict | None:
    def _run():
        client = get_client()
        rows = client.table("admins").select("id, username, role, disabled").eq("id", admin_id).limit(1).execute().data or []
        return rows[0] if rows else None

    return _wrap(_run)


def get_admin_with_hash(admin_id: str) -> dict | None:
    """Includes password_hash — internal use only (verifying "current
    password" on the Account Settings page), never returned from an API
    response. Distinct from get_admin(), which is safe to serialize."""
    def _run():
        client = get_client()
        rows = client.table("admins").select("id, username, role, password_hash").eq("id", admin_id).limit(1).execute().data or []
        return rows[0] if rows else None

    return _wrap(_run)


def update_own_account(admin_id: str, new_username: str | None = None, new_password_hash: str | None = None) -> dict:
    """Self-service account update (production audit Part 8) — works for
    either role, since changing your OWN credentials never touches the
    RBAC role boundary (see main.py's endpoint for why it's gated with
    get_current_active_admin, not require_role). Raises ValueError if the
    requested username is already taken by a different account."""
    def _run():
        client = get_client()
        updates = {}
        if new_username:
            existing = client.table("admins").select("id").eq("username", new_username).neq("id", admin_id).limit(1).execute().data
            if existing:
                raise ValueError(f"Username '{new_username}' is already taken.")
            updates["username"] = new_username
        if new_password_hash:
            updates["password_hash"] = new_password_hash
        if not updates:
            return {}
        result = client.table("admins").update(updates).eq("id", admin_id).execute()
        return result.data[0] if result.data else {}

    return _wrap(_run)


def create_fest_admin(username: str, password_hash: str, created_by_id: str) -> dict:
    """Raises ValueError if the username is already taken (checked
    explicitly rather than relying on the DB's unique-constraint error
    text, which differs across Postgres/PostgREST versions and shouldn't
    leak to an HTTP response verbatim)."""
    def _run():
        client = get_client()
        existing = client.table("admins").select("id").eq("username", username).limit(1).execute().data
        if existing:
            raise ValueError(f"Username '{username}' is already taken.")
        row = {
            "username": username,
            "password_hash": password_hash,
            "role": "festadmin",
            "created_by": created_by_id,
        }
        result = client.table("admins").insert(row).execute()
        return result.data[0] if result.data else row

    return _wrap(_run)


def set_admin_disabled(admin_id: str, disabled: bool) -> bool:
    def _run():
        client = get_client()
        result = (
            client.table("admins")
            .update({"disabled": disabled})
            .eq("id", admin_id)
            .eq("role", "festadmin")  # can't disable/enable a superadmin through this path
            .execute()
        )
        return bool(result.data)

    return _wrap(_run)


def reset_admin_password(admin_id: str, password_hash: str) -> bool:
    def _run():
        client = get_client()
        result = (
            client.table("admins")
            .update({"password_hash": password_hash})
            .eq("id", admin_id)
            .eq("role", "festadmin")
            .execute()
        )
        return bool(result.data)

    return _wrap(_run)


def delete_admin(admin_id: str) -> bool:
    """Events created by a deleted Fest Admin are NOT deleted or hidden —
    `created_by` on those rows just goes to null (ON DELETE SET NULL) and
    the admin dashboard shows them as submitted by an unknown/removed
    account rather than losing the fest schedule content itself."""
    def _run():
        client = get_client()
        result = client.table("admins").delete().eq("id", admin_id).eq("role", "festadmin").execute()
        return bool(result.data)

    return _wrap(_run)


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------

def record_audit(actor_id: str | None, actor_username: str, action: str,
                  target_type: str | None = None, target_id: str | None = None,
                  details: dict | None = None) -> None:
    """Best-effort — same philosophy as last_login_at above: a hiccup
    writing an audit row must never block the actual admin action it's
    describing (e.g. disabling a compromised account right now matters
    more than the log entry about it)."""
    try:
        client = get_client()
        client.table("admin_audit_log").insert({
            "actor_id": actor_id,
            "actor_username": actor_username,
            "action": action,
            "target_type": target_type,
            "target_id": target_id,
            "details": details,
        }).execute()
    except Exception:
        # Best-effort by design — a hiccup writing an audit row must never
        # block the actual admin action it's describing — but "never
        # block" isn't the same as "never notice". Previously a bare
        # `pass` meant audit logging could fail silently forever (schema
        # drift, permissions, an outage) with zero trace anywhere.
        logger.warning("Failed to record audit entry: actor=%s action=%s target=%s/%s",
                        actor_username, action, target_type, target_id, exc_info=True)


def list_audit_log(limit: int = 200) -> list[dict]:
    def _run():
        client = get_client()
        return (
            client.table("admin_audit_log")
            .select("*")
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
            .data or []
        )

    return _wrap(_run)


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


def get_road_segments() -> list[dict]:
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


def set_segment_closed(seg_id: str, closed: bool) -> dict | None:
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


def get_menu(venue_id: str, date: str | None = None) -> dict | None:
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


def list_menus(venue_id: str) -> list[dict]:
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
                storage_path: str | None, description: str | None,
                created_by_admin_id: str | None) -> dict:
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
                # non-fatal: proceed with upsert even if old file stuck.
                # Logged (not silently swallowed) so an orphaned Storage
                # object is at least visible/debuggable after the fact.
                logger.warning(
                    "venue_menus upsert: failed to remove old Storage object %r for venue_id=%r date=%r",
                    existing.data[0]["storage_path"], venue_id, date, exc_info=True,
                )

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
                # non-fatal: still delete the DB row even if Storage
                # cleanup fails. Logged so the leftover object is
                # discoverable rather than silently orphaned.
                logger.warning(
                    "delete_menu: failed to remove Storage object %r for venue_id=%r date=%r",
                    existing.data[0]["storage_path"], venue_id, date, exc_info=True,
                )
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
    validate_image_upload(content, content_type)
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
                # non-fatal: delete DB row even if Storage remove fails.
                # Logged so the leftover object is discoverable rather
                # than silently orphaned.
                logger.warning(
                    "delete_event_image: failed to remove Storage object %r for image_id=%r event_id=%r",
                    storage_path, image_id, event_id, exc_info=True,
                )
        result = client.table("event_images").delete().eq("id", image_id).execute()
        return bool(result.data)
    return _wrap(_run)


def list_event_images(event_id: str) -> list[dict]:
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


def record_analytics_events(events: list[dict], session_id: str | None) -> int:
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


def _count_by(rows: list[dict], key_fn, top: int | None = None) -> list[dict]:
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


def _parse_ts(raw: str | None):
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


def delete_feedback(feedback_id: str) -> bool:
    """Admin — permanently remove a feedback row, and its screenshot file
    in Storage if one was attached before the upload feature was removed.
    Returns False if the row didn't exist (caller returns 404)."""
    def _fetch():
        client = get_client()
        result = client.table("route_feedback").select("id, screenshot_storage_path").eq("id", feedback_id).limit(1).execute()
        return result.data or []

    rows = _wrap(_fetch)
    if not rows:
        return False
    storage_path = rows[0].get("screenshot_storage_path")

    def _run():
        client = get_client()
        if storage_path:
            try:
                client.storage.from_(FEEDBACK_SCREENSHOTS_BUCKET).remove([storage_path])
            except Exception:
                # best-effort — a storage hiccup shouldn't block deleting
                # the row itself. Logged so the leftover object is
                # discoverable rather than silently orphaned.
                logger.warning(
                    "delete_feedback: failed to remove Storage object %r for feedback_id=%r",
                    storage_path, feedback_id, exc_info=True,
                )
        client.table("route_feedback").delete().eq("id", feedback_id).execute()
        return True

    return _wrap(_run)


def list_feedback_admin(status: str | None = None, limit: int = 200) -> list[dict]:
    def _run():
        client = get_client()
        q = client.table("route_feedback").select(_FEEDBACK_COLUMNS).order("created_at", desc=True).limit(limit)
        if status:
            q = q.eq("status", status)
        return q.execute().data or []

    return _wrap(_run)


def update_feedback_status(feedback_id: str, status: str | None, resolution: str | None,
                           admin_notes: str | None) -> dict | None:
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
