"""
backend/protection.py  (W4 - backend protection)

ONE entry point:   protection.install(app)

Call it right after `app = FastAPI(...)` and BEFORE the CORS middleware is
added, so 413/429 responses created here still get CORS headers (Starlette
runs the middleware added LAST as the outermost one).

What install() adds
    * GZip for API responses (level 5, skips /static)
    * request body size limit (64 KB default; 6 MB for the two image-upload routes)
    * `Cache-Control: no-store` on /api/admin/*
    * a handler that turns `Throttled` into a typed JSON error + Retry-After

What else this module offers (no install needed)
    * limiter(...)         token-bucket FastAPI dependency (in-memory, single instance)
    * cached_json(...)     micro-cache + ETag/304 + pre-gzipped bodies + stale-if-error
    * cache_headers(...)   Cache-Control only (for endpoints that are already cached elsewhere)
    * copilot_classify()   guarded Copilot call: cache, coalescing, timeout, concurrency cap
    * invalidate(prefix)   drop micro-cache entries (call after admin writes if you want instant)
    * stats()              counters for /healthz/stats

Everything is stdlib + FastAPI/Starlette/anyio. It does not import data_access,
db or auth, so it works standalone.

Typed error body (HTTP 429 or 503):
    {"detail": "<friendly text>", "error": "rate_limited"|"busy"|"disabled", "retry_after": <seconds>}
`detail` stays a plain string so existing frontend code that shows `detail.detail` keeps working.

ROUTE -> CACHE TABLE (server = seconds kept in this process; max-age = browser/SW/CDN)
  route                               policy    server  max-age  swr    note
  GET /api/locations                  static    300     300      3600   key = category
  GET /api/locations/search?q=        search    120     120      600    key = normalized q (LRU bounded)
  GET /api/locations/{id}             static    -       300      3600   already cached in data_access; headers only
  GET /api/locations/{id}/menu        menu      60      60       300    404s are never cached
  GET /api/events                     events    30      30       120    key = fest+date
  GET /api/events/{id}                events    -       30       120    already cached in data_access; headers only
  GET /api/events/{id}/qr             qr        -       86400    604800 deterministic PNG
  GET /api/road-segments              closures  10      10       30     closures must propagate fast
  GET /api/graph                      graph     3600    600      86400  changes only on redeploy
  GET /api/route                      (none)    -       -        -      live GPS; W1 moves routing client-side
  GET /api/health, /healthz*          no-store
  POST/PATCH/DELETE, /api/admin/*     no-store
Every cached_json response carries an ETag, so repeat visits cost a 304 with no body.
These are offered policies, not endpoint bindings. The shared endpoint cache,
limiter and Copilot guard patches were not supplied; see docs/MERGE_NOTES.md.

Env vars (all optional)
  RATE_DISABLED=1               turn off every limiter (load tests only)
  RATE_IP_MODE=auto|cf|xff_last|xff_first|client   how the caller IP is found (default auto)
  RATE_<NAME>_PER_MIN / RATE_<NAME>_BURST          per-limiter override, NAME in:
        LOGIN, LOGIN_GLOBAL, FEEDBACK, ANALYTICS, COPILOT, COPILOT_GLOBAL
  RATE_BODY_MAX_BYTES (65536)   RATE_UPLOAD_MAX_BYTES (6291456)
  RATE_CACHE_DISABLED=1         bypass the micro-cache (debugging)
  RATE_CACHE_MAX_ENTRIES (300)  RATE_CACHE_MAX_BYTES (8388608)
  RATE_ORIGIN_THREADS (8)       max threads used for cache-miss Supabase reads
  RATE_ORIGIN_MISS_PER_MIN (300) RATE_ORIGIN_MISS_BURST (60)   global cap on cache-miss reads
  RATE_ORIGIN_TIMEOUT_S (10)    wait for a cache-miss read before serving stale / 503
  COPILOT_DISABLED=1            kill switch -> typed 503 "disabled"
  COPILOT_MAX_CONCURRENCY (2)   COPILOT_MAX_QUEUE (20)   COPILOT_QUEUE_WAIT_S (2)
  COPILOT_TIMEOUT_S (5)         COPILOT_MAX_MESSAGE_CHARS (300)
  COPILOT_CACHE_TTL_S (600)     COPILOT_CACHE_MAX (500)
  COPILOT_LOCATIONS_TTL_S (300) COPILOT_LOCATIONS_TIMEOUT_S (4)
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import logging
import math
import os
import re
import time
from collections import Counter, OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, NamedTuple

import anyio
from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException
from starlette.middleware.gzip import GZipMiddleware

logger = logging.getLogger("ssn-campus-nav.protection")

__all__ = [
    "POLICIES", "Throttled", "analytics_limit", "cache_header_value", "cache_headers", "cached_json",
    "client_ip", "copilot_classify", "copilot_global_limit", "copilot_ip_limit", "feedback_limit",
    "install", "invalidate", "limiter", "login_global_limit", "login_ip_limit", "stats",
]


# --------------------------------------------------------------------------- env helpers
def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return float(default)


def _env_int(name: str, default: int) -> int:
    return int(_env_float(name, default))


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


_STATS: Counter = Counter()


def _silence(task: asyncio.Future) -> None:
    """Mark a background task's exception as retrieved (avoids 'never retrieved' log noise)."""
    if not task.cancelled():
        task.exception()


