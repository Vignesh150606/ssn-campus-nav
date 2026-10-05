-- backend/supabase/snapshots_bucket.sql  (W2)
-- Run once in: Supabase Dashboard -> SQL Editor -> New query -> Run.
--
-- Creates the PUBLIC bucket `snapshots`:
--   * public = true  -> anyone can GET  <SUPABASE_URL>/storage/v1/object/public/snapshots/<file>
--                       (public buckets need no SELECT policy for that URL form)
--   * NO insert/update/delete policy for anon/authenticated -> nobody but the backend can write.
--     The backend uses the service-role key, which bypasses RLS.
--   * 2 MB per-object cap and a JSON/PNG-only allowlist as a second line of defence.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('snapshots', 'snapshots', true, 2097152, array['application/json', 'image/png'])
on conflict (id) do update
   set public             = true,
       file_size_limit    = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

-- storage.objects already has RLS enabled by Supabase. Do NOT add write policies for this bucket.

-- ---- verification (run these; read the results) ---------------------------------------------
-- 1) bucket exists and is public:
--      select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'snapshots';
-- 2) no policy grants anon/authenticated anything on this bucket. Any row below whose
--    qual / with_check mentions 'snapshots', or has NO bucket_id condition at all, is a hole:
--      select policyname, roles, cmd, qual, with_check
--        from pg_policies where schemaname = 'storage' and tablename = 'objects';
--    (Existing policies for your event-images / venue-menus buckets are fine as long as they
--     are scoped with bucket_id = '<that bucket>'.)
-- 3) from PowerShell, a public write must fail (expect HTTP 400/401/403, never 200):
--      curl.exe -i -X POST "$env:SUPABASE_URL/storage/v1/object/snapshots/hack.json" `
--        -H "apikey: <ANON KEY>" -H "Authorization: Bearer <ANON KEY>" `
--        -H "Content-Type: application/json" --data "{}"
