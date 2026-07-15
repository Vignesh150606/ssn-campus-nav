# Phase 3 — Supabase Migration & Deployment Handoff

This is the complete handoff for moving the SSN Campus Navigator backend off
local JSON files and onto Supabase (Postgres + Storage), with real admin
auth. Read it top to bottom once before touching anything in Supabase — the
order matters (schema → storage bucket → env vars → migrate data → deploy).

---

## 0. What changed, what didn't, and why

**Untouched, by design — do not need re-testing for correctness, only for
"still works after the data layer swap":**
- `backend/utils/router.py` (Dijkstra routing, hostel penalty, road-closure
  penalty logic) — zero lines changed.
- `backend/utils/copilot.py` (Campus Copilot NLU) — zero lines changed.
- `backend/utils/qr_generator.py` — zero lines changed. QR codes stay as
  on-disk PNGs; they're regenerated on demand from the (deterministic)
  event id, so they self-heal after a Render redeploy wipes local disk.
  They never needed Supabase Storage.
- `backend/data/walkway_graph.json` — the actual routing graph. This is
  static reference data built offline by `scripts/build_walkway_graph.py`
  from your GPX/KML survey files, not something any admin edits at
  runtime, so it stays a file. (If you ever want this in Supabase too, say
  so explicitly — deliberately left out of this migration.)
- The frontend's React Router pages, map UI, voice guidance, route
  preview, etc. — none of that changed.

**Moved to Supabase Postgres:**
- `backend/data/locations.json` → `venues` table.
- `backend/data/events.json` → `events` + `event_images` + `event_categories`
  tables.
- `backend/data/road_segments.json` (the admin open/close state) →
  `road_segments` table. Because `router.py` is untouched and still reads
  `road_segments.json` straight off disk, the backend now keeps a
  **write-through local mirror** of that table at the same path — refreshed
  on every startup and after every open/close toggle. Supabase is the real
  source of truth; the JSON file is just a cache `router.py` happens to
  read. This is what makes closures survive a redeploy.
- Admin credentials → `admins` table, bcrypt-hashed passwords.

**Schema adaptation from the original brief** — the spec listed
`buildings` / `building_rooms` / `building_aliases` as separate tables.
There is no such hierarchy anywhere in the current app (room/floor/wing are
free-text fields on *events*, not a buildings/rooms data model, and there's
no aliases concept at all). Adding three empty, unused tables would be
schema bloat with no current consumer, so this migration uses one `venues`
table (a faithful copy of `locations.json`) instead. If you build out a real
rooms/aliases feature later, `venues` is the natural parent table to hang
that off — happy to add it then.

**Auth contract change (the one necessarily breaking change):** the old
`?secret=<shared string>` query param is gone. Every admin now has a real
account (`admins` table, bcrypt hash) and logs in via `POST
/api/admin/login` to get a JWT, sent as `Authorization: Bearer <token>` on
every other admin call. This is the one piece of "keep the API contract
identical" that genuinely couldn't survive contact with "production
practices, bcrypt, protected routes" — there's no way to add real auth
without changing how you authenticate. The admin dashboard's login screen
now asks for a username + password instead of one secret field; everything
else in the dashboard is visually identical.

**New, additive only — Supabase Storage image uploads.** Phase 2 never had
file uploads; `poster_url` / `photo_urls` were always just pasted external
URLs. Rather than redesign event creation, each event card in the admin
dashboard's Events tab now has two small buttons — **🖼 Set Poster** and **📷
Add Photo** — that upload a file straight to Supabase Storage and store the
resulting URL exactly the way a pasted URL always was. The "+ Add Event"
form itself is unchanged; you can still just paste URLs there if you
prefer.

**Frontend never gets a Supabase key.** There's no `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` in this migration. Every read and write goes
through FastAPI, which is the only thing holding the service role key
(server-side only). This is a deliberate security trade-off: one fewer
credential ever reaches a browser, and all validation/auth logic lives in
one place instead of being duplicated between the backend and a direct
Supabase client. If you specifically want client-side Supabase access for
something later (e.g. realtime subscriptions), that's a separate,
additive change.

---

## 1. SQL — run this first

1. Open your Supabase project: https://supabase.com/dashboard/project/bsucvxhvshvrwouupbct
2. Left sidebar → **SQL Editor** → **New query**.
3. Open `backend/supabase/schema.sql` from this project, copy the whole
   file, paste it into the editor, click **Run**.
4. You should see "Success. No rows returned." It's safe to run again if
   you're not sure it worked the first time — everything is
   `IF NOT EXISTS` / `ON CONFLICT`-safe.

This creates: `admins`, `venues`, `event_categories`, `events`,
`event_images`, `road_segments`, the `updated_at` triggers, indexes
(including trigram indexes for fast venue search), and enables Row Level
Security with no permissive policies (the backend uses the service role
key, which bypasses RLS — this is defense in depth in case an anon key is
ever added to the project for something else).