# --------------------------------------------------------------------------- typed errors
class Throttled(Exception):
    """Raised by limiters / the Copilot guard. Rendered as typed JSON by install()."""

    def __init__(self, code: str, message: str, retry_after: float = 1.0, status_code: int = 429):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retry_after = retry_after
        self.status_code = status_code


async def _throttled_handler(request: Request, exc: Throttled) -> JSONResponse:
    retry = max(1, math.ceil(exc.retry_after))
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.message, "error": exc.code, "retry_after": retry},
        headers={"Retry-After": str(retry), "Cache-Control": "no-store"},
    )


# --------------------------------------------------------------------------- client IP
def client_ip(request: Request) -> str:
    """Best-effort caller IP, for rate limiting only (never an auth decision).

    auto (default): Cloudflare's CF-Connecting-IP if present, else the LAST X-Forwarded-For entry
    (what auth.py already does). If every user shows the same IP, check GET /healthz/ip from a
    phone on mobile data and switch RATE_IP_MODE.
    """
    mode = os.environ.get("RATE_IP_MODE", "auto").strip().lower()
    h = request.headers
    if mode == "cf":
        v = h.get("cf-connecting-ip")
        if v:
            return v.strip()
    fwd = h.get("x-forwarded-for")
    if fwd and mode in ("auto", "xff_last", "xff_first"):
        parts = [p.strip() for p in fwd.split(",") if p.strip()]
        if parts:
            return parts[0] if mode == "xff_first" else parts[-1]
    return request.client.host if request.client else "unknown"


# --------------------------------------------------------------------------- token bucket
class TokenBucketLimiter:
    """Classic token bucket per key. Runs on the event loop thread only (no lock needed)."""

    def __init__(self, name: str, per_min: float, burst: int, scope: str = "ip", max_keys: int = 5000):
        env = name.upper().replace("-", "_")
        self.name = name
        self.per_min = _env_float(f"RATE_{env}_PER_MIN", per_min)
        self.burst = max(1, _env_int(f"RATE_{env}_BURST", burst))
        self.scope = scope
        self.max_keys = max_keys
        self.denied = 0
        self._b: OrderedDict[str, list[float]] = OrderedDict()  # key -> [tokens, last_ts]

    def take(self, key: str, cost: float = 1.0) -> tuple[bool, float]:
        """Returns (allowed, seconds_until_allowed)."""
        now = time.monotonic()
        rate = self.per_min / 60.0
        b = self._b.get(key)
        if b is None:
            if len(self._b) >= self.max_keys:
                self._b.popitem(last=False)  # LRU eviction: bounded memory under an IP flood
            b = [float(self.burst), now]
            self._b[key] = b
        else:
            b[0] = min(float(self.burst), b[0] + (now - b[1]) * rate)
            b[1] = now
            self._b.move_to_end(key)
        if b[0] >= cost:
            b[0] -= cost
            return True, 0.0
        self.denied += 1
        return False, ((cost - b[0]) / rate) if rate > 0 else 60.0


