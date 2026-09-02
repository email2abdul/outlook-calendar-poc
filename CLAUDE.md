# CLAUDE.md — Outlook Calendar Intelligence

Project context for Claude Code (and teammates). Loaded automatically each session.

## What this is

Named "Outlook Calendar POC", but it is really a **pre-meeting sales-intelligence platform**
for a medical-device sales rep (Lumendi context). When the rep has a calendar meeting with a
**physician**, the system identifies the physician, pulls their data, and emails the rep a full
**pre-meeting brief** — all inside Outlook, no separate dashboard. It also reads inbox email with
AI to produce meeting notes and an **Email Intelligence Sheet**.

## Run & scripts

```bash
npm install
npm run dev          # node --watch server.js → http://localhost:3002
npm start            # node server.js
```
Helper scripts (all honour SUPABASE_ENV):
- `npm run ingest:products`  — ingest Lumendi brochure PDFs → config/product-context.json (Claude)
- `npm run import:contacts <csv>` / `import:accounts <csv>` — CSV → app_contacts / app_accounts
- `npm run intel:backfill [days]` — seed the Email Intelligence Sheet from recent inbox mail

No committed test runner — verification is via `node --check`, ad-hoc node scripts, and live runs.

## Architecture (request + background)

1. **Auth** — Microsoft OAuth via MSAL (`src/auth.js`, `src/token-store.js`). Tokens persisted so
   background engines can refresh silently (`getAccessTokenForUser`).
2. **Calendar/Mail** — Microsoft Graph (`src/graph.js`): events, sendMail, inbox delta, historical
   inbox read (`getInboxMessages`), sent items.
3. **Identify physician** — `src/entity-matcher.js` + `src/physicians.js` (21k+ directory, loaded
   from Supabase) match a meeting's attendee/title to a physician NPI.
4. **Brief** — `src/analytics.js` (CPT volumes, families, commercial signals, account opportunity),
   `src/contacts-store.js`, `src/accounts-store.js`, `src/product-context.js`, rendered by
   `graph.physicianBriefHtml` (shared by email AND the in-app brief so they match).
5. **Delivery** — `src/reminders.js` polls calendars and emails the brief before meetings.
6. **Background ingest** — `src/email-ingest.js` polls inbox/sent, stores emails, and runs AI:
   - `src/ai-extractor.js` → per-reply MOM note (`src/notes.js`)
   - `src/email-intel.js` + `src/intel-extractor.js` → the Email Intelligence Sheet
7. **Web** — `src/routes/api.routes.js` (Express) + `public/{index.html,app.js,styles.css}` (plain,
   responsive, no framework). Server entry: `server.js`.

## Data model (Supabase, `src/supabase.js`)

- **`bis_*`** = real master data, read-only: `bis_physicians` (~21k), `bis_facilities` (~12.8k),
  `bis_procedure_volumes` (~321k), `bis_cpt_reimbursement`, plus RPCs (`bis_directory`,
  `bis_physician_analytics`, `bis_search_physicians`).
- **`app_*`** = this app's data: `app_activities` (meetings), `app_emails` (ingested), `app_contacts`,
  `app_accounts`, `app_audit_log`, `app_email_intel` (the sheet). Notes are in SQLite/Redis
  (`src/notes.js`). POC RLS = anon-all; tighten before prod.
- **Dev/Prod switch**: `SUPABASE_ENV=development|production` flips the whole app between the dev
  project (`nnzcaonhhsvvlcwoddxa`) and prod (`tjcgqdqvajaifiljawwn`). Both key sets live in `.env`.
  App uses the **anon** key. DDL (table create) must be run by hand in the project's SQL editor —
  setup files in `supabase/*.sql`. **app_email_intel currently exists in DEV only** — run
  `supabase/email-intel-setup.sql` in PROD before going live.

## AI

Claude `claude-opus-4-8` via `@anthropic-ai/sdk`, **forced tool-use** (strict JSON schema, no
thinking). Used in: `ai-extractor.js` (reply→MOM), `intel-extractor.js` (email→sheet fields),
`scripts/ingest-products.js` (brochure→product context). All no-op gracefully when
`ANTHROPIC_API_KEY` is unset.

> Gotcha: the model can leak tool-call delimiter fragments into string field values (esp. around
> empty fields). `intel-extractor.js` has a `sanitize()` pass that strips them — keep it.