---

## 2. Storage — create the bucket

The SQL editor can't create Storage buckets, so this one step is manual:

1. Left sidebar → **Storage** → **New bucket**.
2. **Name:** `event-images` (must match exactly — the backend hardcodes
   this bucket name in `backend/data_access.py`).
3. **Public bucket:** **ON**. (Event posters/photos need to load directly
   in `<img>` tags with no auth, same as the external URLs the app already
   uses.)
4. Click **Create bucket**.

No additional Storage policies are needed: uploads only ever happen from
the backend using the service role key, which bypasses Storage RLS too.
Reads are public because the bucket itself is public.

---

## 3. Environment variables

### Backend (`backend/.env.example` → copy to `backend/.env` locally, or set directly in Render)

| Variable | Where it belongs | Where to get the value |
|---|---|---|
| `SUPABASE_URL` | backend | Dashboard → Project Settings → API → "Project URL". Already `https://bsucvxhvshvrwouupbct.supabase.co` in the example file. |
| `SUPABASE_SERVICE_ROLE_KEY` | backend | Dashboard → Project Settings → API → **service_role** secret key. ⚠️ Never put this in the frontend or commit it. |
| `JWT_SECRET` | backend | Generate locally: `python -c "import secrets; print(secrets.token_hex(32))"`. Any long random string works. |
| `JWT_EXPIRES_HOURS` | backend | Optional, defaults to `12`. |
| `FRONTEND_BASE_URL` | backend | Your deployed Vercel URL (used to build QR code links), e.g. `https://ssn-campus-nav.vercel.app`. |

### Frontend (`frontend/.env.example` → copy to `frontend/.env` locally, or set directly in Vercel)

| Variable | Where it belongs | Where to get the value |
|---|---|---|
| `VITE_API_BASE` | frontend | Your deployed Render backend URL, e.g. `https://ssn-campus-nav.onrender.com`. |

That's the complete list — no Supabase credential goes in the frontend (see §0).

---

## 4. Render (backend)