LIMITERS: dict[str, TokenBucketLimiter] = {}


def limiter(name: str, *, per_min: float, burst: int, scope: str = "ip",
            message: str | None = None, code: str = "rate_limited") -> Callable:
    """FastAPI dependency factory.  `Depends(limiter("feedback", per_min=2, burst=20))`.

    scope="ip" -> one bucket per caller IP; scope="global" -> one bucket for the whole process.
    Async on purpose: it runs on the event loop instead of hopping through the thread pool.
    """
    lim = TokenBucketLimiter(name, per_min, burst, scope)
    LIMITERS[name] = lim
    text = message or "Too many requests. Please slow down and try again shortly."

    async def _dependency(request: Request) -> None:
        if _env_flag("RATE_DISABLED"):
            return
        ok, wait = lim.take(client_ip(request) if scope == "ip" else "*")
        if not ok:
            _STATS[f"throttled.{name}"] += 1
            raise Throttled(code, text, wait, 429)

    _dependency.limiter = lim  # type: ignore[attr-defined]
    return _dependency


# Ready-made dependencies for the write endpoints. Defaults are conservative for 0.1 CPU:
# one bcrypt check costs ~270 ms of a full CPU, i.e. ~2.7 s at 0.1 CPU.
login_ip_limit = limiter("login", per_min=3, burst=5,
                         message="Too many login attempts. Please wait a minute and try again.")
login_global_limit = limiter("login_global", per_min=10, burst=10, scope="global",
                             message="Login is busy right now. Please try again in a minute.")
feedback_limit = limiter("feedback", per_min=2, burst=20)      # = the old 20 per 10 min
analytics_limit = limiter("analytics", per_min=10, burst=60)   # old: 100 per 10 min
copilot_ip_limit = limiter("copilot", per_min=6, burst=15,
                           message="You're asking quickly - give Campus Copilot a few seconds and try again.")
copilot_global_limit = limiter("copilot_global", per_min=600, burst=60, scope="global", code="busy",
                               message="Campus Copilot is busy right now. Please try again in a few seconds.")


# --------------------------------------------------------------------------- ASGI middleware
def _json_413(max_bytes: int) -> JSONResponse:
    return JSONResponse(status_code=413, content={"detail": f"Request body too large (max {max_bytes} bytes)."})


_UPLOAD_PATH = re.compile(r"^/api/admin/(events/[^/]+/images|locations/[^/]+/menu)/?$")


class BodyLimitMiddleware:
    """Rejects oversized bodies early: by Content-Length, and by counting bytes of chunked bodies."""

    def __init__(self, app, default_max: int, upload_max: int):
        self.app = app
        self.default_max = default_max
        self.upload_max = upload_max

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":  # cheap request counters for /healthz/stats and the k6 "no backend calls" checks
            _STATS["http.total"] += 1
            if scope["path"].startswith("/api/"):
                _STATS["http.api"] += 1
        if scope["type"] != "http" or scope["method"] in ("GET", "HEAD", "OPTIONS"):
            return await self.app(scope, receive, send)
        limit = self.upload_max if _UPLOAD_PATH.match(scope["path"]) else self.default_max
        for k, v in scope["headers"]:
            if k == b"content-length":
                try:
                    too_big = int(v) > limit
                except ValueError:
                    too_big = True
                if too_big:
                    _STATS["body_too_large"] += 1
                    return await _json_413(limit)(scope, receive, send)
                break
        seen = 0

        async def limited_receive():
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > limit:
                    _STATS["body_too_large"] += 1
                    raise HTTPException(status_code=413, detail=f"Request body too large (max {limit} bytes).")
            return msg

        return await self.app(scope, limited_receive, send)


class _SelectiveGZip:
    """GZipMiddleware for API/JSON; skip /static (PNGs are already compressed)."""

    def __init__(self, app, minimum_size: int = 700, compresslevel: int = 5):
        self.app = app
        self.gz = GZipMiddleware(app, minimum_size=minimum_size, compresslevel=compresslevel)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and not scope["path"].startswith("/static/"):
            return await self.gz(scope, receive, send)
        return await self.app(scope, receive, send)


