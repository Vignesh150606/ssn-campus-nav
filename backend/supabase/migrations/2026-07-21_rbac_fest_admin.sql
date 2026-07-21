-- =============================================================================
-- SSN Campus Navigator — RBAC (Super Admin / Fest Admin) + Fest Schedule
-- approval workflow
-- =============================================================================
-- WHERE TO RUN THIS: Supabase Dashboard → your project → SQL Editor →
-- New query → paste this whole file → Run. Safe to re-run.
--
-- This exact set of changes is also folded into the bottom of schema.sql for
-- fresh installs — this standalone file is for an *existing* deployed
-- database, per the convention in SUPABASE_MIGRATION.md §8.
--
-- What this does:
--  1. `admins.role` — was a two-value check constraint ('admin','superadmin')
--     that nothing actually branched on yet (see auth.py's require_role,
--     already written but "not wired into any route"). Renames the existing
--     'admin' role to 'superadmin' and replaces it with the real two-role
--     set this app now uses: 'superadmin' and 'festadmin'. Also adds
--     `disabled` and `created_by` (who created this account — self-
--     referencing, for the "View who created each Fest Admin" requirement).
--  2. `events.status` — was ('pending','verified','rejected'). Adds a 4th
--     state, 'needs_changes', for the new "Request changes" review action.
--     'verified' is kept as the internal value for "Approved" rather than
--     renamed, so every existing query, index, and frontend status check
--     that already depends on status='verified' keeps working unchanged.
--     Adds `reviewed_by`, `approved_at`, `review_notes` — `created_by`
--     (already existed) doubles as "Submitted By", no rename needed there
--     either.
--  3. `admin_audit_log` — new table for the "track important actions"
--     requirement (Fest Admin created/deleted, password reset, fest
--     submitted/approved/rejected/updated).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. admins — two real roles + disable/created-by
-- -----------------------------------------------------------------------------
update admins set role = 'superadmin' where role = 'admin';

alter table admins drop constraint if exists admins_role_check;
alter table admins add constraint admins_role_check check (role in ('superadmin', 'festadmin'));
alter table admins alter column role set default 'festadmin';

alter table admins add column if not exists disabled   boolean not null default false;
alter table admins add column if not exists created_by uuid references admins(id) on delete set null;

comment on column admins.disabled   is 'Fest Admin accounts only, set/cleared by a Super Admin. Enforced at login and on every Fest-Admin-role endpoint (see auth.py get_current_active_admin) — not just at login — so a disable takes effect immediately rather than waiting out the JWT''s remaining lifetime.';
comment on column admins.created_by is 'Which Super Admin created this account. Null for accounts created via scripts/create_admin.py (i.e. bootstrapped outside the UI).';

-- -----------------------------------------------------------------------------
-- 2. events — 4-state review workflow
-- -----------------------------------------------------------------------------
alter table events drop constraint if exists events_status_check;
alter table events add constraint events_status_check
    check (status in ('pending', 'verified', 'rejected', 'needs_changes'));

alter table events add column if not exists reviewed_by  uuid references admins(id) on delete set null;
alter table events add column if not exists approved_at  timestamptz;
alter table events add column if not exists review_notes text;

comment on column events.reviewed_by  is 'Which admin last actioned this (verify/reject/request-changes). Null while pending.';
comment on column events.approved_at  is 'Set only when status transitions to verified (=Approved). Cleared if a subsequent edit resets status back to pending.';
comment on column events.review_notes is 'General reviewer-comment field for all three review actions. reject_reason (pre-existing) is still written on reject too, for backward compatibility with anything already reading it — review_notes is the new unified field the admin UI displays going forward, falling back to reject_reason for pre-migration rows that only have that.';

create index if not exists idx_events_reviewed_by on events (reviewed_by);

-- -----------------------------------------------------------------------------
-- 3. admin_audit_log — new
-- -----------------------------------------------------------------------------
create table if not exists admin_audit_log (
    id              uuid primary key default gen_random_uuid(),
    actor_id        uuid references admins(id) on delete set null,
    actor_username  text not null,   -- denormalized snapshot: survives the actor account later being deleted
    action          text not null,   -- e.g. 'fest_admin_created', 'fest_admin_deleted', 'password_reset',
                                      -- 'fest_submitted', 'fest_approved', 'fest_rejected', 'fest_needs_changes', 'fest_updated'
    target_type     text,            -- 'admin' | 'event'
    target_id       text,
    details         jsonb,
    created_at      timestamptz not null default now()
);

create index if not exists idx_audit_log_created_at on admin_audit_log (created_at desc);
create index if not exists idx_audit_log_actor       on admin_audit_log (actor_id);

alter table admin_audit_log enable row level security;
-- No permissive policies — same reasoning as every other table in schema.sql:
-- the backend only ever talks to Supabase with the SERVICE ROLE key, which
-- bypasses RLS entirely, so this is defense-in-depth only.

-- -----------------------------------------------------------------------------
-- PostgREST schema cache — same note as venue_menus_migration.sql: force an
-- immediate refresh instead of waiting up to ~60s for it to pick up the new
-- columns/table/constraints on its own.
-- -----------------------------------------------------------------------------
notify pgrst, 'reload schema';

-- =============================================================================
-- After running this: create your first Super Admin (if you don't already
-- have one) or promote an existing one —
--   cd backend && python scripts/create_admin.py
-- (now prompts for 'superadmin' / 'festadmin' instead of 'admin' / 'superadmin' —
-- see that script for details). Any admin row already in the table with the
-- old role='admin' was promoted to 'superadmin' by the UPDATE above, so
-- existing logins keep working with no other changes needed.
-- =============================================================================
