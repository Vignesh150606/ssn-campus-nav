"""
Admin authentication — bcrypt password hashing + JWT session tokens.

Two roles now: 'superadmin' (full access, can manage Fest Admin accounts
and approve/reject fest schedule submissions) and 'festadmin' (can only
submit/edit their own fest schedule entries). Each admin has their own row
in the `admins` table (username + bcrypt hash + role + disabled flag).
Logging in returns a signed JWT; every admin route requires that JWT in an
`Authorization: Bearer <token>` header. See require_role /
get_current_active_admin below for how routes enforce which role can reach
them, and how a disabled Fest Admin is cut off immediately rather than
waiting out their token's remaining lifetime.

JWT_SECRET must be set in the environment in production. A random one is
generated at import time as a local-dev fallback ONLY — it changes every
restart, which means tokens stop working across restarts, which is
exactly the nudge a developer needs to go set a real secret before
deploying.
"""
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from passlib.context import CryptContext

from db import SupabaseUnavailableError, get_client

logger = logging.getLogger("ssn-campus-nav.auth")

JWT_SECRET = os.environ.get("JWT_SECRET") or secrets.token_hex(32)
JWT_ALGORITHM = "HS256"
JWT_EXPIRES_HOURS = int(os.environ.get("JWT_EXPIRES_HOURS", "12"))

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
_bearer = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def generate_password(length: int = 14) -> str:
    """A random password for the "generate Fest Admin credentials" flow —
    used when a Super Admin creates an account without typing a password
    themselves. Alphanumeric only (no symbols) so it's easy to read aloud
    or retype from a screenshot; length 14 over a 62-character alphabet is
    ~83 bits of entropy, comfortably more than bcrypt's own effective
    strength needs."""
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def create_access_token(admin_id: str, username: str, role: str) -> str:
    payload = {
        "sub": admin_id,
        "username": username,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRES_HOURS),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError as e:
        raise HTTPException(status_code=401, detail="Session expired — please log in again.") from e
    except jwt.InvalidTokenError as e:
        raise HTTPException(status_code=401, detail="Invalid authentication token.") from e


# ---------------------------------------------------------------------------
# Production audit Part 9 (security review) — login had no brute-force
# protection at all before this: unlimited password guesses against any
# known username, with no delay or lockout. Simple in-memory sliding-
# window lockout, keyed by username (not IP — a proxied/shared-network
# deployment makes IP a weaker signal here, and locking the *account*
# stops a credential-stuffing attempt regardless of what IP it's coming
# from). In-memory means this resets on a backend restart and isn't
# shared across multiple server instances if this is ever horizontally
# scaled — an acceptable trade-off for this project's scale, but worth
# knowing if that ever changes (a Redis-backed counter would be the next
# step, not a rewrite of this).
# ---------------------------------------------------------------------------
_failed_login_attempts: dict = {}
MAX_LOGIN_ATTEMPTS = 5
LOGIN_LOCKOUT_WINDOW_MINUTES = 15

# Item 7 fix — used only to burn the same bcrypt-verify time for a
# username that doesn't exist as a real lookup would spend on a wrong
# password. Previously `not rows or not verify_password(...)` short-
# circuited on `not rows`, so a nonexistent username returned after just
# the DB lookup while a real-username-wrong-password attempt additionally
# paid bcrypt's deliberately-slow hash comparison — a measurable timing
# gap that reveals which usernames exist even though the error message
# returned is identical either way. Hashed once at import time (not per
# request); the actual value is irrelevant since nothing is ever meant to
# match it.
_DUMMY_PASSWORD_HASH = None


def _dummy_password_hash() -> str:
    global _DUMMY_PASSWORD_HASH
    if _DUMMY_PASSWORD_HASH is None:
        _DUMMY_PASSWORD_HASH = hash_password(secrets.token_hex(16))
    return _DUMMY_PASSWORD_HASH


