"""
backend/scripts/measure_snapshot_propagation.py -- how long until an OVERWRITTEN snapshot reaches a client?

Uses a throw-away object `_probe.json` in the same public bucket (never touches live data).
Per round:  write nonce A -> read it twice through the public URL (warms the CDN edge)
            -> overwrite with nonce B -> poll the public URL until B shows up.
Three read styles are timed, because they behave differently:
  plain      GET with no cache headers      = a visitor with an empty browser cache
  no-cache   GET with Cache-Control: no-cache = what dataClient.js sends (conditional revalidation)
  bucketed   GET with ?b=<fresh value>        = what VITE_SNAPSHOT_BUCKET_SECONDS gives you once a new bucket starts

Stdlib only. Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (backend/.env is read if python-dotenv is installed).
Usage (PowerShell, from backend/):
    python scripts/measure_snapshot_propagation.py --rounds 5
    python scripts/measure_snapshot_propagation.py --rounds 5 --cache-seconds 15   # test a lower cache-control
Run it from a different network than the Render box if you can (phone hotspot), ideally from the venue.
"""
import argparse
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))
except ImportError:
    pass

URL = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
BUCKET = os.environ.get("SNAPSHOT_BUCKET", "snapshots")
OBJ = "_probe.json"


def put(nonce: str, cache_seconds: int) -> None:
    req = urllib.request.Request(
        f"{URL}/storage/v1/object/{BUCKET}/{OBJ}", method="POST",
        data=json.dumps({"nonce": nonce}).encode(),
        headers={"Authorization": f"Bearer {KEY}", "apikey": KEY, "Content-Type": "application/json",
                 "x-upsert": "true", "Cache-Control": f"max-age={cache_seconds}"})
    urllib.request.urlopen(req, timeout=20).read()


def get(style: str):
    url = f"{URL}/storage/v1/object/public/{BUCKET}/{OBJ}"
    headers = {}
    if style == "no-cache":
        headers["Cache-Control"] = "no-cache"
    if style == "bucketed":
        url += f"?b={time.time_ns()}"
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20)
        return json.loads(r.read()).get("nonce"), {k.lower(): v for k, v in r.headers.items()}
    except urllib.error.URLError:
        return None, {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--cache-seconds", type=int, default=int(os.environ.get("SNAPSHOT_CACHE_SECONDS", "60")))
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--timeout", type=float, default=300.0)
    a = ap.parse_args()
    if not URL or not KEY:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
        return 1
    styles = ("plain", "no-cache", "bucketed")
    results = {s: [] for s in styles}
    for rnd in range(1, a.rounds + 1):
        put(f"A-{rnd}-{time.time_ns()}", a.cache_seconds)
        for _ in range(2):  # warm the edge with the OLD content
            _, h = get("plain")
        print(f"round {rnd}: warmed; cf-cache-status={h.get('cf-cache-status')} age={h.get('age')} cache-control={h.get('cache-control')}")
        nonce = f"B-{rnd}-{time.time_ns()}"
        put(nonce, a.cache_seconds)
        t0 = time.monotonic()
        seen = {}
        while len(seen) < len(styles) and time.monotonic() - t0 < a.timeout:
            for s in styles:
                if s in seen:
                    continue
                n, _ = get(s)
                if n == nonce:
                    seen[s] = time.monotonic() - t0
            if len(seen) < len(styles):
                time.sleep(a.interval)
        for s in styles:
            results[s].append(seen.get(s))
        print("         seen after (s):", {s: (round(v, 1) if v is not None else f'>{int(a.timeout)}') for s, v in seen.items()})
    print("\nSUMMARY (seconds until the new content was served)")
    for s in styles:
        vals = [v for v in results[s] if v is not None]
        miss = len(results[s]) - len(vals)
        if vals:
            print(f"  {s:9s} min {min(vals):6.1f}  median {statistics.median(vals):6.1f}  max {max(vals):6.1f}  timeouts {miss}")
        else:
            print(f"  {s:9s} never converged within {a.timeout}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