class _AdminNoStore:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/admin"):
            return await self.app(scope, receive, send)

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                # Private admin responses must not inherit a public cache policy.
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"cache-control"]
                headers.append((b"cache-control", b"no-store"))
                message = {**message, "headers": headers}
            await send(message)

        return await self.app(scope, receive, send_wrapper)


def install(app) -> None:
    """The single entry point. Idempotent."""
    if getattr(app.state, "protection_installed", False):
        return
    app.state.protection_installed = True
    app.add_exception_handler(Throttled, _throttled_handler)
    # add_middleware() prepends, so add innermost first: NoStore -> GZip -> BodyLimit (outermost of ours)
    app.add_middleware(_AdminNoStore)
    app.add_middleware(_SelectiveGZip, minimum_size=700, compresslevel=5)
    app.add_middleware(
        BodyLimitMiddleware,
        default_max=_env_int("RATE_BODY_MAX_BYTES", 64 * 1024),
        upload_max=_env_int("RATE_UPLOAD_MAX_BYTES", 6 * 1024 * 1024),
    )
    logger.info(
        "protection installed: ip_mode=%s body_max=%d upload_max=%d limiters=%s",
        os.environ.get("RATE_IP_MODE", "auto"), _env_int("RATE_BODY_MAX_BYTES", 64 * 1024),
        _env_int("RATE_UPLOAD_MAX_BYTES", 6 * 1024 * 1024),
        {n: f"{lim.per_min:g}/min burst {lim.burst}" for n, lim in LIMITERS.items()},
    )


# --------------------------------------------------------------------------- micro-cache + ETag
class Policy(NamedTuple):
    server_ttl: float   # seconds the serialized body is reused in this process
    max_age: int        # Cache-Control max-age (browser / service worker / CDN)
    swr: int            # stale-while-revalidate
    stale_error: int    # stale-if-error, and how long we keep a stale copy to survive Supabase outages


POLICIES: dict[str, Policy] = {
    "static":   Policy(300, 300, 3600, 86400),
    "search":   Policy(120, 120, 600, 3600),
    "menu":     Policy(60, 60, 300, 3600),
    "events":   Policy(30, 30, 120, 3600),
    "closures": Policy(10, 10, 30, 3600),
    "graph":    Policy(3600, 600, 86400, 86400),
    "qr":       Policy(0, 86400, 604800, 604800),
}


def cache_header_value(policy: str) -> str:
    p = POLICIES[policy]
    return f"public, max-age={p.max_age}, stale-while-revalidate={p.swr}, stale-if-error={p.stale_error}"


def cache_headers(policy: str) -> dict[str, str]:
    """Headers dict for FileResponse(headers=...) or JSONResponse."""
    return {"Cache-Control": cache_header_value(policy), "Vary": "Accept-Encoding"}


@dataclass
class _Entry:
    body: bytes
    gz: bytes | None
    etag: str
    fresh_until: float
    stale_until: float


_CACHE: OrderedDict[str, _Entry] = OrderedDict()
_CACHE_BYTES = 0
_INFLIGHT: dict[str, asyncio.Future] = {}
_origin_limiter: anyio.CapacityLimiter | None = None
_miss_bucket = TokenBucketLimiter("origin_miss", per_min=300, burst=60, scope="global")


def _origin_threads() -> anyio.CapacityLimiter:
    global _origin_limiter
    if _origin_limiter is None:  # created lazily: anyio needs a running loop
        _origin_limiter = anyio.CapacityLimiter(max(1, _env_int("RATE_ORIGIN_THREADS", 8)))
    return _origin_limiter


def _cache_put(key: str, ent: _Entry) -> None:
    global _CACHE_BYTES
    old = _CACHE.pop(key, None)
    if old:
        _CACHE_BYTES -= len(old.body) + len(old.gz or b"")
    _CACHE[key] = ent
    _CACHE_BYTES += len(ent.body) + len(ent.gz or b"")
    max_entries = _env_int("RATE_CACHE_MAX_ENTRIES", 300)
    max_bytes = _env_int("RATE_CACHE_MAX_BYTES", 8 * 1024 * 1024)
    while _CACHE and (len(_CACHE) > max_entries or max_bytes < _CACHE_BYTES):
        _, ev = _CACHE.popitem(last=False)
        _CACHE_BYTES -= len(ev.body) + len(ev.gz or b"")