def _prune_failed_login_attempts() -> None:
    """Item 8 fix — evict every username whose entire attempt history has
    aged out of the lockout window, not just the one being checked this
    call. Previously only the just-checked username's list was filtered
    (and even then, an emptied list stayed in the dict as `username: []`
    forever), so a username tried once and never again — a typo, a single
    probe, a scan across many usernames looking for valid ones — left a
    permanent entry with nothing to ever clean it up. Login volume on an
    admin-only dashboard is low enough that a full dict sweep on every
    attempt is cheap."""
    now = datetime.now(timezone.utc)
    stale = [
        u for u, attempts in _failed_login_attempts.items()
        if not any((now - t).total_seconds() < LOGIN_LOCKOUT_WINDOW_MINUTES * 60 for t in attempts)
    ]
    for u in stale:
        _failed_login_attempts.pop(u, None)


def _check_login_rate_limit(username: str) -> None:
    _prune_failed_login_attempts()
    now = datetime.now(timezone.utc)
    attempts = _failed_login_attempts.get(username, [])
    attempts = [t for t in attempts if (now - t).total_seconds() < LOGIN_LOCKOUT_WINDOW_MINUTES * 60]
    _failed_login_attempts[username] = attempts
    if len(attempts) >= MAX_LOGIN_ATTEMPTS:
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed login attempts for this account. Try again in {LOGIN_LOCKOUT_WINDOW_MINUTES} minutes.",
        )


def _record_failed_login(username: str) -> None:
    _failed_login_attempts.setdefault(username, []).append(datetime.now(timezone.utc))


# ---------------------------------------------------------------------------
# Item 22 — basic per-IP rate limiting for public endpoints. Only the login
# endpoint had any rate limiting before this; feedback submission, analytics
# ingestion, and the Copilot chat endpoint were all open to unlimited
# requests from a single caller. Same in-memory sliding-window approach as
# the login limiter above, generalized and parameterized — fine for this
# app's traffic on a single Render instance (see PRODUCTION_AUDIT_REPORT.md
# §14 on moving to a shared store if that ever changes).
# ---------------------------------------------------------------------------
_public_rate_limit_buckets: dict = {}
_RATE_LIMIT_PRUNE_AFTER_S = 3600  # evict a bucket if it hasn't been hit in an hour


