-- =============================================================================
-- SSN Campus Navigator — Phase 3 Supabase schema
-- =============================================================================
-- WHERE TO RUN THIS: Supabase Dashboard → your project → SQL Editor → New query
-- → paste this whole file → Run. It is safe to re-run (everything uses
-- IF NOT EXISTS / ON CONFLICT), so don't worry about running it twice.
--
-- See SUPABASE_MIGRATION.md in the project root for the full step-by-step
-- handoff (this file is referenced from there as "Step 1 — SQL").
-- =============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "pg_trgm";     -- fast ILIKE search on venues

-- -----------------------------------------------------------------------------
-- admins
-- -----------------------------------------------------------------------------
create table if not exists admins (
    id              uuid primary key default gen_random_uuid(),
    username        text not null unique,
    password_hash   text not null,
    role            text not null default 'admin' check (role in ('admin', 'superadmin')),
    created_at      timestamptz not null default now(),
    last_login_at   timestamptz
);

-- -----------------------------------------------------------------------------
-- venues  (was: backend/data/locations.json)
--
-- Kept as one flat table (not split into buildings/rooms/aliases) because
-- that's exactly what locations.json already was: a flat list of points of
-- interest (gates, parking, blocks, hostels, food courts, ...) with no
-- room/alias data anywhere in the existing app. `id` stays TEXT, matching
-- the existing slugs like 'eee-block' — every QR code, route, and frontend
-- link already depends on these exact ids.
-- -----------------------------------------------------------------------------
create table if not exists venues (
    id          text primary key,
    name        text not null,
    category    text not null,
    department  text,
    lat         double precision not null,
    lng         double precision not null,
    floors      integer not null default 1,
    accessible  boolean not null default true,
    description text,
    facilities  text[] not null default '{}',
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

create index if not exists idx_venues_category on venues (category);
create index if not exists idx_venues_name_trgm on venues using gin (name gin_trgm_ops);
create index if not exists idx_venues_department_trgm on venues using gin (department gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- event_categories — small lookup table, auto-populated by the backend from
-- whatever the admin types into the (still free-text) category field.
-- -----------------------------------------------------------------------------
create table if not exists event_categories (
    id          bigint generated always as identity primary key,
    name        text not null unique,
    created_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- events  (was: backend/data/events.json)
--
-- `id` stays TEXT in the existing "<slug>-<6 hex chars>" format so existing
-- QR codes / printed posters / /event/{id} links keep working unchanged.
-- start_time / end_time stay TEXT (not a SQL time type) because real data in
-- this app already includes free-form values like "09:00 (next day)" for
-- overnight events — enforcing a strict TIME type would reject that.
-- -----------------------------------------------------------------------------
create table if not exists events (
    id                  text primary key,
    name                text not null,
    fest                text not null,
    department          text not null,
    location_id         text not null references venues(id) on delete restrict,
    date                date not null,
    start_time          text not null,
    end_time            text not null,
    description         text not null,
    open_to_external    boolean not null default true,
    organizer           text,
    category_id         bigint references event_categories(id) on delete set null,
    contact_info        text,
    registration_link   text,
    building            text,
    room_number         text,
    floor               text,
    wing                text,
    status              text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
    reject_reason       text,
    created_by          uuid references admins(id) on delete set null,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_events_status on events (status);
create index if not exists idx_events_fest on events (fest);
create index if not exists idx_events_date on events (date);
create index if not exists idx_events_location_id on events (location_id);

-- -----------------------------------------------------------------------------
-- event_images — normalizes the old poster_url (single string) + photo_urls
-- (array of strings) fields into rows. The backend reconstructs poster_url /
-- photo_urls from this table on every read, so the frontend/API contract is
-- unchanged. url always holds a usable public URL whether the image is an
-- admin-pasted external link or something uploaded to Supabase Storage
-- (storage_path is set only for the latter, so it can be deleted from the
-- bucket later if needed).
-- -----------------------------------------------------------------------------
create table if not exists event_images (
    id           uuid primary key default gen_random_uuid(),
    event_id     text not null references events(id) on delete cascade,
    url          text not null,
    storage_path text,
    is_poster    boolean not null default false,
    sort_order   integer not null default 0,
    created_at   timestamptz not null default now()
);

create index if not exists idx_event_images_event_id on event_images (event_id);

-- Only one poster image per event (mirrors the old single poster_url field).
create unique index if not exists one_poster_per_event
    on event_images (event_id)
    where (is_poster);

-- -----------------------------------------------------------------------------
-- road_segments  (was: backend/data/road_segments.json, mutated in place)
--
-- utils/router.py is untouched by this migration and still reads
-- road_segments.json straight off disk for the Dijkstra closure-penalty
-- logic. This table is the real source of truth; the FastAPI backend keeps
-- a local JSON mirror of it in sync (on startup + on every toggle) so
-- router.py never has to change. See data_access.py / main.py.
-- -----------------------------------------------------------------------------
create table if not exists road_segments (
    id          text primary key,
    name        text not null,
    description text,
    closed      boolean not null default false,
    lat_min     double precision not null,
    lat_max     double precision not null,
    lng_min     double precision not null,
    lng_max     double precision not null,
    updated_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- updated_at auto-touch trigger (keeps venues/events/road_segments fresh)
-- -----------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists trg_venues_updated_at on venues;
create trigger trg_venues_updated_at before update on venues
    for each row execute function set_updated_at();

drop trigger if exists trg_events_updated_at on events;
create trigger trg_events_updated_at before update on events
    for each row execute function set_updated_at();

drop trigger if exists trg_road_segments_updated_at on road_segments;
create trigger trg_road_segments_updated_at before update on road_segments
    for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- Row Level Security
--
-- The backend only ever talks to Supabase using the SERVICE ROLE key, which
-- bypasses RLS entirely — so none of this affects how the app works. We
-- still enable RLS with NO permissive policies on every table, as defense
-- in depth: if an anon/public key is ever added to this project for any
-- other reason, it gets zero access to these tables by default rather than
-- whatever Supabase's table-level default happens to be.
-- -----------------------------------------------------------------------------
alter table admins          enable row level security;
alter table venues          enable row level security;
alter table event_categories enable row level security;
alter table events          enable row level security;
alter table event_images    enable row level security;
alter table road_segments   enable row level security;

-- =============================================================================
-- End of schema. Next: Storage bucket setup — see SUPABASE_MIGRATION.md Step 2.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- venue_menus  (Phase 4.2 — Food Court Menu feature)
--
-- One menu image per venue per day. Admins upload/replace/delete via the
-- admin dashboard. Users see today's menu on the venue card or via Copilot.
-- image_url always holds a usable public URL (Supabase Storage or external).
-- storage_path is set only for Storage uploads so images can be deleted
-- from the bucket when the menu row is deleted.
-- -----------------------------------------------------------------------------
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

drop trigger if exists trg_venue_menus_updated_at on venue_menus;
create trigger trg_venue_menus_updated_at before update on venue_menus
    for each row execute function set_updated_at();

alter table venue_menus enable row level security;
