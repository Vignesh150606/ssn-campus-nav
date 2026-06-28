"""
Create (or update the password of) an admin account in Supabase.

Run this once to create your first admin login — there's no public
sign-up endpoint by design (only superadmins should be able to create
admins, and right now that's "whoever has the service role key", i.e. you,
running this script).

Usage:
    cd backend
    python scripts/create_admin.py
    (then follow the prompts for username / password / role)

Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY available (backend/.env or
real env vars).
"""
import getpass
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from auth import hash_password  # noqa: E402
from db import get_client  # noqa: E402


def main():
    username = input("Admin username: ").strip()
    if not username:
        print("Username can't be empty.")
        return

    password = getpass.getpass("Admin password: ")
    confirm = getpass.getpass("Confirm password: ")
    if password != confirm:
        print("Passwords didn't match.")
        return
    if len(password) < 8:
        print("Use at least 8 characters.")
        return

    role = input("Role [admin/superadmin] (default: admin): ").strip() or "admin"
    if role not in ("admin", "superadmin"):
        print("Role must be 'admin' or 'superadmin'.")
        return

    client = get_client()
    password_hash = hash_password(password)

    existing = client.table("admins").select("id").eq("username", username).limit(1).execute()
    if existing.data:
        client.table("admins").update({"password_hash": password_hash, "role": role}).eq(
            "username", username
        ).execute()
        print(f"Updated existing admin '{username}' (role: {role}).")
    else:
        client.table("admins").insert(
            {"username": username, "password_hash": password_hash, "role": role}
        ).execute()
        print(f"Created admin '{username}' (role: {role}).")

    print("You can now log in to the admin dashboard with this username and password.")


if __name__ == "__main__":
    main()
