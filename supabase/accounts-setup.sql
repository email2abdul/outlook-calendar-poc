-- Lumendi account status (Lumendi brief spec, P5).
--
-- Maps a physician (by NPI) to their Lumendi product usage, so the brief can
-- show "Existing Lumendi account status" (Commercial Signals) and count, per
-- facility, "N physicians currently using a Lumendi product" (Account
-- Opportunity — e.g. "1 physician currently using Dilumen").
--
-- Run once in the dev Supabase project's SQL editor (and prod when ready).
-- Idempotent. Populated by scripts/import-accounts.js (CSV upsert via the anon
-- key) — the POC anon-all policy below lets the importer write without a
-- service-role key, matching the existing app_* tables.

create table if not exists app_accounts (
  npi          text primary key,
  product      text,          -- Lumendi product in use (e.g. "DiLumen EZ")
  status       text,          -- active | trial | lapsed | prospect
  since_date   date,          -- when the account/usage started
  source       text,          -- provenance (CRM, manual, import file, …)
  updated_at   timestamptz default now()
);

alter table app_accounts enable row level security;

drop policy if exists "app_accounts anon all" on app_accounts;
create policy "app_accounts anon all" on app_accounts
  for all to anon, authenticated using (true) with check (true);
