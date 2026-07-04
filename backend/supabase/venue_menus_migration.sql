-- =============================================================================
-- SSN Campus Navigator — Phase 4.2 Food Court Menu: venue_menus table
-- =============================================================================
-- WHY THIS FILE EXISTS (Phase 4.2.6 Priority 1 root-cause fix):
--
-- This exact CREATE TABLE block already lives at the bottom of schema.sql.
-- The backend code (data_access.py) and the admin diagnostic panel are both
-- correct and have been for a while — the diagnostic panel's own error
-- confirms it:
--
--   ✗ venue_menus table — {'message': "Could not find the table
--     'public.venue_menus' in the schema cache", 'code': 'PGRST205', ...}
--   ✗ Storage bucket venue-menus — {'statusCode': 404, 'message':
--     'Bucket not found'}
--
-- PGRST205 ("not in the schema cache") + a 404 on the bucket both mean the
-- same thing: this table and this Storage bucket were written into the
-- CODE (schema.sql, data_access.py) but were never actually created in the
-- LIVE Supabase project. This is a one-time infra step, not a bug — pasting
-- this file into the SQL Editor and creating the bucket below is the fix.
--
-- WHERE TO RUN THIS: Supabase Dashboard → your project → SQL Editor →
-- New query → paste this whole file → Run. Safe to re-run.
-- =============================================================================

create table if not exists venue_menus (
    id           uuid primary key default gen_random_uuid(),
    venue_id     text not null references venues(id) on delete cascade,
    date         date not null default current_date,
    image_url    text not null,
    storage_path text,
    description  text,
    created_by   uuid references admins(id) on delete set null,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    -- One menu image per venue per day
    unique (venue_id, date)
);

create index if not exists idx_venue_menus_venue_date on venue_menus (venue_id, date);

-- set_updated_at() already exists from the main schema.sql run — this just
-- attaches the same trigger function to this table.
drop trigger if exists trg_venue_menus_updated_at on venue_menus;
create trigger trg_venue_menus_updated_at before update on venue_menus
    for each row execute function set_updated_at();

alter table venue_menus enable row level security;
-- No permissive policies — same reasoning as every other table in
-- schema.sql: the backend only ever talks to Supabase with the SERVICE
-- ROLE key, which bypasses RLS entirely, so this is defense-in-depth only.

-- =============================================================================
-- IMPORTANT — PostgREST schema cache
-- =============================================================================
-- PostgREST (what actually serves Supabase's client-library queries) caches
-- the list of tables it knows about. Right after running the CREATE TABLE
-- above, a query against venue_menus can still return the exact same
-- PGRST205 error for up to ~60 seconds until that cache refreshes on its
-- own. To force it immediately instead of waiting, run this too:

notify pgrst, 'reload schema';

-- If it's STILL failing after that: Dashboard → Settings → API →
-- "Reload schema" button (does the same thing via the UI instead of SQL).
-- =============================================================================
-- Next step: create the `venue-menus` Storage bucket — this SQL file can't
-- do that part (Supabase Storage buckets aren't SQL objects). See
-- SUPABASE_MIGRATION.md § "Phase 4.2 — venue-menus Storage bucket" for the
-- exact manual steps, or just:
--   Dashboard → Storage → New bucket → name: venue-menus → Public: ON → Create
-- =============================================================================
