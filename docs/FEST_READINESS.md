# Fest readiness and recovery

Visitor traffic should use Vercel's shell/static campus data, on-device routing
and Copilot, and public Supabase snapshots. Render is for admin actions,
deliberate feedback submissions, and a live-data fallback only when the
requested dataset has no usable cached copy. This is not a claim of measured
8,000-visitor capacity or guaranteed free-tier uptime.

## Request policy

- Automatic analytics is **off by default**, including hide beacons and replay
  of a previous build's offline queue. The admin analytics page remains, but
  new visitor telemetry is not collected. Set `VITE_ANALYTICS_ENABLED=true` in
  Vercel and rebuild to deliberately restore collection; existing queued data
  is retained, not automatically deleted.
- Failed or malformed snapshots never redirect cached visitors to Render,
  including a valid empty schedule. Old data renders immediately while public
  snapshot refreshes continue. A first visitor with no usable data still gets
  the live fallback. Cached data cannot promise current events/closures during
  an outage; the synchronization/offline indicator remains important.
- Missing event/venue IDs in a usable schedule/destination list produce a
  local not-found message. Newly approved events recover through the shared
  schedule subscription; the event Retry button explicitly refreshes Storage.
- Normal search/routes/GPS/reroutes/chat and graph version checks do not call
  Render. An explicit graph synchronization debug operation still can.
- Visitor QR images use public Storage when configured. If a QR is unavailable,
  Share Event Link remains available, without an automatic backend image call.
- Menus inside the published date window use the snapshot/cache (including
  confirmed absence). A requested date outside that window has no usable menu
  cache and can still use the existing live menu fallback.
- No visitor health polling or backend keep-warm loop is introduced. Existing
  external cron-job.org health pings, if enabled, are a separate intentional
  operator choice, not browser requests.

## Admin publication acceptance

Creating an event submits it for review; only approved/verified events belong
in the public schedule. Successful event, road-state and menu/image writes
expire this browser's public cache metadata without discarding its good data.
The server's publisher still builds the actual public files. Other open tabs
refresh through their existing subscriptions.

Keep schedule and closure TTL at 30 seconds and snapshot Cache-Control at 60
seconds. The approximately 90-second delivery target is **after publication**;
the publisher's 5-second debounce (up to 30 seconds during continuous edits),
network delay, retries and CDN behavior add time after an admin write. Do not
lengthen these caches to reduce traffic at the expense of closure freshness.

Run these **operator** checks after the real admin change, from the repo root:

```powershell
$base = 'https://bsucvxhvshvrwouupbct.supabase.co/storage/v1/object/public/snapshots'
powershell -NoProfile -File frontend/scripts/check_public_snapshots.ps1 -SnapshotBase $base
# Creation/approval:
powershell -NoProfile -File frontend/scripts/check_public_snapshots.ps1 -SnapshotBase $base -ExpectEvent '<event-id>'
# Edit (name must match exactly):
powershell -NoProfile -File frontend/scripts/check_public_snapshots.ps1 -SnapshotBase $base -ExpectEvent '<event-id>' -ExpectName '<updated name>'
# Deletion:
powershell -NoProfile -File frontend/scripts/check_public_snapshots.ps1 -SnapshotBase $base -AbsentEvent '<event-id>'
# Closure and reopening, performed separately:
powershell -NoProfile -File frontend/scripts/check_public_snapshots.ps1 -SnapshotBase $base -ExpectClosed '<road-segment-id>'
powershell -NoProfile -File frontend/scripts/check_public_snapshots.ps1 -SnapshotBase $base -ExpectOpen '<road-segment-id>'
```

These commands only read public Storage, print version/publication time/CDN
status and fail on an unmet expectation. They never wake Render. An old
publication time alone does not prove stale data: unchanged files need not be
republished. Check the expected actual content after a mutation. On networks
where Node HTTPS works, `node frontend/scripts/check_public_snapshots.mjs $base`
supports equivalent `--expect-event`, `--expect-name`, `--absent-event`,
`--expect-closed`, and `--expect-open` options. These are manual checks, not a
scheduled monitoring job.

Finally inspect the event/schedule in a separate browser and installed PWA;
close/reopen a road and verify the next local route observes both transitions.
Do not close a real walkway for a production test while visitors are using it.

