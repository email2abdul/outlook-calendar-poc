-- Contact Intelligence overlay (Lumendi brief spec, P4).
--
-- The directory (bis_physicians) already carries email / phone / linkedin. This
-- table adds the TRUST METADATA Eric Coolidge asked for — last verified date,
-- confidence score, last refresh date — keyed by physician NPI, plus optional
-- field overrides (a better-verified mobile / linkedin / email than the master).
--
-- Run once in the dev Supabase project's SQL editor (and prod when ready).
-- Idempotent. Populated by scripts/import-contacts.js (CSV upsert via the anon
-- key) — the POC anon-all policy below lets the importer write without a
-- service-role key, matching the existing app_* tables.

create table if not exists app_contacts (
  npi              text primary key,
  email            text,          -- override / verified; falls back to directory
  mobile           text,          -- verified mobile (distinct from directory phone)
  linkedin_url     text,          -- override / verified
  confidence_score int,           -- 0..100 contactability confidence
  last_verified    date,          -- when the contact details were last verified
  last_refresh     date,          -- when the record was last refreshed (target: quarterly)
  source           text,          -- provenance (vendor, manual, import file, …)
  updated_at       timestamptz default now()
);

alter table app_contacts enable row level security;

-- POC posture: permissive anon/authenticated policy (matches app_activities etc.)
-- so the CSV importer can upsert with the anon key. Tighten before production.
drop policy if exists "app_contacts anon all" on app_contacts;
create policy "app_contacts anon all" on app_contacts
  for all to anon, authenticated using (true) with check (true);
