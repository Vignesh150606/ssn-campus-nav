"""
backend/scripts/publish_snapshots.py -- manual full rebuild of the live snapshots.

Builds schedule / menus / closures / posters from Supabase and uploads them (plus
qr/<event_id>.png) to the public `snapshots` bucket. Use it for the first publish,
after restoring a backup, or any time you want to force-refresh everything.

Required env vars (backend/.env is loaded automatically):
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY        (server-side only, never in the frontend)
Optional: SNAPSHOT_BUCKET, SNAPSHOT_CACHE_SECONDS, SNAPSHOT_MENU_DAYS_AHEAD,
          SNAPSHOT_INCLUDE_CONTACT_INFO (see snapshots.py)

Usage (PowerShell, from the backend folder):
    python scripts/publish_snapshots.py                  # all four, forced
    python scripts/publish_snapshots.py --only schedule menus
    python scripts/publish_snapshots.py --dry-run        # build to ./snapshot_preview/, upload nothing
Exit code 0 = everything uploaded, 1 = at least one failed.
"""
import argparse
import json
import os
import sys

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(BACKEND, ".env"))

import snapshots  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="+", choices=snapshots.NAMES)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    names = a.only or list(snapshots.NAMES)

    need = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
    missing = [k for k in need if not os.environ.get(k)]
    if missing:
        print("Missing required env vars:", ", ".join(missing))
        return 1

    if a.dry_run:
        out = os.path.join(os.getcwd(), "snapshot_preview")
        os.makedirs(out, exist_ok=True)
        for n in names:
            data, meta = snapshots._BUILDERS[n]()
            body = snapshots._dumps({"schema": 1, "version": 0, "updated_at": "dry-run", "meta": meta, "data": data})
            with open(os.path.join(out, f"{n}.json"), "wb") as f:
                f.write(body)
            print(f"{n}: {len(body) / 1024:.1f} KB -> {out}")
        return 0

    failed = 0
    for n in names:
        try:
            print(n, snapshots.publish(n, force=True))
        except Exception as e:  # keep going, report at the end
            failed += 1
            print(f"{n}: FAILED - {e}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
