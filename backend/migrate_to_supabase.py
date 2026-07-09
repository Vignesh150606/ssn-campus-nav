"""
One-time migration: read the existing local JSON data files and load them
into Supabase. Safe to re-run — every write is an upsert keyed on the
existing id (or, for event_images, a delete-then-reinsert per event), so
running this twice never creates duplicates and never loses data.

Run this AFTER:
  1. Pasting backend/supabase/schema.sql into the Supabase SQL Editor.
  2. Creating the `event-images` Storage bucket.
(Both are spelled out in SUPABASE_MIGRATION.md.)

Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY available — either real
environment variables, or a backend/.env file (auto-loaded via db.py).

Usage:
    cd backend
    python migrate_to_supabase.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db import get_client  # noqa: E402

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")


def _load(name):
    with open(os.path.join(DATA_DIR, name), "r", encoding="utf-8") as f:
        return json.load(f)


def migrate_venues(client):
    locations = _load("locations.json")
    rows = []
    for loc in locations:
        rows.append(
            {
                "id": loc["id"],
                "name": loc["name"],
                "category": loc["category"],
                "department": loc.get("department"),
                "lat": loc["lat"],
                "lng": loc["lng"],
                "floors": loc.get("floors", 1),
                "accessible": loc.get("accessible", True),
                "description": loc.get("description"),
                "facilities": loc.get("facilities", []),
            }
        )
    if rows:
        client.table("venues").upsert(rows, on_conflict="id").execute()
    print(f"venues: upserted {len(rows)} rows")
    return {r["id"] for r in rows}


def migrate_road_segments(client):
    segments = _load("road_segments.json")
    rows = []
    for s in segments:
        bbox = s["bbox"]
        rows.append(
            {
                "id": s["id"],
                "name": s["name"],
                "description": s.get("description"),
                "closed": s.get("closed", False),
                "lat_min": bbox["lat_min"],
                "lat_max": bbox["lat_max"],
                "lng_min": bbox["lng_min"],
                "lng_max": bbox["lng_max"],
            }
        )
    if rows:
        client.table("road_segments").upsert(rows, on_conflict="id").execute()
    print(f"road_segments: upserted {len(rows)} rows")


def _get_or_create_category(client, name, cache):
    if not name:
        return None
    if name in cache:
        return cache[name]
    existing = client.table("event_categories").select("id").eq("name", name).limit(1).execute()
    if existing.data:
        cache[name] = existing.data[0]["id"]
        return cache[name]
    created = client.table("event_categories").insert({"name": name}).execute()
    cache[name] = created.data[0]["id"]
    return cache[name]


def migrate_events(client, known_venue_ids):
    events = _load("events.json")
    category_cache = {}
    migrated, skipped = 0, []

    for e in events:
        if e["location_id"] not in known_venue_ids:
            skipped.append((e["id"], f"unknown location_id '{e['location_id']}'"))
            continue

        category_id = _get_or_create_category(client, e.get("category"), category_cache)

        row = {
            "id": e["id"],
            "name": e["name"],
            "fest": e["fest"],
            "department": e["department"],
            "location_id": e["location_id"],
            "date": e["date"],
            "start_time": e["start_time"],
            "end_time": e["end_time"],
            "description": e["description"],
            "open_to_external": e.get("open_to_external", True),
            "organizer": e.get("organizer"),
            "category_id": category_id,
            "contact_info": e.get("contact_info"),
            "registration_link": e.get("registration_link"),
            "building": e.get("building"),
            "room_number": e.get("room_number"),
            "floor": e.get("floor"),
            "wing": e.get("wing"),
            "status": e.get("status", "pending"),
            "reject_reason": e.get("reject_reason"),
        }
        if e.get("created_at"):
            row["created_at"] = e["created_at"]

        client.table("events").upsert(row, on_conflict="id").execute()

        # Clear any previous image rows for this event first, so re-running
        # the migration never duplicates poster/gallery entries.
        client.table("event_images").delete().eq("event_id", e["id"]).execute()
        images = []
        poster_url = (e.get("poster_url") or "").strip()
        if poster_url:
            images.append({"event_id": e["id"], "url": poster_url, "is_poster": True, "sort_order": 0})
        for i, url in enumerate(e.get("photo_urls") or []):
            url = (url or "").strip()
            if url:
                images.append({"event_id": e["id"], "url": url, "is_poster": False, "sort_order": i})
        if images:
            client.table("event_images").insert(images).execute()

        migrated += 1

    print(f"events: upserted {migrated} rows")
    if skipped:
        print(f"events: SKIPPED {len(skipped)} (fix these manually, then re-run):")
        for eid, reason in skipped:
            print(f"  - {eid}: {reason}")


def main():
    client = get_client()
    print("Connected to Supabase. Starting migration...\n")
    known_venue_ids = migrate_venues(client)
    migrate_road_segments(client)
    migrate_events(client, known_venue_ids)
    print("\nDone. The original JSON files in backend/data/ were not modified or deleted —")
    print("keep them around until you've verified the app end-to-end against Supabase.")


if __name__ == "__main__":
    main()