def invalidate(prefix: str = "") -> int:
    """Drop micro-cache entries whose key starts with `prefix` ('' = all). Returns the count."""
    global _CACHE_BYTES
    n = 0
    for k in [k for k in _CACHE if k.startswith(prefix)]:
        ev = _CACHE.pop(k)
        _CACHE_BYTES -= len(ev.body) + len(ev.gz or b"")
        n += 1
    return n


def _build_entry(payload: Any, pol: Policy) -> _Entry:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")
    gz = gzip.compress(body, 6, mtime=0) if len(body) >= 700 else None
    now = time.monotonic()
    etag = 'W/"' + hashlib.sha1(body).hexdigest()[:16] + '"'  # noqa: S324 - ETag, not security
    return _Entry(body, gz, etag, now + pol.server_ttl, now + pol.server_ttl + pol.stale_error)


def _respond(request: Request, ent: _Entry, policy: str, stale: bool = False) -> Response:
    headers = cache_headers(policy)
    headers["ETag"] = ent.etag
    if stale:
        headers["Cache-Control"] = "public, max-age=5"
        headers["X-Cache"] = "STALE"
    inm = request.headers.get("if-none-match")
    if inm and (inm.strip() == "*" or ent.etag in [t.strip() for t in inm.split(",")]):
        _STATS["cache.304"] += 1
        return Response(status_code=304, headers=headers)
    body = ent.body
    if ent.gz is not None and "gzip" in request.headers.get("accept-encoding", "").lower():
        body = ent.gz
        headers["Content-Encoding"] = "gzip"
    return Response(content=body, media_type="application/json", headers=headers)


async def _run_producer(producer: Callable) -> Any:
    if asyncio.iscoroutinefunction(producer):
        return await producer()
    return await anyio.to_thread.run_sync(producer, limiter=_origin_threads())


async def _fill(key: str, producer: Callable, pol: Policy) -> _Entry:
    try:
        ent = _build_entry(await _run_producer(producer), pol)
        _cache_put(key, ent)
        return ent
    finally:
        _INFLIGHT.pop(key, None)


def _miss_bucket_take() -> bool:
    _miss_bucket.per_min = _env_float("RATE_ORIGIN_MISS_PER_MIN", 300)
    _miss_bucket.burst = _env_int("RATE_ORIGIN_MISS_BURST", 60)
    return _miss_bucket.take("*")[0]


async def cached_json(request: Request, key: str, policy: str, producer: Callable) -> Response:
    """Serve `producer()` (sync fn or `async def`) through the micro-cache.

    * one Supabase read per key per TTL, however many users ask (concurrent misses are coalesced)
    * body is serialized + gzipped once; ETag -> 304
    * if the read fails or times out and an older copy exists, the older copy is served (X-Cache: STALE)
    * HTTPException (e.g. 404) from the producer passes through and is never cached
    * `key` must be low-cardinality: normalize/cap user input before putting it in the key
    """
    pol = POLICIES[policy]
    if _env_flag("RATE_CACHE_DISABLED"):
        return _respond(request, _build_entry(await _run_producer(producer), pol), policy)
    now = time.monotonic()
    ent = _CACHE.get(key)
    if ent is not None:
        _CACHE.move_to_end(key)
        if now < ent.fresh_until:
            _STATS["cache.hit"] += 1
            return _respond(request, ent, policy)
    stale = ent if (ent is not None and now < ent.stale_until) else None

    task = _INFLIGHT.get(key)
    if task is None:
        if not _miss_bucket_take():
            _STATS["origin.capped"] += 1
            if stale:
                return _respond(request, stale, policy, stale=True)
            raise Throttled("busy", "The campus service is very busy. Please retry in a few seconds.", 5, 503)
        _STATS["cache.miss"] += 1
        task = asyncio.ensure_future(_fill(key, producer, pol))
        task.add_done_callback(_silence)
        _INFLIGHT[key] = task
    try:
        fresh = await asyncio.wait_for(asyncio.shield(task), timeout=_env_float("RATE_ORIGIN_TIMEOUT_S", 10))
        return _respond(request, fresh, policy)
    except HTTPException:
        raise
    except Exception as exc:
        if stale:
            _STATS["cache.stale_served"] += 1
            logger.warning("serving stale %s after %s: %s", key, type(exc).__name__, exc)
            return _respond(request, stale, policy, stale=True)
        if isinstance(exc, asyncio.TimeoutError):
            raise Throttled("busy", "The campus service is slow right now. Please retry shortly.", 5, 503) from exc
        raise


