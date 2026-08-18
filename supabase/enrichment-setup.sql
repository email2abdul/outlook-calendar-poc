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

  lookup_email        text not null,          -- what we searched by (lowercased)
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

-- One cached answer per address; the agent upserts on this key.
create unique index if not exists app_external_profiles_email_idx
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