## Key env vars (`.env`, see `.env.example`)

- `MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_TENANT_ID` / `REDIRECT_URI` — Microsoft app reg
- `SESSION_SECRET`, `PORT` (3002), `NODE_ENV`
- `SUPABASE_ENV` + `SUPABASE_{DEV,PROD}_URL` / `_ANON_KEY` (+ dev service-role for seed scripts only)
- `ANTHROPIC_API_KEY`
- `BRIEFING_TO_EMAIL` — deliver briefings to a real mailbox (sign-in is a federated Gmail address,
  so sendMail-to-self only lands in Outlook **Sent**, never Inbox; the only way into this account's
  Inbox is the deferred Mail.ReadWrite create-in-inbox approach)
- `REMINDER_POLL_SECONDS` (60) / `REMINDER_LEAD_MINUTES` (90)
- `EMAIL_INTEL_DAYS` (10; bump to 30 later)
- `OUTSIDE_HTTP_PROXY` / `OUTSIDE_HTTP_CACHE_DIR` + `OUTSIDE_HTTP_RECORD` / `OUTSIDE_HTTP_OFFLINE` —
  dev-only escape hatches for a network that blocks the registries (`src/enrichment/proxy.js`,
  `src/enrichment/cassettes.js`). Tunnel: `ssh -f -N -D 1080 ubuntu@<host>` +
  `OUTSIDE_HTTP_PROXY=socks5://127.0.0.1:1080`. Record once, then run offline forever:
  `OUTSIDE_HTTP_CACHE_DIR=data/cassettes OUTSIDE_HTTP_RECORD=1 … npm run demo:page`, then swap
  `OUTSIDE_HTTP_RECORD` for `OUTSIDE_HTTP_OFFLINE=1`. Only 2xx JSON is recorded, an offline miss is an
  outage (never "nobody found"), and recordings are gitignored. All off unless set.

## Email Intelligence Sheet (feature/old-email-read)

Reads physician-related inbox mail → flat sheet: Physician | Facility | CPT(s) | Other key info |
**New to DB?** | Meeting | With whom | Email subject | Received. The "New to DB?" column flags
values the email has that `bis_*` does NOT (physician not in directory / facility not in
bis_facilities / CPT not in that physician's volumes). Backfill seeds history; the ingest tick keeps
it growing. UI: topbar **📋 Email Sheet** button → responsive overlay table (mobile = stacked
cards) + CSV export (`GET /api/email-intel`).

## Conventions

- Commit/push only when asked. Branch first if on `main`.
- Stores degrade to null/empty when Supabase/AI is absent — never hard-crash the app.
- Email == in-app brief: both use `graph.physicianBriefHtml`. Keep them identical.
- `bis_physicians` is NOT ground truth for contact details. NPPES has no email field at all, so
  every email is vendor-guessed (`⚠️ unverified`) unless `app_contacts` confirms it. Briefs run
  `enrichment/verify.js` (BIS vs NPPES by NPI) and flag a physician who has moved.
- A meeting with no attendee still gets a brief: `enrichment/context.namesFromEvent()` reads the
  name out of the title and the agent resolves it. Never mail/inject an `ambiguous` result.
- **A name is NEVER derived from an email address.** No local-part guessing, and the paid
  web-identity tier only on an explicit `useWeb=always`. (`email2@gmail.com` → "e"+"mail" → NPPES
  surname MAIL → a clinical social worker briefed as the physician for "Meeting with Best friend".)
  A name comes from the rep, the meeting text, or an attendee's display name — nothing else.
- **Outside BIS, a name is asked of CMS first, NPPES second** (`src/outside-sources/index.js` SOURCES
  order; the first source that answers wins). A hit in CMS
  `medicare-physician-other-practitioners-by-provider-and-service` means the physician actually bills
  Medicare. CMS name-query rules, measured: filter on `Rndrng_Prvdr_Last_Org_Name`, first name as
  `keyword` — **two `filter[…]` params hang the API** — rows grouped by NPI (327 rows = 46 people).
- **The "Dr"/"Doctor" gate governs everything**, panel and background tick alike: `gate_blocked`
  means nothing is looked up, nothing is emailed or injected, and the meeting's card shows nothing
  at all (`.event--plain`, no toggle, no detail). An attendee address is not a path around it.
- Current working branch: `feature/old-email-read`.
