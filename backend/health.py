"""
backend/health.py  (W4 - health endpoints for uptime monitors)

ONE entry point:   app.include_router(health.router)

    GET /healthz        process is up. NO database, no auth, ~1 ms. Use this for the 10-minute wake-up ping.
    GET /healthz/db     one trivial Supabase query (venues.id LIMIT 1). Result cached for a short time so a
                        monitor + refresh-happy humans can't turn into a query flood. Also what keeps a free
                        Supabase project from being paused for inactivity.
    GET /healthz/ip     shows which IP header the rate limiter sees for YOUR request (diagnostic).
    GET /healthz/stats  counters from protection.py (only if that module is present).

Also exposes `api_health()` so the existing /api/health route (polled by the frontend BootGate on every app
open) can share the cached DB check instead of querying Supabase once per visitor.

Works standalone: imports db / protection lazily and degrades gracefully if either is missing.
Env: RATE_HEALTH_DB_TIMEOUT_S (8), RATE_HEALTH_DB_CACHE_S (30)
"""

from __future__ import annotations

import asyncio
import logging
import os
import time

import anyio
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger("ssn-campus-nav.health")
router = APIRouter()

_STARTED = time.time()
_NO_STORE = {"Cache-Control": "no-store"}
_db_state: dict = {"ok": None, "ms": None, "at": 0.0, "task": None}


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _query_supabase() -> None:
    from db import get_client  # lazy: keeps this module importable without Supabase configured

    get_client().table("venues").select("id").limit(1).execute()


async def _probe() -> None:
    t0 = time.monotonic()
    try:
        await asyncio.wait_for(anyio.to_thread.run_sync(_query_supabase), timeout=_env_float("RATE_HEALTH_DB_TIMEOUT_S", 8))
        _db_state.update(ok=True, ms=round((time.monotonic() - t0) * 1000))
    except Exception as exc:  # noqa: BLE001 - any failure means "degraded"; details go to the log only
        _db_state.update(ok=False, ms=round((time.monotonic() - t0) * 1000))
        logger.warning("healthz/db probe failed: %s: %s", type(exc).__name__, exc)
    finally:
        _db_state["at"] = time.monotonic()


async def db_status() -> dict:
    """Cached DB probe (shared by /healthz/db and /api/health). Concurrent callers share one probe."""
    age = time.monotonic() - _db_state["at"]
    if _db_state["ok"] is None or age > _env_float("RATE_HEALTH_DB_CACHE_S", 30):
        task = _db_state["task"]
        if task is None or task.done():
            task = asyncio.ensure_future(_probe())
            _db_state["task"] = task
        await asyncio.shield(task)
    return {"ok": bool(_db_state["ok"]), "db_ms": _db_state["ms"]}


async def api_health() -> JSONResponse:
    """Drop-in body for the existing GET /api/health (same 200/503 contract the BootGate relies on)."""
    st = await db_status()
    if st["ok"]:
        return JSONResponse({"status": "ok"}, headers=_NO_STORE)
    return JSONResponse({"detail": "Service temporarily unavailable. Please try again shortly."},
                        status_code=503, headers=_NO_STORE)


@router.get("/healthz")
async def healthz():
    return JSONResponse(
        {"status": "ok", "uptime_s": round(time.time() - _STARTED),
         "commit": (os.environ.get("RENDER_GIT_COMMIT") or "")[:7] or None},
        headers=_NO_STORE,
    )


@router.get("/healthz/db")
async def healthz_db():
    st = await db_status()
    if st["ok"]:
        return JSONResponse({"status": "ok", "db": "ok", "db_ms": st["db_ms"]}, headers=_NO_STORE)
    return JSONResponse({"status": "degraded", "db": "unreachable", "db_ms": st["db_ms"]},
                        status_code=503, headers=_NO_STORE)


@router.get("/healthz/ip")
async def healthz_ip(request: Request):
    """Only echoes the caller's own request metadata."""
    seen = {
        "cf-connecting-ip": request.headers.get("cf-connecting-ip"),
        "x-forwarded-for": request.headers.get("x-forwarded-for"),
        "true-client-ip": request.headers.get("true-client-ip"),
        "client.host": request.client.host if request.client else None,
    }
    try:
        from protection import client_ip

        chosen = client_ip(request)
    except ImportError:
        chosen = None
    return JSONResponse({"seen": seen, "chosen": chosen, "mode": os.environ.get("RATE_IP_MODE", "auto")},
                        headers=_NO_STORE)


@router.get("/healthz/stats")
async def healthz_stats():
    try:
        from protection import stats
    except ImportError:
        return JSONResponse({"detail": "protection module not installed"}, status_code=404, headers=_NO_STORE)
    return JSONResponse(stats(), headers=_NO_STORE)