# --------------------------------------------------------------------------- Copilot guard
class _TTL:
    """Tiny bounded TTL map (event-loop thread only)."""

    def __init__(self, ttl: float, max_entries: int):
        self.ttl, self.max = ttl, max_entries
        self._d: OrderedDict[str, tuple[float, Any]] = OrderedDict()

    def get(self, k: str):
        v = self._d.get(k)
        if v is None:
            return None
        if time.monotonic() >= v[0]:
            self._d.pop(k, None)
            return None
        self._d.move_to_end(k)
        return v[1]

    def set(self, k: str, val: Any) -> None:
        self._d[k] = (time.monotonic() + self.ttl, val)
        self._d.move_to_end(k)
        while len(self._d) > self.max:
            self._d.popitem(last=False)

    def __len__(self) -> int:
        return len(self._d)


_C_CACHE: _TTL | None = None
_C_INFLIGHT: dict[str, asyncio.Future] = {}
_C_SEM: asyncio.Semaphore | None = None
_C_THREADS: anyio.CapacityLimiter | None = None
_C_WAITING = 0
_LOC: dict[str, Any] = {"data": None, "exp": 0.0, "task": None, "baked": None}


def _busy(retry: float = 3) -> Throttled:
    _STATS["copilot.busy"] += 1
    return Throttled("busy", "Campus Copilot is busy right now. Please try again in a few seconds.", retry, 503)


def _copilot_state():
    global _C_CACHE, _C_SEM, _C_THREADS
    if _C_CACHE is None:
        _C_CACHE = _TTL(_env_float("COPILOT_CACHE_TTL_S", 600), _env_int("COPILOT_CACHE_MAX", 500))
    if _C_SEM is None:
        n = max(1, _env_int("COPILOT_MAX_CONCURRENCY", 2))
        _C_SEM = asyncio.Semaphore(n)
        _C_THREADS = anyio.CapacityLimiter(n)  # Copilot never competes with the default 40-thread pool
    return _C_CACHE, _C_SEM, _C_THREADS


def _baked_locations() -> list | None:
    if _LOC["baked"] is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "locations.json")
        try:
            with open(path, encoding="utf-8") as f:
                _LOC["baked"] = json.load(f)
        except (OSError, ValueError):
            _LOC["baked"] = []
    return _LOC["baked"] or None


async def _refresh_locations(get_locations: Callable) -> list:
    try:
        data = await anyio.to_thread.run_sync(get_locations, limiter=_origin_threads())
    except Exception:
        if _LOC["data"] is not None:
            _LOC["exp"] = time.monotonic() + 15  # back off, keep serving the old list
        raise
    _LOC["data"], _LOC["exp"] = data, time.monotonic() + _env_float("COPILOT_LOCATIONS_TTL_S", 300)
    return data


async def _get_locations(get_locations: Callable) -> list:
    """Venue list for the classifier: cached 5 min, coalesced, falls back to stale, then data/locations.json.
    (Before this, EVERY chat message cost one Supabase round trip.)"""
    if _LOC["data"] is not None and time.monotonic() < _LOC["exp"]:
        return _LOC["data"]
    task = _LOC["task"]
    if task is None or task.done():
        task = asyncio.ensure_future(_refresh_locations(get_locations))
        task.add_done_callback(_silence)
        _LOC["task"] = task
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout=_env_float("COPILOT_LOCATIONS_TIMEOUT_S", 4))
    except Exception:
        if _LOC["data"] is not None:
            return _LOC["data"]
        baked = _baked_locations()
        if baked:
            logger.warning("Copilot using data/locations.json fallback (Supabase unavailable)")
            return baked
        raise


