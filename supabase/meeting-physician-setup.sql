-- ─────────────────────────────────────────────────────────────────────────────
-- app_meeting_physician  —  who a meeting is with, and everything we know about
-- them that Supabase does NOT already hold.
--
-- Run once per project (DEV first, then PROD). Idempotent.
--
-- Why a NEW table instead of columns on app_activities:
--   · bis_* is purchased master data and stays read-only; app_activities is the
--     meeting itself. Neither should grow fields that belong to a DECISION or to
--     data that came from outside Supabase.
--   · this data is INCOMPLETE by nature — a physician found in NPPES has no CPT
--     volumes yet, one found by name has no NPI until the registry confirms it.
--     Rows are therefore written with holes and filled in later (a `profile`
--     JSONB, so a new field never needs another migration).
--   · every row records WHO it was made for and WHEN, so "which data, made when,
--     for which rep" is answerable — including two reps meeting the same
--     physician and disagreeing about who they mean.
--
-- Append-only by design: a decision is never edited in place, a NEWER row is
-- written, and the latest row for a meeting is the effective one. That keeps the
-- history ("the rep picked A on Monday, corrected it to B on Tuesday") instead
-- of overwriting it, and makes "latest first" the natural read order.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists app_meeting_physician (
  id bigint generated always as identity primary key,

  -- ── whose data this is ────────────────────────────────────────────────────
  owner_user_id   text not null,          -- the rep (MSAL homeAccountId)
  owner_email     text,                   -- readable copy, for support/debug

  -- ── which meeting ─────────────────────────────────────────────────────────
  calendar_event_id text not null,
  series_master_id  text,                 -- set for a recurring series
  meeting_title     text,
  meeting_date      date,

  -- ── who the meeting is with (any of these may be null and filled in later) ─
  npi             text,                   -- null until a registry confirms one
  physician_name  text,
  specialty       text,
  facility_name   text,
  city            text,
  state           text,
  in_bis          boolean not null default false,

  -- ── how we know, and how sure ──────────────────────────────────────────────
  -- source:  email | name | user | gate | nppes | cms | agent
  --   email → an attendee address matched bis_physicians exactly
  --   name  → the title said "Dr"/"Doctor" and the name resolved to one row
  --   user  → the rep picked from the shortlist (the only source that is a promise)
  --   gate  → nothing was looked up: the title never said "Dr"/"Doctor"
  --   nppes / cms / agent → found outside Supabase
  source          text not null,
  decided_by      text,                   -- 'user' | 'system'
  confidence      integer,                -- 0-100 where a source reports one

  -- status: briefed | needs_confirm | no_physician | source_down | skipped
  status          text,
  reason          text,                   -- one line, written for a rep to read

  -- ── everything Supabase has no column for ─────────────────────────────────
  -- profile: provenance-tagged fields from outside BIS (NPPES address/licence,
  --          CMS CPT volumes per year, Open Payments, publications …), each
  --          carrying its own source + url. Starts as {} and is topped up as
  --          more sources answer, so missing data is a gap to fill, not a
  --          migration to write.
  profile         jsonb not null default '{}'::jsonb,
  -- candidates: the shortlist that was shown, so "why was I asked?" is
  --             answerable after the fact.
  candidates      jsonb not null default '[]'::jsonb,
  -- data_missing: field names we KNOW are absent, so the brief can print
  --               "Data is not available" in the same layout instead of hiding
  --               the row and changing shape.
  data_missing    text[] not null default '{}',

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- The read every request makes: the latest row for these meetings, newest first.
create index if not exists idx_app_meeting_physician_event
  on app_meeting_physician (owner_user_id, calendar_event_id, created_at desc);

-- "What has this rep decided lately" — the newest-first list a review screen or
-- an export walks.
create index if not exists idx_app_meeting_physician_recent
  on app_meeting_physician (owner_user_id, created_at desc);

-- Everything we hold for one physician across meetings (top-up + reporting).
create index if not exists idx_app_meeting_physician_npi
  on app_meeting_physician (npi) where npi is not null;

-- POC RLS, same as the other app_* tables: anon may read/write. Tighten before
-- production (owner_user_id is the tenant key this should be scoped by).
alter table app_meeting_physician enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'app_meeting_physician' and policyname = 'anon_all_app_meeting_physician'
  ) then
    create policy anon_all_app_meeting_physician
      on app_meeting_physician for all
      using (true) with check (true);
  end if;
end $$;
