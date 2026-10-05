"""
backend/snapshots.py  --  W2: static snapshots (takes read-mostly traffic off the API)

Builds small, minified JSON documents from the database and uploads them to a
PUBLIC Supabase Storage bucket (default name: `snapshots`).  The frontend reads
them straight from Supabase's CDN, so a fest crowd never touches Render for
schedule / menus / closures / posters.

Public interface (everything else is private):

    snapshots.init(app)            # once, in main.py; registers startup/shutdown
                                   # hooks + two superadmin routes
    snapshots.mark_dirty(name)     # call AFTER an admin write committed. Never
                                   # blocks, never raises. Debounced: a burst of
                                   # edits => one upload per snapshot.
    snapshots.publish(name)        # synchronous build+upload (raises on failure)
    snapshots.publish_all()        # all four, synchronous
    snapshots.optimize_upload(...) # poster/menu image -> WebP (<=1080px, <=150KB)

Snapshots: schedule | menus | closures | posters
Object layout in the bucket:
    schedule.json  menus.json  closures.json  posters.json   (cache-control ~60s)
    qr/<event_id>.png                                          (cache-control 1 day)

Envelope of every JSON object:
    {"schema":1, "version":<epoch ms, monotonic>, "updated_at":"<ISO UTC>",
     "meta":{...}, "data": <exactly the shape the live API returns today>}

Env vars (all optional except the two Supabase ones that already exist):
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (existing names; server-side only)
    SNAPSHOT_ENABLED=true            kill switch; false => mark_dirty is a no-op
    SNAPSHOT_BUCKET=snapshots
    SNAPSHOT_CACHE_SECONDS=60        cache-control max-age on the JSON objects
    SNAPSHOT_DEBOUNCE_SECONDS=5      quiet period before an upload fires
    SNAPSHOT_MAX_WAIT_SECONDS=30     upper bound if edits keep arriving
    SNAPSHOT_PUBLISH_ON_STARTUP=false  republish everything ~5s after boot
    SNAPSHOT_MENU_DAYS_AHEAD=14      menus window: today-1 .. today+N (UTC dates)
    SNAPSHOT_INCLUDE_CONTACT_INFO=false  contact_info can hold a phone/email
    SNAPSHOT_IMAGE_MAX_WIDTH=1080
    SNAPSHOT_IMAGE_TARGET_KB=150

Standalone: imports of data_access / db / utils.qr_generator / auth happen lazily
inside functions, so `import snapshots` never fails and never needs main.py.
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone

logger = logging.getLogger("ssn-campus-nav.snapshots")

NAMES = ("schedule", "menus", "closures", "posters")
# Posters are embedded in schedule events (poster_url / photo_urls), so an image
# change must refresh both objects. mark_dirty("posters") therefore marks both.
_DEPENDENTS = {"posters": ("posters", "schedule"), "schedule": ("schedule",),
               "menus": ("menus",), "closures": ("closures",)}
_MAX_RETRIES = 3
_RETRY_BASE_S = 10  # 10s, 30s, 90s

# Fields that must never reach a public file (reviewer notes, admin identity).
_EVENT_PRIVATE_KEYS = ("review_notes", "reject_reason", "reviewed_by", "created_by",
                       "submitted_by")
_EVENT_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,120}$")


# ---------------------------------------------------------------- config ----
def _env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return default if v is None or v.strip() == "" else v.strip()


def _env_bool(name: str, default: bool) -> bool:
    return _env(name, "true" if default else "false").lower() in ("1", "true", "yes", "on")


def _env_num(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return default


def _bucket() -> str:
    return _env("SNAPSHOT_BUCKET", "snapshots")


def _enabled() -> bool:
    return _env_bool("SNAPSHOT_ENABLED", True)


# ------------------------------------------------------------- transport ----
_http = None  # httpx.Client, created lazily; tests may replace via _set_http()
_http_lock = threading.Lock()


def _set_http(client) -> None:  # test hook
    global _http
    _http = client


def _client():
    global _http
    with _http_lock:
        if _http is None:
            import httpx
            _http = httpx.Client(timeout=httpx.Timeout(15.0, connect=5.0))
        return _http


def _creds() -> tuple[str, str]:
    url = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
    return url, key


def _upload(path: str, body: bytes, content_type: str, cache_seconds: int) -> None:
    """Upsert one object into the snapshots bucket via the Storage REST API.
    (Raw REST instead of supabase-py so cache-control is set the same way
    regardless of the supabase/storage3 version installed.)"""
    url, key = _creds()
    r = _client().post(
        f"{url}/storage/v1/object/{_bucket()}/{path}",
        content=body,
        headers={
            "Authorization": f"Bearer {key}",
            "apikey": key,
            "Content-Type": content_type,
            "x-upsert": "true",
            "Cache-Control": f"max-age={int(cache_seconds)}",
        },
    )
    if r.status_code >= 300:
        raise RuntimeError(f"upload {path} failed: HTTP {r.status_code} {r.text[:200]}")


# --------------------------------------------------------------- builders ----
def public_event(ev: dict) -> dict:
    out = {k: v for k, v in ev.items() if k not in _EVENT_PRIVATE_KEYS}
    if not _env_bool("SNAPSHOT_INCLUDE_CONTACT_INFO", False):
        out.pop("contact_info", None)
    return out


def _public_events() -> list[dict]:
    import data_access  # lazy
    return [public_event(e) for e in data_access.list_public_events()]


def _build_schedule() -> tuple[object, dict]:
    return _public_events(), {}


def _build_closures() -> tuple[object, dict]:
    import data_access
    return data_access.get_road_segments(), {}


def _build_posters() -> tuple[object, dict]:
    out = []
    for e in _public_events():
        poster, photos = e.get("poster_url") or "", e.get("photo_urls") or []
        if poster or photos:
            out.append({"event_id": e["id"], "poster_url": poster, "photo_urls": photos})
    return out, {}


def _build_menus() -> tuple[object, dict]:
    from db import get_client  # lazy
    today = datetime.now(timezone.utc).date()
    d_from = (today - timedelta(days=1)).isoformat()
    d_to = (today + timedelta(days=int(_env_num("SNAPSHOT_MENU_DAYS_AHEAD", 14)))).isoformat()
    rows = (get_client().table("venue_menus")
            .select("id, venue_id, date, image_url, description, created_at, updated_at")
            .gte("date", d_from).lte("date", d_to).execute().data or [])
    data: dict[str, dict] = {}
    for r in rows:  # {venue_id: {date: row}}; storage_path / created_by deliberately omitted
        data.setdefault(r["venue_id"], {})[str(r["date"])[:10]] = r
    return data, {"date_from": d_from, "date_to": d_to}


_BUILDERS = {"schedule": _build_schedule, "menus": _build_menus,
             "closures": _build_closures, "posters": _build_posters}

# ---------------------------------------------------------------- publish ----
_state_lock = threading.Lock()
_publish_lock = threading.Lock()
_last_hash: dict[str, str] = {}
_last_version = 0
_qr_done: set[str] = set()


def _dumps(obj) -> bytes:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False, default=str).encode("utf-8")


def _next_version() -> int:
    global _last_version
    with _state_lock:
        _last_version = max(_last_version + 1, int(time.time() * 1000))
        return _last_version


def _sync_qr(events: list[dict]) -> list[str]:
    """Upload qr/<id>.png for every public event (once per process). Returns the ids
    whose QR is available in the bucket, so the client only links to QRs that exist."""
    ready = []
    for ev in events:
        eid = ev.get("id")
        if not eid or not _EVENT_ID_RE.match(eid):
            continue
        if eid in _qr_done:
            ready.append(eid)
            continue
        try:
            from utils.qr_generator import STATIC_QR_DIR, generate_event_qr
            path = os.path.join(STATIC_QR_DIR, f"{eid}.png")
            if not os.path.exists(path):
                path = generate_event_qr(eid)
            with open(path, "rb") as f:
                _upload(f"qr/{eid}.png", f.read(), "image/png", 86400)
            _qr_done.add(eid)
            ready.append(eid)
        except Exception:
            logger.warning("snapshot QR upload failed for %s", eid, exc_info=True)
    return ready


def publish(name: str, force: bool = False) -> dict:
    with _publish_lock:
        return _publish_serial(name, force)


def _publish_serial(name: str, force: bool = False) -> dict:
    """Build + upload one snapshot. Raises on failure. Skips the upload when the
    data is byte-identical to the last published copy (unless force=True)."""
    if name not in _BUILDERS:
        raise ValueError(f"unknown snapshot {name!r}; expected one of {NAMES}")
    data, meta = _BUILDERS[name]()
    if name == "schedule":
        meta = {**meta, "qr_ids": _sync_qr(data)}
    digest = hashlib.sha256(_dumps({"data": data, "meta": meta})).hexdigest()
    if not force and _last_hash.get(name) == digest:
        logger.info("snapshot %s unchanged, upload skipped", name)
        return {"name": name, "status": "unchanged"}
    envelope = {"schema": 1, "version": _next_version(),
                "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "meta": meta, "data": data}
    body = _dumps(envelope)
    _upload(f"{name}.json", body, "application/json", int(_env_num("SNAPSHOT_CACHE_SECONDS", 60)))
    _last_hash[name] = digest
    logger.info("snapshot %s published: %d bytes, version %s", name, len(body), envelope["version"])
    return {"name": name, "status": "published", "bytes": len(body), "version": envelope["version"]}


def publish_all(force: bool = False) -> list[dict]:
    """All four snapshots; one failure doesn't stop the others. Raises at the end if any failed."""
    results, failed = [], []
    for n in NAMES:
        try:
            results.append(publish(n, force=force))
        except Exception as e:
            logger.error("snapshot %s failed: %s", n, e, exc_info=True)
            results.append({"name": n, "status": "failed", "error": str(e)})
            failed.append(n)
    if failed:
        raise RuntimeError(f"snapshots failed: {', '.join(failed)}")
    return results


