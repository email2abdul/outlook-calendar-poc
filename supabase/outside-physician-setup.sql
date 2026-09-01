-- ─────────────────────────────────────────────────────────────────────────────
-- outside_physician_app_meeting
--   Who a meeting is with — including the people Supabase has never heard of.
--
-- Run in the DEV project (the only project this app uses today).
-- Idempotent: safe to re-run.
--
-- (Name: underscores, not hyphens. A hyphenated table has to be double-quoted
-- in every query forever; the meaning is identical.)
--
-- Three rules this table exists to keep:
--
-- 1. NOTHING is added to what Supabase already has. bis_* is purchased master
--    data and read-only; app_activities is the meeting itself. A DECISION about
--    who a meeting is with — and a profile assembled outside Supabase — is
--    neither, so it lives here.
--
-- 2. The SAME SHAPE as the master. Every field the app already shows for a BIS
--    physician has a column here, so an outside physician renders through the
--    same layout. What a source could not tell us stays NULL, and the UI and the
--    pre-meeting notes print "Data not available" in that field's own place
--    instead of dropping the row and changing shape.
--
-- 3. Append-only. A decision is never edited: a NEWER row is written and the
--    latest row for a meeting is the effective one. That answers "which data,
--    made when, for which rep", and a correction keeps its history
--    ("picked A on Monday, corrected to B on Tuesday") instead of erasing it.
--
-- NOT stored here, on purpose: the EXTRA intelligence a public registry can add
-- that BIS has no column for — CMS year-wise CPT volumes, Open Payments,
-- publications, licence numbers. Those are fetched and shown in the pre-meeting
-- notes only, tagged as extra. Persisting them is a separate decision to plan,
-- not a side effect of this table.
--
-- `external_source` / `external_source_url` are how another website joins in:
-- a new source records its own id and the page its data came from, and nothing
-- about this table changes when one is added.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists outside_physician_app_meeting (
  id bigint generated always as identity primary key,

  -- ── whose data, and for which meeting ─────────────────────────────────────
  owner_user_id       text not null,      -- the rep (MSAL homeAccountId)
  owner_email         text,               -- readable copy, for support
  calendar_event_id   text not null,
  series_master_id    text,               -- set for a recurring series
  meeting_title       text,
  meeting_date        date,

  -- ── how this answer was reached ───────────────────────────────────────────
  -- source: email | name | user | gate | outside
  --   email   → an attendee address matched bis_physicians exactly
  --   name    → the title said "Dr"/"Doctor" and the name resolved to one row
  --   user    → the rep picked from the shortlist (the only source that promises)
  --   gate    → nothing was looked up: the title never said "Dr"/"Doctor"
  --   outside → a public source answered (see external_source)
  source              text not null,
  decided_by          text,               -- 'user' | 'system'
  confidence          integer,            -- 0-100 where a source reports one
  -- status: briefed | needs_confirm | no_physician | source_down | skipped
  status              text,
  reason              text,               -- one line, written for a rep to read
  candidates          jsonb not null default '[]'::jsonb,  -- the shortlist shown

  -- which outside source answered, and the page that proves it
  external_source     text,               -- 'nppes' | 'cms' | <new source id>
  external_source_url text,

  -- ── mirror of bis_physicians (null = the source did not have it) ──────────
  npi                 text,
  physician_name      text,
  specialty           text,
  email               text,
  phone               text,
  esd_procedure       boolean,            -- NULL is "unknown", not "false"
  photo_url           text,
  linkedin_url        text,

  -- ── mirror of bis_facilities ──────────────────────────────────────────────
  facility_id         text,
  facility_name       text,
  facility_type       text,
  facility_address    text,
  facility_city       text,
  facility_state      text,
  facility_zip        text,
  health_system       text,
  territory           text,

  -- ── mirror of app_contacts ────────────────────────────────────────────────
  contact_email            text,
  contact_mobile           text,
  contact_linkedin_url     text,
  contact_confidence_score integer,
  contact_last_verified    date,
  contact_source           text,

  -- ── mirror of app_accounts ────────────────────────────────────────────────
  account_product     text,
  account_status      text,
  account_since_date  date,
  account_source      text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- The read every request makes: latest row per meeting, newest first.
create index if not exists idx_outside_physician_event
  on outside_physician_app_meeting (owner_user_id, calendar_event_id, created_at desc);

-- "What has this rep decided lately", newest first.
create index if not exists idx_outside_physician_recent
  on outside_physician_app_meeting (owner_user_id, created_at desc);

-- Everything held for one physician across meetings (top-up + reporting).
create index if not exists idx_outside_physician_npi
  on outside_physician_app_meeting (npi) where npi is not null;

-- POC posture, same as the other app_* tables: anon may read/write. Tighten
-- before production — owner_user_id is the tenant key to scope by.
alter table outside_physician_app_meeting enable row level security;

drop policy if exists "outside_physician anon all" on outside_physician_app_meeting;
create policy "outside_physician anon all" on outside_physician_app_meeting
  for all to anon, authenticated using (true) with check (true);
