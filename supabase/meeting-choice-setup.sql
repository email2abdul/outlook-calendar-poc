-- ─────────────────────────────────────────────────────────────────────────────
-- Meeting choice + brief status  (run once per Supabase project: DEV, then PROD)
--
-- Why: when a meeting has no attendee email in bis_physicians and the title
-- names someone several physicians share ("Dr Abdul Khan" → 3 rows), the rep is
-- the only one who knows which one they are seeing. Their pick has to OUTLIVE
-- the click: the ingest tick re-reads the calendar every few minutes, the
-- reminder engine briefs from app_activities, and both used to re-guess from
-- scratch — so a choice made in the UI was forgotten, and worse, the tick's own
-- upsert wrote physician_npi = NULL over it.
--
-- These columns are that memory. Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

alter table app_activities
  -- The NPI the REP confirmed for this meeting. Authoritative: it wins over any
  -- automatic match, and physician_npi is kept in step with it so every existing
  -- reader (reminder brief, note linking, activity list) follows the choice with
  -- no change of its own.
  add column if not exists chosen_npi text,

  -- How the physician on this meeting was decided:
  --   email  → an attendee's address matched the master exactly
  --   name   → the title said "Dr"/"Doctor" and the name resolved to one row
  --   user   → the rep picked from the shortlist  (only this one is a promise)
  --   agent  → an external lookup recovered them by NPI
  add column if not exists chosen_by text,

  add column if not exists chosen_at timestamptz,

  -- What the meeting currently is, so the app, the emails and (later) the
  -- Outlook category tag can all say the same thing:
  --   briefed | needs_confirm | no_physician | source_down | skipped
  add column if not exists brief_status text,

  -- Why the ladder stopped where it did — "title has no Dr/Doctor",
  -- "3 physicians share this name", "NPPES unreachable". Written for the rep to
  -- read, not for code to branch on.
  add column if not exists gate_reason text;

-- The day view looks up many events at once (one query, `in (…)`), so this is
-- the index that lookup rides on.
create index if not exists idx_app_activities_owner_event
  on app_activities (owner_user_id, calendar_event_id);

-- A rep's confirmed choices, newest first — used when reconciling a meeting the
-- rep edited, and handy for support ("what did they pick, and when?").
create index if not exists idx_app_activities_chosen
  on app_activities (owner_user_id, chosen_at desc)
  where chosen_npi is not null;
