"""
QR code generator for event pages.

Each event gets a QR code that encodes a direct link to its frontend page,
e.g. https://your-deployed-app.com/event/invente-robotics-expo

For local development, FRONTEND_BASE_URL defaults to the Vite dev server.
Update FRONTEND_BASE_URL (via env var or here) once the app is deployed,
then re-run generate_all() so printed QR posters point to the live site.
"""

import os

import qrcode

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_QR_DIR = os.path.join(BASE_DIR, "static", "qr")

# Previously `os.environ.get("FRONTEND_BASE_URL", "http://localhost:5173")`
# with no way to tell "genuinely local dev" apart from "forgot to set this
# in Render" — both silently produced the same working-looking localhost
# URL, and every QR code (generated live by GET /api/events/{id}/qr, or by
# the admin create-event flow) would encode a link only the developer's own
# machine can reach. Nothing about generating or serving the QR code fails
# in that case, so there was no error to notice — just posters that quietly
# don't work for anyone who scans them.
#
# Render sets the RENDER env var automatically on every deployed service;
# APP_ENV=production is the manual override for any other host. Local dev
# (neither set) keeps the documented fallback exactly as before — see
# README.md's "QR codes for the fest" section.
FRONTEND_BASE_URL = os.environ.get("FRONTEND_BASE_URL")
_IS_PRODUCTION = bool(os.environ.get("RENDER")) or os.environ.get("APP_ENV") == "production"

if not FRONTEND_BASE_URL:
    if _IS_PRODUCTION:
        raise RuntimeError(
            "FRONTEND_BASE_URL is not set in this production environment. "
            "Every QR code generated would silently encode a localhost link "
            "that no real visitor can use. Set FRONTEND_BASE_URL in your "
            "Render dashboard's environment variables (see "
            "SUPABASE_MIGRATION.md) and redeploy before printing any posters."
        )
    FRONTEND_BASE_URL = "http://localhost:5173"


def generate_event_qr(event_id: str) -> str:
    """Generate (or regenerate) a QR code PNG for a single event and return its path."""
    os.makedirs(STATIC_QR_DIR, exist_ok=True)
    url = f"{FRONTEND_BASE_URL}/event/{event_id}"
    img = qrcode.make(url)
    path = os.path.join(STATIC_QR_DIR, f"{event_id}.png")
    img.save(path)
    return path


def generate_all(events_json_path: str) -> list[str]:
    import json

    with open(events_json_path, encoding="utf-8") as f:
        events = json.load(f)

    paths = []
    for event in events:
        paths.append(generate_event_qr(event["id"]))
    return paths


if __name__ == "__main__":
    events_path = os.path.join(BASE_DIR, "data", "events.json")
    generated = generate_all(events_path)
    print(f"Generated {len(generated)} QR codes in {STATIC_QR_DIR}:")
    for p in generated:
        print(" -", os.path.basename(p))
