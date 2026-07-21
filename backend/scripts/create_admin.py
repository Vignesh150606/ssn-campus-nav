"""
Create (or update the password of) an admin account in Supabase.

Run this to create your first Super Admin login, or to promote/reset any
account — there's no HTTP route that can create or modify a superadmin
account by design (see backend/auth.py / main.py's "Manage Fest Admins"
section): only whoever has the Supabase service role key, i.e. you,
running this script, can do that. Fest Admin accounts, by contrast, are
normally created from the Super Admin Dashboard's "Manage Fest Admins"
page — this script is only needed for them as a break-glass fallback (e.g.
you're locked out of the dashboard itself).

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

    role = input("Role [superadmin/festadmin] (default: superadmin): ").strip() or "superadmin"
    if role not in ("superadmin", "festadmin"):
        print("Role must be 'superadmin' or 'festadmin'.")
        return

    client = get_client()
    password_hash = hash_password(password)

    existing = client.table("admins").select("id").eq("username", username).limit(1).execute()
    if existing.data:
        client.table("admins").update({"password_hash": password_hash, "role": role, "disabled": False}).eq(
            "username", username
        ).execute()
        print(f"Updated existing admin '{username}' (role: {role}, re-enabled if it was disabled).")
    else:
        client.table("admins").insert(
            {"username": username, "password_hash": password_hash, "role": role}
        ).execute()
        print(f"Created admin '{username}' (role: {role}).")

    print("You can now log in to the admin dashboard with this username and password.")


if __name__ == "__main__":
    main()