# ------------------------------------------------------- debounced worker ----
_cv = threading.Condition()
_pending: dict[str, dict] = {}
_thread: threading.Thread | None = None
_stopping = False
_warned_creds = False


def mark_dirty(name: str) -> None:
    """Schedule a (debounced) republish. Safe to call from any route, any thread,
    after the DB write committed. Never blocks on I/O, never raises."""
    global _warned_creds
    try:
        if not _enabled():
            return
        targets = _DEPENDENTS.get(name)
        if not targets:
            logger.warning("mark_dirty: unknown snapshot %r ignored", name)
            return
        if not (os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_ROLE_KEY")):
            if not _warned_creds:
                logger.warning("snapshots: Supabase credentials missing, mark_dirty is a no-op")
                _warned_creds = True
            return
        now = time.monotonic()
        with _cv:
            for t in targets:
                ent = _pending.get(t)
                if ent is None:
                    _pending[t] = {"first": now, "last": now, "attempt": 0, "retry_at": None}
                else:
                    ent["last"] = now
                    if ent["retry_at"] is not None:  # fresh edit supersedes a backoff wait
                        ent["retry_at"], ent["attempt"], ent["first"] = None, 0, now
            _ensure_thread()
            _cv.notify()
    except Exception:  # never break the admin write
        logger.error("mark_dirty(%r) failed", name, exc_info=True)


def _ensure_thread() -> None:  # call with _cv held
    global _thread, _stopping
    if _thread is None or not _thread.is_alive():
        _stopping = False
        _thread = threading.Thread(target=_worker, name="snapshot-publisher", daemon=True)
        _thread.start()


def _due(ent: dict) -> float:
    if ent["retry_at"] is not None:
        return ent["retry_at"]
    return min(ent["last"] + _env_num("SNAPSHOT_DEBOUNCE_SECONDS", 5),
               ent["first"] + _env_num("SNAPSHOT_MAX_WAIT_SECONDS", 30))


def _worker() -> None:
    while True:
        with _cv:
            while True:
                if _stopping:
                    return
                now = time.monotonic()
                due = [n for n, e in _pending.items() if _due(e) <= now]
                if due:
                    taken = {n: _pending.pop(n) for n in due}
                    break
                _cv.wait(timeout=(min(_due(e) for e in _pending.values()) - now) if _pending else None)
        for name, ent in taken.items():  # network I/O outside the lock
            try:
                publish(name)
            except Exception as e:
                attempt = ent["attempt"] + 1
                if attempt > _MAX_RETRIES:
                    logger.error("snapshot %s: giving up after %d attempts (%s)", name, attempt - 1, e)
                    continue
                delay = _RETRY_BASE_S * 3 ** (attempt - 1)
                logger.warning("snapshot %s failed (%s); retry %d/%d in %ds", name, e, attempt, _MAX_RETRIES, delay)
                with _cv:
                    cur = _pending.get(name)
                    if cur is None:  # no newer edit arrived meanwhile
                        _pending[name] = {"first": time.monotonic(), "last": time.monotonic(),
                                          "attempt": attempt, "retry_at": time.monotonic() + delay}


def flush(timeout: float = 8.0) -> None:
    """Publish whatever is pending right now (used on shutdown). Best effort."""
    deadline = time.monotonic() + timeout
    with _cv:
        names = list(_pending)
        _pending.clear()
    for n in names:
        if time.monotonic() > deadline:
            logger.warning("snapshots.flush: timed out, %s not published", n)
            break
        try:
            publish(n)
        except Exception:
            logger.error("snapshots.flush: %s failed", n, exc_info=True)


def _stop_worker() -> None:
    global _stopping
    with _cv:
        _stopping = True
        _cv.notify_all()


# ------------------------------------------------------------------ init ----
def init(app) -> None:
    """Single entry point for main.py:  snapshots.init(app)"""
    if getattr(app.state, "snapshots_initialised", False):
        return
    app.state.snapshots_initialised = True

    def _startup():
        if _env_bool("SNAPSHOT_PUBLISH_ON_STARTUP", False):
            for n in NAMES:
                mark_dirty(n)

    def _shutdown():
        try:
            flush()
        finally:
            _stop_worker()

    app.add_event_handler("startup", _startup)
    app.add_event_handler("shutdown", _shutdown)

    try:  # admin helpers; skipped silently if auth.py isn't importable (standalone use)
        from fastapi import APIRouter, Depends, HTTPException
        from auth import require_role
        r = APIRouter()

        @r.post("/api/admin/snapshots/publish")
        def _admin_publish(name: str | None = None, admin: dict = Depends(require_role("superadmin"))):
            """Force-rebuild one snapshot (or all). Synchronous; ~1-3 s."""
            try:
                if name:
                    return [publish(name, force=True)]
                return publish_all(force=True)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
            except Exception as e:
                logger.error("manual snapshot publish failed", exc_info=True)
                raise HTTPException(status_code=502, detail="Snapshot upload failed. Check the server logs.") from e

        @r.get("/api/admin/snapshots/status")
        def _admin_status(admin: dict = Depends(require_role("superadmin"))):
            with _cv:
                pending = sorted(_pending)
            return {"enabled": _enabled(), "bucket": _bucket(), "pending": pending,
                    "last_version": _last_version, "published": sorted(_last_hash)}

        app.include_router(r)
    except Exception:
        logger.info("snapshots: admin routes not registered", exc_info=True)


# ------------------------------------------------------- image -> WebP ----
def optimize_image(content: bytes, max_width: int | None = None,
                   target_bytes: int | None = None) -> tuple[bytes, dict]:
    """Decode, strip metadata (incl. GPS EXIF), downscale to <= max_width, encode WebP
    <= target_bytes (quality ladder, then progressive downscale to a 480px floor).
    Raises ValueError for undecodable / oversized-pixel images (route -> HTTP 400).
    Blocking CPU work: call via starlette.concurrency.run_in_threadpool."""
    from PIL import Image, ImageOps, features
    max_width = max_width or int(_env_num("SNAPSHOT_IMAGE_MAX_WIDTH", 1080))
    target_bytes = target_bytes or int(_env_num("SNAPSHOT_IMAGE_TARGET_KB", 150)) * 1024
    if not features.check("webp"):
        raise RuntimeError("Pillow was built without WebP support")
    try:
        img = Image.open(io.BytesIO(content))
        w0, h0 = img.size
        limit = 100_000_000 if img.format == "JPEG" else 30_000_000
        if w0 * h0 > limit:
            raise ValueError("Image dimensions are too large; please resize it first.")
        if img.format == "JPEG":  # decode at reduced scale: big phone photos stay cheap in RAM
            img.draft("RGB", (max_width, max(1, round(h0 * max_width / w0))))
        img.load()
        img = ImageOps.exif_transpose(img)
    except ValueError:
        raise
    except Exception as e:
        raise ValueError("Could not read this image file.") from e
    has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    img = img.convert("RGBA" if has_alpha else "RGB")
    max_height = max_width * 16 // 9 + 1  # 1080 -> 1921: portrait posters keep their ratio
    img.thumbnail((max_width, max_height), Image.LANCZOS)

    best = None
    qualities = (82, 74, 66, 58, 50, 42)
    while True:
        for q in qualities:
            buf = io.BytesIO()
            img.save(buf, "WEBP", quality=q, method=4)
            data = buf.getvalue()
            if best is None or len(data) < len(best[0]):
                best = (data, q, img.size)
            if len(data) <= target_bytes:
                return data, {"bytes_in": len(content), "bytes_out": len(data), "quality": q,
                              "width": img.size[0], "height": img.size[1]}
        if img.size[0] <= 480:
            break
        nw = max(480, int(img.size[0] * 0.85))
        img = img.resize((nw, max(1, round(img.size[1] * nw / img.size[0]))), Image.LANCZOS)
        qualities = (70, 60, 50)
    data, q, size = best
    logger.warning("optimize_image: could not reach %d bytes (best %d)", target_bytes, len(data))
    return data, {"bytes_in": len(content), "bytes_out": len(data), "quality": q,
                  "width": size[0], "height": size[1], "over_target": True}


def optimize_upload(content: bytes, content_type: str | None = None, filename: str | None = None,
                    max_width: int | None = None, target_bytes: int | None = None) -> tuple[bytes, str, str, dict]:
    """Route-level helper -> (bytes, 'image/webp', '<name>.webp', info).
    ValueError = unreadable image (route -> 400). If this Pillow build has no WebP
    encoder the original upload is passed through untouched (and an error is logged)."""
    # Preserve supported animated uploads: converting just the first frame
    # would silently remove their existing animation. Signature validation
    # still runs in data_access before Storage accepts the original bytes.
    from PIL import Image
    try:
        with Image.open(io.BytesIO(content)) as image:
            if getattr(image, "is_animated", False):
                return (content, content_type or "application/octet-stream", filename or "image",
                        {"bytes_in": len(content), "bytes_out": len(content),
                         "width": image.width, "height": image.height, "animated": True})
    except Exception as e:
        raise ValueError("Could not read this image file.") from e
    try:
        data, info = optimize_image(content, max_width=max_width, target_bytes=target_bytes)
    except RuntimeError:
        logger.error("optimize_upload: WebP unavailable, storing the original image", exc_info=True)
        return (content, content_type or "application/octet-stream", filename or "image",
                {"bytes_in": len(content), "bytes_out": len(content), "width": None, "height": None})
    base = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", filename or "image") or "image"
    return data, "image/webp", f"{base}.webp", info
