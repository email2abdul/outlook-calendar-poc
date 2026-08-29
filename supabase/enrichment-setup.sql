-- External enrichment cache (docs/external-enrichment-agent.md, Phase 4).
--
-- One row per email address the enrichment agent has looked up outside BIS.
-- Enrichment is the most expensive thing the app does — a full lookup costs a
-- paid web search plus half a dozen registry round-trips — and the same
-- physician is re-examined every time the rep opens the meeting. Nothing about
-- an NPI, specialty or hospital changes hour to hour, so results are held for
-- two weeks (ENRICHMENT_CACHE_DAYS, default 14) and refreshed after that.
--
-- `profile` holds the WHOLE enrich() result, so a cache hit rebuilds the brief
-- byte-for-byte — including every field's provenance — without re-querying
-- anything. `sources` is denormalised out of it for quick "where did this come
-- from" reporting.
--
-- Note this caches only data gathered from OUTSIDE bis_*. A physician who is in
-- the master is never cached here: that lookup is free, in-memory, and must
-- always reflect the master as it is now (see src/enrichment/cache.js).
--
-- Run once in the dev Supabase project's SQL editor (and prod when ready).
-- Idempotent. Anon-all RLS to match the existing app_* POC tables — tighten
-- along with the rest before production.

create table if not exists app_external_profiles (
  id                  uuid primary key default gen_random_uuid(),

  -- Addressable two ways: by the email the rep is looking at, and by NPI (the
  -- backfill script enriches known physicians who have no email at all).
  -- lookup_key is "<email>" or "npi:<npi>"; lookup_email stays null for the latter.
  lookup_key          text not null,
  lookup_email        text,                   -- what we searched by (lowercased)
  resolved_npi        text,                   -- from NPPES, when identified
  in_bis              boolean not null default false,
  matched_facility_id text,                   -- bis_facilities hit, when matched

  status              text,                   -- recovered_in_bis | external | ambiguous |
                                              -- facility_only | not_physician | unresolved
  confidence          int,                    -- 0-100
  web_used            boolean not null default false,  -- did the PAID tier run?

  profile             jsonb not null,         -- { result: <full enrich() result> }
  sources             jsonb not null default '[]'::jsonb,

  created_at          timestamptz default now(),
  refreshed_at        timestamptz default now()
);

-- ── Upgrade path ──────────────────────────────────────────────────────────
-- `create table if not exists` above is a no-op when an earlier version of this
-- file has already been applied, so bring an existing table up to the current
-- shape explicitly. Safe to run repeatedly, and safe on a fresh table.
alter table app_external_profiles add column if not exists lookup_key text;
alter table app_external_profiles add column if not exists status text;
alter table app_external_profiles add column if not exists confidence int;
alter table app_external_profiles add column if not exists web_used boolean not null default false;
alter table app_external_profiles add column if not exists matched_facility_id text;

-- Older rows were keyed by email alone; adopt them as their own lookup_key.
update app_external_profiles
   set lookup_key = lower(lookup_email)
 where lookup_key is null and lookup_email is not null;

-- Rows keyed by NPI carry no address, so the email column must allow nulls.
alter table app_external_profiles alter column lookup_email drop not null;

-- One cached answer per lookup; the agent upserts on this key.
create unique index if not exists app_external_profiles_key_idx
  on app_external_profiles (lookup_key);
create index if not exists app_external_profiles_email_idx
  on app_external_profiles (lower(lookup_email));

-- "Everything we know about this NPI", and TTL sweeps.
create index if not exists app_external_profiles_npi_idx
  on app_external_profiles (resolved_npi);
create index if not exists app_external_profiles_refreshed_idx
  on app_external_profiles (refreshed_at);

alter table app_external_profiles enable row level security;

-- POC policy: anon may do everything, matching the other app_* tables. The app
-- runs on the anon key, so without this the agent cannot write its cache.
drop policy if exists app_external_profiles_anon_all on app_external_profiles;
create policy app_external_profiles_anon_all
  on app_external_profiles for all
  using (true) with check (true);
