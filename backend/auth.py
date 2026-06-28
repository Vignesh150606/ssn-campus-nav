"""
Admin authentication — bcrypt password hashing + JWT session tokens.

Replaces the old single shared `ADMIN_SECRET` query-param scheme. Each
admin now has their own row in the `admins` table (username + bcrypt
hash + role). Logging in returns a signed JWT; every admin route requires
that JWT in an `Authorization: Bearer <token>` header.

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
    """
    try:
        client = get_client()
        result = (
            client.table("admins")
            .select("id, username, password_hash, role")
            .eq("username", username)
            .limit(1)
            .execute()
        )
    except Exception as exc:  # network / Supabase outage
        raise SupabaseUnavailableError(str(exc))

    rows = result.data or []
    if not rows or not verify_password(password, rows[0]["password_hash"]):
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
    missing, malformed, expired, or signed with the wrong secret."""
    if credentials is None or not credentials.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated — log in to the admin dashboard first.",
        )
    return decode_access_token(credentials.credentials)


def require_role(*allowed_roles: str):
    """Optional extra dependency for routes that need more than plain
    'admin' (e.g. only 'superadmin' may create other admins). Not wired
    into any route yet since today every admin has the same permissions —
    kept here so role-based authorization is a one-line addition later."""

    def _check(admin: dict = Depends(get_current_admin)) -> dict:
        if admin.get("role") not in allowed_roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions for this action.")
        return admin

    return _check
