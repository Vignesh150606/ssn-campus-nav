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
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from passlib.context import CryptContext

from db import SupabaseUnavailableError, get_client

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
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Session expired — please log in again.")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid authentication token.")


def authenticate_admin(username: str, password: str) -> dict:
    """Look up the admin by username and verify the password.
    Returns the admin row on success, raises HTTPException(401) on failure.
    Deliberately returns the same error for "no such user" and "wrong
    password" so the login endpoint can't be used to enumerate usernames.
    A disabled Fest Admin gets the same generic message too — no separate
    "this account is disabled" response, for the same reason (don't confirm
    the account exists to someone who's just guessing usernames)."""
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
        raise SupabaseUnavailableError(str(exc))

    rows = result.data or []
    if not rows or not verify_password(password, rows[0]["password_hash"]) or rows[0].get("disabled"):
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    admin = rows[0]
    try:
        client.table("admins").update({"last_login_at": datetime.now(timezone.utc).isoformat()}).eq(
            "id", admin["id"]
        ).execute()
    except Exception:
        pass  # last_login_at is informational only — never block login over it

    return admin


def get_current_admin(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
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
        raise SupabaseUnavailableError(str(exc))

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