def _client_ip(request: Request) -> str:
    """Best-effort client IP, for rate-limiting only (not an auth decision).

    Security review (Aug 2026) — this used to trust the *first* entry of
    X-Forwarded-For. That's spoofable on Render: Render appends the real
    connecting IP to whatever X-Forwarded-For a client already sent rather
    than clearing it first (confirmed on Render's own feedback board —
    https://feedback.render.com/features/p/send-the-correct-xforwardedfor),
    so a caller can set `X-Forwarded-For: 1.2.3.4` themselves and the first
    entry becomes attacker-controlled, letting them cycle through fake IPs
    to dodge the per-IP limiter entirely. The *last* entry is the one
    Render's own edge appends and the caller cannot control, so that's the
    trustworthy one for this single-reverse-proxy deployment.
    """
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        parts = [p.strip() for p in fwd.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return request.client.host if request.client else "unknown"


def _prune_public_rate_limit_buckets() -> None:
    now = datetime.now(timezone.utc)
    stale = [
        k for k, hits in _public_rate_limit_buckets.items()
        if not hits or (now - hits[-1]).total_seconds() > _RATE_LIMIT_PRUNE_AFTER_S
    ]
    for k in stale:
        _public_rate_limit_buckets.pop(k, None)


def rate_limit(max_requests: int, window_seconds: int):
    """FastAPI dependency factory: `Depends(rate_limit(20, 600))` allows up
    to 20 requests per 10 minutes per client IP per endpoint. Campus WiFi
    commonly puts many real students behind one shared public IP (NAT), so
    limits are set generously per call site rather than reused as one
    global default."""
    def _dependency(request: Request) -> None:
        key = f"{max_requests}:{window_seconds}:{request.url.path}:{_client_ip(request)}"
        now = datetime.now(timezone.utc)
        hits = _public_rate_limit_buckets.get(key, [])
        hits = [t for t in hits if (now - t).total_seconds() < window_seconds]
        if len(hits) >= max_requests:
            raise HTTPException(status_code=429, detail="Too many requests. Please slow down and try again shortly.")
        hits.append(now)
        _public_rate_limit_buckets[key] = hits
        if len(_public_rate_limit_buckets) > 1000:  # only sweep occasionally — this runs on every request
            _prune_public_rate_limit_buckets()
    return _dependency


def _clear_failed_logins(username: str) -> None:
    _failed_login_attempts.pop(username, None)


def authenticate_admin(username: str, password: str) -> dict:
    """Look up the admin by username and verify the password.
    Returns the admin row on success, raises HTTPException(401) on failure.
    Deliberately returns the same error for "no such user" and "wrong
    password" so the login endpoint can't be used to enumerate usernames.
    A disabled Fest Admin gets the same generic message too — no separate
    "this account is disabled" response, for the same reason (don't confirm
    the account exists to someone who's just guessing usernames).

    Rate-limited per username — see _check_login_rate_limit above."""
    _check_login_rate_limit(username)
    try:
        client = get_client()
        result = (
            client.table("admins")
            .select("id, username, password_hash, role, disabled")
            .eq("username", username)
            .limit(1)
            .execute()
        )
    except Exception as exc:  # network / Supabase outage
        raise SupabaseUnavailableError(str(exc)) from exc

    rows = result.data or []
    if rows:
        password_ok = verify_password(password, rows[0]["password_hash"])
        is_valid = password_ok and not rows[0].get("disabled")
    else:
        # Always pay the same bcrypt cost as a real lookup — see item 7's
        # note on _dummy_password_hash above.
        verify_password(password, _dummy_password_hash())
        is_valid = False

    if not is_valid:
        _record_failed_login(username)
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    _clear_failed_logins(username)
    admin = rows[0]
    try:
        client.table("admins").update({"last_login_at": datetime.now(timezone.utc).isoformat()}).eq(
            "id", admin["id"]
        ).execute()
    except Exception:
        # last_login_at is informational only — never block login over it —
        # but "never block" isn't the same as "never notice". Previously a
        # bare `pass` meant this could fail silently forever (schema drift,
        # permissions, an outage) with zero trace anywhere.
        logger.warning("Failed to update last_login_at for admin id=%s", admin["id"], exc_info=True)

    return admin


def get_current_admin(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    """FastAPI dependency — drop this in any admin route instead of the old
    `secret: str = Query(...)` parameter. Raises 401 if the bearer token is
    missing, malformed, expired, or signed with the wrong secret.

    Deliberately does NOT hit the database — the JWT itself is the source
    of truth for username/role for the lifetime of the token. That's the
    right trade-off for every route that existed before the Fest Admin role
    did (nothing about them changed here). For anything reachable by a
    'festadmin' account, use get_current_active_admin below instead — a
    disabled Fest Admin needs to be cut off immediately, not whenever their
    token happens to expire."""
    if credentials is None or not credentials.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated — log in to the admin dashboard first.",
        )
    return decode_access_token(credentials.credentials)


def get_current_active_admin(
    payload: dict = Depends(get_current_admin),
) -> dict:
    """Like get_current_admin, but re-checks the admins table so a
    Super Admin disabling (or deleting) a Fest Admin takes effect on their
    very next request instead of silently waiting out the JWT's remaining
    lifetime (up to JWT_EXPIRES_HOURS). Use this — not get_current_admin —
    for every route a 'festadmin' account can reach, and for the
    Manage-Fest-Admins routes themselves (low request volume, so the extra
    DB round trip is cheap there too).

    Returns the JWT payload dict with the DB row's current `disabled`
    value merged in, so callers can also see it without a second lookup."""
    try:
        client = get_client()
        result = (
            client.table("admins")
            .select("id, disabled")
            .eq("id", payload["sub"])
            .limit(1)
            .execute()
        )
    except Exception as exc:
        raise SupabaseUnavailableError(str(exc)) from exc

    rows = result.data or []
    if not rows or rows[0].get("disabled"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="This account has been disabled or no longer exists. Contact a Super Admin.",
        )
    return {**payload, "disabled": rows[0]["disabled"]}


def require_role(*allowed_roles: str):
    """Extra dependency for routes that need more than "any authenticated
    admin" — e.g. only 'superadmin' may create/manage Fest Admins or
    approve fest schedules. Stacks on top of get_current_active_admin so
    every role-gated route also gets the immediate-disable check for free.
    """

    def _check(admin: dict = Depends(get_current_active_admin)) -> dict:
        if admin.get("role") not in allowed_roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions for this action.")
        return admin

    return _check
