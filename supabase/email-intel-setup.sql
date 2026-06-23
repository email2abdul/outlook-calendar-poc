-- Email Intelligence Sheet (feature/old-email-read).
--
-- One row per ingested Outlook email (physician-related), holding the "kaam ki
-- baat" extracted from it for a flat sheet the rep can scan / export:
--   physician, facility, CPT items, other key info, what is NEW vs the bis_*
--   master data, the meeting it relates to (date/time + with whom), and the
--   source email's subject/received time.
--
-- Populated incrementally: a one-off backfill (scripts/intel-backfill.js) seeds
-- the recent window, and the live ingest tick upserts each new email — so the
-- sheet keeps growing. Keyed by provider_msg_id so re-runs update, never dup.
--
-- Run once in the dev Supabase project's SQL editor (and prod when ready).
-- Idempotent. Anon-all RLS to match the existing app_* POC tables (the backfill
-- script + ingest engine write with the anon key, no service-role needed).

create table if not exists app_email_intel (
  provider_msg_id  text primary key,         -- Graph message id (dedup / upsert key)
  provider         text default 'outlook',
  owner_user_id    text,                      -- the rep (homeAccountId)

  physician_npi    text,                      -- resolved against bis_physicians, else null
  physician_name   text,                      -- resolved name, else what the email names
  facility_name    text,                      -- resolved / mentioned facility

  cpt_items        jsonb default '[]'::jsonb, -- [{code, description, note}] from the email (AI)
  other_notes      jsonb default '[]'::jsonb, -- other key business points (AI)
  new_to_db        jsonb default '[]'::jsonb, -- values the email has that bis_* does NOT (the "new" data)

  meeting_date     date,                      -- linked activity's meeting date, else email date
  meeting_datetime timestamptz,               -- meeting start if linked, else received_at
  with_whom        text,                      -- meeting attendee / physician / sender

  email_subject    text,
  received_at      timestamptz,
  extracted        boolean default false,     -- has the AI pass run for this row yet?

  source           text default 'email-intel',
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- Fast listing for the per-rep sheet (newest meeting/email first).
create index if not exists app_email_intel_owner_idx
  on app_email_intel (owner_user_id, received_at desc);

alter table app_email_intel enable row level security;

-- POC posture: permissive anon/authenticated policy (matches app_activities,
-- app_contacts, app_accounts) so the backfill + ingest can upsert with the anon
-- key. Tighten before production.
drop policy if exists "app_email_intel anon all" on app_email_intel;
create policy "app_email_intel anon all" on app_email_intel
  for all to anon, authenticated using (true) with check (true);