1. Open your backend service on Render.
2. **Environment** tab → add each backend variable from §3 above
   (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`,
   `JWT_EXPIRES_HOURS`, `FRONTEND_BASE_URL`).
3. **Settings** → confirm:
   - Build command: `pip install -r backend/requirements.txt` (or
     `pip install -r requirements.txt` if Render's root directory is
     already set to `backend/`).
   - Start command unchanged: `uvicorn main:app --host 0.0.0.0 --port $PORT`
     (run from inside `backend/`).
4. **Manual Deploy → Deploy latest commit** (redeployment IS required —
   the new dependencies in `requirements.txt` and the new env vars only
   take effect on a fresh deploy).
5. **Verify connectivity:** once live, open
   `https://<your-render-url>/docs` in a browser — if the Swagger UI loads
   and `GET /api/locations` returns your venues (not a 503), Supabase is
   connected. A 503 with "Service temporarily unavailable" means
   `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are missing or wrong —
   check the Render logs for the real exception.

---

## 5. Vercel (frontend)

1. Open your frontend project on Vercel.
2. **Settings → Environment Variables** → add `VITE_API_BASE` =
   your Render backend URL, for **Production** (and **Preview** if you
   want preview deploys to hit the same backend).
3. **Redeploy:** Deployments tab → latest deployment → **⋯ → Redeploy**.
   Vite bakes `VITE_*` vars in at build time, so a redeploy is required —
   just changing the env var in the dashboard does nothing until the next
   build.
4. **Verify connectivity:** open the deployed site → Fest Schedule tab —
   if your migrated events show up, the frontend is reaching the new
   backend correctly.

---

## 6. Migrating your existing JSON data

Do this once, after §1 (SQL) and §2 (Storage bucket) are done, and after
you have real Supabase credentials available locally:

```bash
cd backend
cp .env.example .env        # then fill in SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
pip install -r requirements.txt --break-system-packages
python migrate_to_supabase.py
```

This reads `backend/data/locations.json`, `events.json`, and
`road_segments.json` and upserts them into Supabase, keyed on their
existing ids — so it's safe to run more than once, and nothing in the
local JSON files is modified or deleted. It prints a summary, including
any events it had to skip (e.g. if an event references a `location_id`
that doesn't exist as a venue — fix the data and re-run).

Then create your first admin login:

```bash
python scripts/create_admin.py
```

Follow the prompts for username/password/role. You can run this again
later to add more admins or reset a password.

---

## 7. Verification checklist

Run through this after deploying, against the live Render + Vercel URLs:

- [ ] `GET /api/locations` on the live backend returns your venues
- [ ] `GET /api/events` returns your verified events with `location`,
      `poster_url`, `photo_urls` populated correctly
- [ ] Navigation / routing still works (pick a venue, get directions)
- [ ] GPX-derived walkway routing still produces sane paths (unchanged code,
      but worth a sanity check after the data-layer swap)
- [ ] Google Maps KML directions still display
- [ ] GPS-based "current location" routing still works on a phone
- [ ] Voice guidance still announces turns correctly
- [ ] Campus Copilot still answers location/department questions
- [ ] Admin login works with the account from `create_admin.py`
- [ ] Event creation works (Add Event tab)
- [ ] Event approval (✓ Verify) works, and the event appears on the public
      Fest Schedule within ~20s (the existing poll interval)
- [ ] Event editing — there's no edit endpoint in this app (Phase 2 didn't
      have one either); verify/reject/delete are the available actions
- [ ] Event deletion works
- [ ] Event persistence — refresh the browser, restart the Render service,
      events are still there
- [ ] Event images: 🖼 Set Poster / 📷 Add Photo upload successfully and the
      image shows up on the event's public page
- [ ] Registration links on the event page still open correctly
- [ ] Authentication failure (wrong password) shows a clean error, not a
      crash
- [ ] Two different browsers/devices see the exact same event data
- [ ] Road closures (Road Closures tab) persist across a Render redeploy
- [ ] No console errors in the browser; no 500s in the Render logs (a
      Supabase hiccup should show as a clean 503, not a stack trace)

---

## 8. Future maintenance

**Add another admin:**
```bash
cd backend && python scripts/create_admin.py
```

**Reset/rotate an admin's password:** same script — it updates the
existing row if the username already exists.

**Backup the database:** Supabase Dashboard → Database → Backups (daily
backups are automatic on every paid plan; on the free tier, use
**Database → Backups → "Download backup"** or run
`pg_dump` against the connection string under Project Settings → Database).

**Restore the database:** Dashboard → Database → Backups → pick a backup →
**Restore**. For a manual `pg_dump` backup, restore with `psql` against the
same connection string.

**Rotate API keys:** Dashboard → Project Settings → API → "Reset" next to
the relevant key. After rotating the **service_role** key, update
`SUPABASE_SERVICE_ROLE_KEY` in Render's environment variables and redeploy
— the old key stops working immediately, so do this in one sitting (rotate
→ update Render → redeploy) to avoid downtime.

**Add another storage bucket:** Dashboard → Storage → New bucket. Mirror
the `event-images` setup (§2) — public if it needs to serve images directly
to `<img>` tags, private otherwise — and add the bucket name as a constant
in `backend/data_access.py` next to `EVENT_IMAGES_BUCKET`.

**Update the schema safely:** never edit `backend/supabase/schema.sql` and
re-run blindly against a production database with real data — `ALTER
TABLE` statements that drop/rename columns aren't idempotent the way the
`CREATE TABLE IF NOT EXISTS` statements are. Write new schema changes as a
separate, dated file (e.g. `backend/supabase/migrations/2026-07-01_add_x.sql`)
and review it before running it in the SQL Editor.

## 9. Phase X — Offline-First, Analytics, Route Feedback

Three additions on top of everything above — no existing table, bucket, or
env var changes.

**SQL:** run `backend/supabase/phaseX_analytics_feedback_migration.sql` in
the SQL Editor (after §1). Adds two tables: `analytics_events` (anonymous,
aggregate-only — see the comment at the top of that file for exactly what
it does and doesn't store) and `route_feedback`.

**Storage bucket:** one more, same steps as §2 —
- Name: **`route-feedback-screenshots`**
- Public bucket: **ON** (same reasoning as `event-images`: the admin
  feedback dashboard loads these directly into `<img>` tags; URLs are
  random UUIDs and are never linked from any public page)

**No new environment variables.** The offline bundle, analytics, and
feedback endpoints all reuse the existing `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` / admin-JWT setup from §3.

**New endpoints** (all in `backend/main.py`, all reuse `data_access.py`
patterns already established above):

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/offline/bundle` | none | Locations + events + road segments + walkway graph, for the frontend's offline cache |
| `POST /api/analytics/events` | none | Batched, anonymized analytics ingestion |
| `GET /api/admin/analytics/summary` | admin | Aggregated analytics for the admin dashboard |
| `POST /api/feedback` | none | Submit route feedback |
| `POST /api/feedback/{id}/screenshot` | none | Optional screenshot attach |
| `GET /api/admin/feedback` | admin | List/filter feedback |
| `PATCH /api/admin/feedback/{id}` | admin | Update status/resolution |

**Verify:** `GET /api/offline/bundle` should return locations/events/
road_segments/graph/version; submit a test row via `POST /api/feedback`
and confirm it shows up in the Admin → Feedback tab; open Admin →
Analytics and confirm the cards render (they'll all read zero until real
traffic generates events).