If a mutation is committed but not published after the expected window, the
existing authenticated superadmin `/api/admin/snapshots/status` and server
publisher logs are the operator diagnostics. `/api/health` alone cannot prove
publication. The superadmin POST `/api/admin/snapshots/publish?name=schedule`
can republish deliberately. These operator requests legitimately use Render.

## Map dependency

The basemap uses `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, with visible
OpenStreetMap contributors attribution and anonymous CORS. Campus tiles at
zoom 15–18 are cached only after viewing, bounded to 260 entries with a 14-day
fallback retention and quota cleanup. First-install cache capture repeats
only already-requested tile URLs; there is no whole-campus/background download.
The production referrer policy must continue to allow the browser Referer.

OSM is a best-effort community service, without an availability guarantee.
Do not run load tests or automated pan/zoom scans against its public servers.
Already-viewed cached tiles may be reused; a new offline visitor cannot obtain
uncached tiles. Route geometry/markers/directions can still work with an
unavailable or partially blank basemap. Any future offline map package needs
licensed/self-hosted data or a provider explicitly permitting downloads.

Policy: https://operations.osmfoundation.org/policies/tiles/

## Private recovery export

```powershell
powershell -NoProfile -File backend/scripts/backup_fest_data.ps1 -ProjectRef bsucvxhvshvrwouupbct
powershell -NoProfile -File backend/scripts/backup_fest_data.ps1 -VerifyOnly -BackupPath '<export directory printed above>'
```

The CLI uses the existing native login; no secret values or `.env` are needed.
A single read-only database statement exports categories, venues, all events
(including pending/rejected), event-image metadata, road segments and menu
metadata. Four public snapshot files and a SHA-256 manifest are also saved.
No admin password hashes, tokens or auth tables are queried. The `backups/`
directory is gitignored. It can contain contacts and unpublished content;
keep it private and copy a successful export to private off-device storage.
Local disk plus browser caches are not an off-site backup. Partial/failed
exports without a passing manifest are not validated backups.

This is a **content recovery export**, not a full database dump or tested
automatic restore. It excludes admin accounts, audit logs, analytics,
feedback, database schema/policies/sequences and Storage image/QR bytes.
Owner/reviewer foreign keys require existing matching admin IDs or reviewed
recovery SQL. A full database backup and restore rehearsal remain necessary
for disaster recovery. Supabase recommends CLI `db dump` exports on Free;
its dump path needs Docker/pg_dump support, unavailable on this machine.
Database dumps do not themselves back up Storage objects either.

Guidance: https://supabase.com/docs/guides/platform/backups

## Recovery choices

1. **Render asleep/down:** cached/baked navigation and public snapshot reads
   continue. Admin changes and deliberate feedback need Render. Do not make
   every visitor probe health or retry a failed live fallback in a loop.
2. **Storage temporarily unavailable:** cached clients retain last-known-good
   public data. Fresh clients may use the live fallback, so a prolonged Storage
   outage can still create Render load. Restoring snapshots is the operator
   remedy, not increasing every visitor's retry frequency.
3. **Database intact, snapshot missing/bad:** after verifying DB content, use
   the superadmin publisher above, or the existing CLI bootstrap from backend:
   `python scripts/publish_snapshots.py --via-cli --project-ref bsucvxhvshvrwouupbct`.
   This is an intentional operator upload, not something this pass executes.
4. **Bad frontend deployment:** restore the known-good Vercel deployment;
   preserve the Git commit and matching baked assets. Avoid clearing users'
   IndexedDB as a general repair. Test PWA upgrade while a route is active.
5. **Lost database data:** preserve exports and prepare a reviewed restore
   against an isolated target first. Do not run the old seed migration or
   overwrite live tables with these JSON files. No destructive restore is
   included in this pass.

## Verification limits

Current IEEE approval/publication was checked read-only in production. Other
event edit/deletion/retry and outage transitions use isolated browser fixtures,
including real IndexedDB and zero unexpected Render requests. They do not prove
every live backend mutation hook. Backend/FastAPI/auth integration tests remain
UNTESTED locally because pinned dependencies are unavailable. Real-phone GPS
and campus walk-through belong to the admin's next acceptance pass. No new
production load test, paid service, production data mutation, push or deployment
is part of these changes.
