"""
Supabase client — single shared instance for the whole backend.

Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the environment.
The service role key is used because the backend is the only thing that
talks to Supabase (the frontend never receives a Supabase key at all —
see SUPABASE_MIGRATION.md for why). Row Level Security is enabled on every
table with no permissive policies, so the service role key is the only
key that can read/write anything; that's intentional defense in depth.

NEVER import this module before environment variables are loaded. In
production (Render) the env vars are injected by the platform. Locally,
`load_dotenv()` picks them up from a `.env` file next to this module.
"""
import os

from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

_client = None
_async_client = None


def get_client():
    """Lazily create and cache the Supabase client.

    Lazy + cached so importing this module never fails at import time
    (e.g. during `pytest` collection or `python -m py_compile`) — the
    error only surfaces when something actually tries to talk to the DB,
    with a clear message instead of a bare KeyError/AttributeError.
    """
    global _client
    if _client is None:
        if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set as "
                "environment variables. Copy backend/.env.example to "
                "backend/.env and fill them in (see SUPABASE_MIGRATION.md)."
            )
        from supabase import create_client

        _client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    return _client


async def get_async_client():
    """Lazily create and cache the async Supabase client.

    Concurrency fix (Sept 2026 load test) — `get_client()` above returns
    supabase-py's sync client, and FastAPI runs plain `def` route handlers
    that call it in a small shared thread pool (default ~cpu_count()+4
    threads). Under concurrent load, every in-flight request that's
    waiting on a Supabase network round trip occupies one of those threads
    for the full round trip, so the pool saturates fast and everything
    else queues behind it. `create_async_client` returns a real async
    client (httpx-based, via postgrest-py's AsyncPostgrestClient) — used
    by `async def` route handlers so a slow Supabase call suspends on the
    event loop instead of blocking a thread. This does NOT replace
    `get_client()`: every other route (admin CRUD, auth, etc.) is
    low-traffic and stays on the sync client deliberately, to keep this
    change scoped to the endpoints the load test actually showed
    degrading (see PRODUCTION_AUDIT_REPORT.md-style load-test notes).
    """
    global _async_client
    if _async_client is None:
        if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set as "
                "environment variables. Copy backend/.env.example to "
                "backend/.env and fill them in (see SUPABASE_MIGRATION.md)."
            )
        from supabase import create_async_client

        _async_client = await create_async_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    return _async_client


class SupabaseUnavailableError(Exception):
    """Raised when a Supabase call fails (network, outage, bad credentials).

    Routes catch this and turn it into a clean 503 instead of a raw 500,
    per the "gracefully handle database unavailable" requirement.
    """