def _default_norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", text.lower())).strip()


def _with_raw(result: Any, message: str) -> Any:
    """classify() echoes the caller's text in `query_text`; a cached answer must echo THIS caller's text."""
    if isinstance(result, dict) and "query_text" in result and result["query_text"] != message:
        return {**result, "query_text": message}
    return result


async def _copilot_compute(ckey: str, msg: str, context: dict | None, classify: Callable, get_locations: Callable):
    global _C_WAITING
    cache, sem, threads = _copilot_state()
    try:
        _C_WAITING += 1
        try:
            await asyncio.wait_for(sem.acquire(), timeout=_env_float("COPILOT_QUEUE_WAIT_S", 2))
        except asyncio.TimeoutError:
            raise _busy() from None
        finally:
            _C_WAITING -= 1
        try:  # semaphore is held; it is released when the WORKER THREAD finishes, even after a timeout
            locations = await _get_locations(get_locations)
            worker = asyncio.ensure_future(
                anyio.to_thread.run_sync(classify, msg, locations, context, limiter=threads))
        except BaseException:
            sem.release()
            raise
        worker.add_done_callback(lambda f: (sem.release(), _silence(f)))
        try:
            result = await asyncio.wait_for(asyncio.shield(worker), timeout=_env_float("COPILOT_TIMEOUT_S", 5))
        except asyncio.TimeoutError:
            raise _busy() from None
        _STATS["copilot.computed"] += 1
        cache.set(ckey, result)
        return result
    finally:
        _C_INFLIGHT.pop(ckey, None)


async def copilot_classify(message: str, context: dict | None, *, classify: Callable,
                           get_locations: Callable, normalize: Callable[[str], str] | None = None):
    """Guarded replacement for `_copilot.classify(...)` inside the route.

    cache (normalized text) -> coalesce identical in-flight questions -> bounded queue ->
    semaphore -> classify in a worker thread with a timeout. Raises Throttled("busy") when saturated.
    The classifier is rule-based (utils/copilot.py), so there is no LLM quota to burn; the limits protect CPU.
    """
    if _env_flag("COPILOT_DISABLED"):
        raise Throttled("disabled", "Campus Copilot is paused for now. Search and directions still work.", 60, 503)
    cache, _, _ = _copilot_state()
    msg = (message or "")[: _env_int("COPILOT_MAX_MESSAGE_CHARS", 300)]  # 20k chars cost ~200 ms in difflib
    ctx_key = json.dumps(context, sort_keys=True, default=str)[:200] if context else ""
    ckey = (normalize or _default_norm)(msg) + "|" + ctx_key
    hit = cache.get(ckey)
    if hit is not None:
        _STATS["copilot.cache_hit"] += 1
        return _with_raw(hit, message)
    task = _C_INFLIGHT.get(ckey)
    if task is None:
        if _env_int("COPILOT_MAX_QUEUE", 20) <= _C_WAITING:
            raise _busy()
        task = asyncio.ensure_future(_copilot_compute(ckey, msg, context, classify, get_locations))
        task.add_done_callback(_silence)
        _C_INFLIGHT[ckey] = task
    try:
        result = await asyncio.wait_for(
            asyncio.shield(task),
            timeout=_env_float("COPILOT_TIMEOUT_S", 5) + _env_float("COPILOT_QUEUE_WAIT_S", 2) + 1)
    except asyncio.TimeoutError:
        raise _busy() from None
    return _with_raw(result, message)


# --------------------------------------------------------------------------- stats
def stats() -> dict:
    return {
        "counters": dict(_STATS),
        "limiters": {n: {"per_min": lim.per_min, "burst": lim.burst, "keys": len(lim._b), "denied": lim.denied}
                     for n, lim in LIMITERS.items()},
        "micro_cache": {"entries": len(_CACHE), "bytes": _CACHE_BYTES, "inflight": len(_INFLIGHT)},
        "copilot": {"cache_entries": len(_C_CACHE) if _C_CACHE else 0, "waiting": _C_WAITING,
                    "inflight": len(_C_INFLIGHT), "locations_cached": _LOC["data"] is not None},
    }
