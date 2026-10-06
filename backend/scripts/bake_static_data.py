"""
backend/scripts/bake_static_data.py -- bake the build-time datasets for Vercel.

Writes   frontend/public/data/graph.json       <- backend/data/walkway_graph.json
         frontend/public/data/locations.json   <- backend/data/locations.json (or Supabase `venues`)
         frontend/public/data/closures.json    <- backend/data/road_segments.json (bootstrap only)
Vercel serves frontend/public/ at the site root, so these appear at /data/graph.json
and /data/locations.json. The road-status copy is only an offline bootstrap;
live closures still synchronize independently from snapshots/the API.

Shapes are NOT changed: the files are the same JSON the backend returns from
GET /api/graph (raw walkway_graph.json: nodes / edges / location_edges) and
GET /api/locations (array of venue rows, sorted by name). Only whitespace is removed.

Usage (PowerShell, from the backend folder):
    python scripts/bake_static_data.py                  # locations from the local file
    python scripts/bake_static_data.py --source db      # locations from Supabase (needs .env)
    python scripts/bake_static_data.py --check          # exit 1 if the baked files are stale
Run it again whenever walkway_graph.json changes (build_walkway_graph.py) or venues change.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
REPO = os.path.dirname(BACKEND)
sys.path.insert(0, BACKEND)

GRAPH_SRC = os.path.join(BACKEND, "data", "walkway_graph.json")
LOC_SRC = os.path.join(BACKEND, "data", "locations.json")
DEFAULT_OUT = os.path.join(REPO, "frontend", "public", "data")


def dumps(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def load_graph() -> dict:
    with open(GRAPH_SRC, encoding="utf-8") as f:
        g = json.load(f)
    missing = [k for k in ("nodes", "edges", "location_edges") if k not in g]
    if missing:
        sys.exit(f"walkway_graph.json is missing keys {missing}; refusing to bake")
    return g


def load_locations(source: str) -> list:
    if source == "db":
        from dotenv import load_dotenv
        load_dotenv(os.path.join(BACKEND, ".env"))
        import data_access
        rows = data_access.get_locations()
        try:
            with open(LOC_SRC, encoding="utf-8") as f:
                file_ids = {l["id"] for l in json.load(f)}
            db_ids = {l["id"] for l in rows}
            if file_ids != db_ids:
                print(f"NOTE: db vs file differ. only in db: {sorted(db_ids - file_ids)}; "
                      f"only in file: {sorted(file_ids - db_ids)}")
        except OSError:
            pass
    else:
        with open(LOC_SRC, encoding="utf-8") as f:
            rows = sorted(json.load(f), key=lambda l: (l.get("name") or "").casefold())  # = ORDER BY name
    if not rows or any("id" not in r or "lat" not in r or "lng" not in r for r in rows):
        sys.exit("locations data looks wrong (empty or rows without id/lat/lng); refusing to bake")
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=("file", "db"), default="file")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--check", action="store_true", help="don't write; exit 1 if outputs differ")
    a = ap.parse_args()

    with open(os.path.join(BACKEND, "data", "road_segments.json"), encoding="utf-8") as f:
        closures = json.load(f)
    outputs = {"graph.json": dumps(load_graph()), "locations.json": dumps(load_locations(a.source)),
               "closures.json": dumps(closures)}
    stale = False
    for name, text in outputs.items():
        path = os.path.join(a.out, name)
        if a.check:
            cur = open(path, encoding="utf-8").read() if os.path.exists(path) else None
            if cur != text:
                print(f"STALE  {path}")
                stale = True
            else:
                print(f"ok     {path}")
            continue
        os.makedirs(a.out, exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        print(f"wrote  {path}  ({len(text.encode('utf-8')) / 1024:.1f} KB)")
    if stale:
        sys.exit(1)


if __name__ == "__main__":
    main()
