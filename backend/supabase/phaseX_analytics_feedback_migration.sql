-- =============================================================================
-- SSN Campus Navigator — Phase X: Analytics + Route Feedback
-- =============================================================================
-- WHERE TO RUN THIS: Supabase Dashboard → your project → SQL Editor → New query
-- → paste this whole file → Run. Safe to re-run (IF NOT EXISTS / ON CONFLICT
-- throughout), same convention as schema.sql.
--
-- Run this AFTER schema.sql (it reuses the set_updated_at() trigger function
-- defined there, and route_feedback.destination_id references venues(id)).
--
-- Adds exactly two tables — nothing here touches venues / events /
-- road_segments / admins or any existing table or column.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- analytics_events
--
-- One flexible table for every anonymized product-analytics event (search,
-- route requests, reroutes, trip start/complete/cancel, event-page views,
-- offline usage, GPS accuracy samples), rather than a separate rigid table
-- per event type. `payload` carries whatever fields that event type needs.
--
-- Deliberately NEVER contains: names, device identifiers, IP addresses, exact
-- account/session identity, or precise live GPS coordinates tied to a person.
-- `session_id` is a random id the frontend generates fresh per app open
-- (sessionStorage, not persisted across visits) — it exists only so a burst
-- of events from one visit can be grouped together, never to identify anyone.
-- See backend/data_access.py record_analytics_events() for the exact fields
-- the backend accepts per event_type.
-- -----------------------------------------------------------------------------
create table if not exists analytics_events (
    id          bigint generated always as identity primary key,
    event_type  text not null,
    session_id  text,
    payload     jsonb not null default '{}'::jsonb,
    created_at  timestamptz not null default now()
);

create index if not exists idx_analytics_events_type_created
    on analytics_events (event_type, created_at desc);
create index if not exists idx_analytics_events_created
    on analytics_events (created_at desc);
create index if not exists idx_analytics_events_payload_gin
    on analytics_events using gin (payload);

alter table analytics_events enable row level security;

-- -----------------------------------------------------------------------------
-- route_feedback
--
-- One row per "Was the route accurate?" submission, shown when navigation
-- ends (arrival or early exit). Admins triage through pending -> reviewed ->
-- resolved, with an accepted/rejected/fixed resolution once actioned.
-- -----------------------------------------------------------------------------
create table if not exists route_feedback (
    id                       uuid primary key default gen_random_uuid(),
    destination_id           text references venues(id) on delete set null,
    destination_name         text,
    rating                   integer check (rating between 1 and 5),
    accurate                 boolean,
    categories               text[] not null default '{}',
    comment                  text,
    screenshot_url           text,
    screenshot_storage_path  text,
    distance_m               double precision,
    arrived                  boolean not null default false,
    status                   text not null default 'pending'
                                 check (status in ('pending', 'reviewed', 'resolved')),
    resolution               text
                                 check (resolution is null or resolution in ('accepted', 'rejected', 'fixed')),
    admin_notes              text,
    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now()
);

create index if not exists idx_route_feedback_status on route_feedback (status);
create index if not exists idx_route_feedback_destination on route_feedback (destination_id);
create index if not exists idx_route_feedback_created on route_feedback (created_at desc);

-- Reuses set_updated_at() from schema.sql — not redefined here.
drop trigger if exists trg_route_feedback_updated_at on route_feedback;
create trigger trg_route_feedback_updated_at before update on route_feedback
    for each row execute function set_updated_at();

alter table route_feedback enable row level security;

-- =============================================================================
-- Next step: Storage bucket for feedback screenshots — see SUPABASE_MIGRATION.md
-- "Phase X — Analytics + Route Feedback" section for the manual bucket setup
-- (same one-time "New bucket" step as event-images / venue-menus).
-- =============================================================================
