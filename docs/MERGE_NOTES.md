# Fest scaling integration

Rollback tag: `pre-fest-merge`. Work is on main; four lane commits, W2 → W1 → W3 → W4. Nothing is pushed or deployed by this integration. Input archives and handoffs are not committed. Backups and review inventory remain outside the repo in the integration scratch directory.

## Lane provenance and assumptions

- W2 = files (14).zip, confirmed by HANDOFF_W2.md. Public snapshot envelopes retain the live API's dataset shapes. Public event contact information is hidden with SNAPSHOT_INCLUDE_CONTACT_INFO=false, including live fallback; admin editing is unchanged. Set it true and republish schedule to restore the contact row. Previously cached data may remain visible until refreshed.
- W1 = files (13).zip. Reconstructed from scale-01-client-routing.patch and its 14 paths only. The nested baseline checkout and Git metadata are excluded. Backend router and canonical graph stay unchanged. Default routing moves to the authored JavaScript port; server mode remains an escape hatch.
- W3 = files (15).zip. Reconstructed from complete-file interface comments. Its package.json belongs beside scripts/measure-load.mjs, not to the React application.
- W4 = files (16).zip. Reconstructed from module docstrings. Missing endpoint cache/limiter bindings cannot be established from complete helper modules alone; no speculative endpoint policy is applied.

## MISSING

- HANDOFF_W1.md, HANDOFF_W3.md, HANDOFF_W4.md.
- W3 shared-file patches, including the intended complete bundle/precache changes.
- W4 shared-file patches for backend endpoint caches/limiter bindings and Copilot UI.
- W4 k6/load-test scenarios and docs/EVENT_DAY_CHECKLIST.md.
- W2's reported stub/backend and 14-scenario JS tests were not supplied.

The missing artifacts are not recreated or represented as tested. Module integration uses only interfaces documented in files that exist; missing policy changes remain deferred.

## Set these in Render/Vercel

Keep existing Render SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET, JWT_EXPIRES_HOURS, FRONTEND_BASE_URL and optional ADDITIONAL_ALLOWED_ORIGINS. No credentials are copied into frontend data.

Render W2 additions (defaults in backend/.env.example):
`SNAPSHOT_ENABLED=true`, `SNAPSHOT_BUCKET=snapshots`, `SNAPSHOT_CACHE_SECONDS=60`, `SNAPSHOT_DEBOUNCE_SECONDS=5`, `SNAPSHOT_MAX_WAIT_SECONDS=30`, `SNAPSHOT_PUBLISH_ON_STARTUP=false`, `SNAPSHOT_MENU_DAYS_AHEAD=14`, `SNAPSHOT_INCLUDE_CONTACT_INFO=false`, `SNAPSHOT_IMAGE_MAX_WIDTH=1080`, `SNAPSHOT_IMAGE_TARGET_KB=150`.

Vercel: keep VITE_API_BASE; add VITE_SNAPSHOT_BASE_URL (public bucket URL), VITE_ROUTING_MODE=client (W1). Optional VITE_SNAPSHOT_BUCKET_SECONDS is a cache-buster, not a freshness guarantee. The example Supabase project URL is UNVERIFIED for production.

W4 environment configuration and effective/deferred settings are recorded with its integration below.

## Before deploy

1. On the real Supabase project, review and run backend/supabase/snapshots_bucket.sql. The snapshots bucket and four JSON files do not exist yet. Public read must not imply anonymous write.
2. With backend dependencies and server-side environment configured, run `python scripts/publish_snapshots.py` from backend. First inspect `--dry-run` output locally. Verify all four public JSON URLs and referenced QR objects return valid responses.
3. Run the anonymous-write rejection test at the bottom of snapshots_bucket.sql. Do not expose the service-role key to a browser or public logs.
4. Set the environment names above, run the backend checks marked UNTESTED below on the actual pinned dependencies, and deploy. Set SNAPSHOT_PUBLISH_ON_STARTUP=true when desired for event day.
5. Exercise QR/event, destination search, closures, GPS reroutes, menus, admin writes and offline restart on a phone. Confirm closure propagation with scripts/measure_snapshot_propagation.py. No live load test or infrastructure change was performed here.

First three operator commands, from backend after installing dependencies/configuring secrets privately:
`python scripts/publish_snapshots.py --dry-run`
`python scripts/publish_snapshots.py`
`python scripts/measure_snapshot_propagation.py --rounds 5`

## Freshness and fallback limits

The chosen snapshot Cache-Control is 60 seconds and schedule/closures client TTL is 30 seconds. Foreground subscribers refresh at that TTL and receive background updates; routing refreshes closures through the data getter. Offline/unreachable origins use last-known-good data and cannot promise current closures. Startup renders when cached or baked/snapshot data is available while backend health retries continue in the background. With no usable data it retains the blocking startup screen.

**90 seconds is a target after publication, not a guaranteed bound from an admin write.** The publisher waits 5 seconds for quiet edits, up to 30 seconds for a continuous burst; uploads, network latency and CDN revalidation add time. Supabase Free does not provide Smart CDN invalidation guarantees. W4's helper policy lists faster 10-second closure caches, but these absent endpoint patches are not enabled. Values were not silently reduced.

Absent snapshots fall back to live APIs. This preserves operation before bucket setup, but loses the intended Render load reduction. Search, health, analytics, Copilot and admin still use Render. Animated uploads are preserved instead of losing animation through single-frame WebP conversion; menu images target 300 KB and may exceed the 150 KB asset guideline. Existing images are not retroactively compressed.

## Validation

Backend runtime import, TestClient/auth/concurrency/protection tests, snapshot upload/dry-run against the DB and exact dependency-pin compatibility: **UNTESTED**. Backend dependencies are unavailable locally; they were not installed. Static syntax and pure routing checks, frontend checks, build sizes and browser verification are recorded below as they run.

## Budget estimate (no live usage totals)

8,000 visitors × (45 KB graph + 8 KB locations) ≈ 424 MB uncompressed static data. Schedule/closures/menus add small JSON bodies; poster/media/tile traffic and app bundles usually dominate. Actual artifact sizes and files over 150 KB are listed after build.

With snapshots working and client routing enabled, normal routes need zero Render route requests. At a 30-second refresh cadence, 5,000/20,000 foreground clients could make approximately 167/667 requests per second **per subscribed live snapshot** to Supabase Storage, not Render. Example analytics at one batch/minute yields 83/333 Render requests/second; Copilot at one message per user per 5 minutes yields 17/67 requests/second. These are workload assumptions, not measured capacity. Without snapshots, fallback traffic returns to Render and its Free resource ceiling remains a likely bottleneck.

### W2 verification
PASS: frontend lint (0 errors, 16 warnings), dummy-URL production build in a scratch mirror excluding real .env files (17 precache entries, 723.50 KiB), verify_snapshots.mjs mocked contracts, baked-data --check, Python AST syntax. Backend runtime tests and actual Storage/SQL/security verification: UNTESTED.

### W1 integration and verification
Only the 14 patch-listed paths were considered; BootGate retains W2's requested data-availability gate. Initial routes await getRoadSegments/getClosures, closure subscriptions refresh every 30 s in the foreground, and synchronous GPS reroutes use that continually updated input while invoking the same getter. Missing road status is no longer assumed all-open. PASS: client/server verification (no route API calls in client mode; closure refresh and reopening tested), lint (0 errors, 16 warnings), production build (17 precache entries, 765.73 KiB). Full Python/JS parity is running; its final result will be recorded below. Backend integration tests: UNTESTED.
