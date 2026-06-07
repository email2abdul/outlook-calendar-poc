# Email Intelligence Platform — System Design

**Status:** design proposal · **Date:** 2026-06-08
**Builds on:** the existing outlook-calendar-poc (OAuth/Graph, Supabase
directory + analytics, entity-matcher, notes, token-store, reminder engine).

An enterprise-grade AI system that ingests email replies from doctors,
institutions and customers, links each reply to the right meeting/CRM
activity, extracts the business signal, drafts Meeting Notes + Minutes of
Meeting (MOM), and proposes CRM updates for **human approval** — with full
auditability and a feedback loop that improves matching over time.

---

## 1. Guiding principles

1. **Human-in-the-loop, always.** The AI never overwrites a record. It
   produces *suggestions* with confidence; a user accepts / edits / rejects.
   (Step 6 + Step 11.)
2. **Everything auditable.** Every AI output stores its source email, model +
   prompt version, confidence, and the human who approved it.
3. **Reuse the existing stack.** OAuth/token-store, the Microsoft Graph
   wrapper, the Supabase master data, and the entity-matcher already exist —
   the new layer is *email ingestion → AI extraction → suggestion → approval*.
4. **Provider-agnostic AI, Claude by default.** Extraction/MOM use the
   Anthropic API with **tool-use (forced JSON schema)** so outputs are
   validated, not parsed from prose. Model tiers: Claude Opus / Sonnet for
   extraction quality, Haiku for cheap high-volume classification. The AI
   calls sit behind one `ai-extractor` module so the provider can change.
5. **Two-stage matching = deterministic first, semantic last.** Cheap, exact
   signals (thread/message IDs) decide most cases; the LLM only adjudicates
   the ambiguous tail. Saves cost and is more reliable.

---

## 2. End-to-end architecture

```
                         ┌───────────────────────────────────────────────┐
   Email providers       │                 INGESTION                      │
 ┌─────────────┐         │  Outlook: Graph change-notifications (webhook) │
 │  Outlook /  │──push──▶ │          + delta query fallback               │
 │  M365       │         │  Gmail:   Pub/Sub watch + history.list         │
 └─────────────┘         │  → normalize → raw_emails (immutable)          │
 ┌─────────────┐         └───────────────┬───────────────────────────────┘
 │   Gmail     │──push──▶                 │ enqueue email_id
 └─────────────┘                          ▼
                         ┌───────────────────────────────────────────────┐
                         │            MATCHING ENGINE (Step 9)            │
                         │  thread-id → msg refs → subject → doctor →     │
                         │  org → date proximity → CRM activity →         │
                         │  semantic (LLM)  ⇒ meeting_match + confidence  │
                         └───────────────┬───────────────────────────────┘
                                         ▼
                         ┌───────────────────────────────────────────────┐
                         │        AI EXTRACTION (Steps 2,3,4,8,10)        │
                         │  Anthropic tool-use → validated JSON:          │
                         │  insights[] (typed + confidence), notes, MOM   │
                         └───────────────┬───────────────────────────────┘
                                         ▼
                         ┌───────────────────────────────────────────────┐
                         │   SUGGESTION STORE  (pending, never applied)   │
                         │   suggestion + diff vs current activity        │
                         └───────────────┬───────────────────────────────┘
                                         ▼
        ┌────────────────┐      ┌────────────────────┐      ┌────────────────┐
        │  Approval UI   │◀────▶│   Approval API     │─────▶│  CRM WRITER    │
        │ accept/edit/   │      │ (apply on accept)  │      │ (idempotent    │
        │ reject         │      └─────────┬──────────┘      │  upsert)       │
        └────────────────┘                │                 └────────────────┘
                                          ▼
                         ┌───────────────────────────────────────────────┐
                         │   AUDIT LOG (append-only) + FEEDBACK LOOP      │
                         │   every edit/reject becomes training signal    │
                         └───────────────────────────────────────────────┘
```

**Component map to this repo:**

| New component | Reuses / extends |
|---|---|
| Ingestion | `src/graph.js` (add subscriptions + delta), `src/token-store.js` (background tokens) |
| Matching engine | `src/entity-matcher.js` (doctor/org match), Supabase master |
| AI extractor | new `src/ai-extractor.js` (Anthropic SDK, tool-use) |
| Notes/MOM | extends `src/notes.js` (now activity-scoped, versioned) |
| Suggestion + approval | new tables + `src/routes/suggestions.routes.js` |
| Audit | new append-only table |

---

## 3. Database schema (Postgres / Supabase)

Master data (`bis_physicians`, `bis_facilities`, …) stays as-is. New tables:

```sql
-- Immutable record of every email we ingest (source of truth for audit).
create table emails (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null,              -- 'outlook' | 'gmail'
  provider_msg_id   text not null,              -- Graph id / Gmail id
  internet_msg_id   text,                        -- RFC 5322 Message-ID
  thread_id         text,                        -- conversationId / threadId
  in_reply_to       text,                        -- References / In-Reply-To
  owner_user_id     text not null,               -- salesperson (homeAccountId)
  from_email        text, from_name text,
  to_emails         text[], cc_emails text[],
  subject           text,
  body_text         text,                        -- cleaned (no quoted trail)
  body_raw          text,                        -- full original
  received_at       timestamptz not null,
  ingested_at       timestamptz not null default now(),
  unique (provider, provider_msg_id)
);
create index on emails (thread_id);
create index on emails (owner_user_id, received_at desc);

-- CRM activity = a meeting/interaction. Calendar events sync into here.
create table activities (
  id                uuid primary key default gen_random_uuid(),
  owner_user_id     text not null,
  title             text,
  physician_npi     text references bis_physicians(physician_npi),
  facility_id       text,
  calendar_event_id text,                        -- Graph event id, if any
  thread_id         text,                        -- primary email thread
  status            text default 'open',         -- open|won|lost|stalled
  meeting_date      date,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);
create index on activities (owner_user_id, meeting_date desc);
create index on activities (physician_npi);
create index on activities (thread_id);

-- Versioned notes & MOM (never destructive — new version per accepted update).
create table activity_notes (
  id            uuid primary key default gen_random_uuid(),
  activity_id   uuid not null references activities(id),
  version       int  not null,
  kind          text not null,                   -- 'notes' | 'mom'
  content       jsonb not null,                  -- structured (see §6)
  source_email_id uuid references emails(id),
  created_by    text not null,                   -- user id or 'ai'
  created_at    timestamptz default now(),
  unique (activity_id, kind, version)
);

-- Typed insights extracted from a single email (Step 10).
create table insights (
  id            uuid primary key default gen_random_uuid(),
  activity_id   uuid references activities(id),
  email_id      uuid not null references emails(id),
  category      text not null,                   -- action_item|decision|risk|…
  text          text not null,
  confidence    int  not null,                   -- 0..100
  due_date      date,
  status        text default 'proposed',         -- proposed|accepted|rejected
  created_at    timestamptz default now()
);
create index on insights (activity_id);

-- AI proposals awaiting human approval (Step 6). The diff, not the apply.
create table suggestions (
  id            uuid primary key default gen_random_uuid(),
  activity_id   uuid references activities(id),
  email_id      uuid not null references emails(id),
  match_confidence int not null,                 -- meeting-match score
  payload       jsonb not null,                  -- {notes, mom, insights[], crm_changes}
  status        text not null default 'pending', -- pending|accepted|edited|rejected
  model         text, prompt_version text,       -- provenance
  created_at    timestamptz default now(),
  decided_by    text, decided_at timestamptz,
  edited_payload jsonb                            -- what the user actually saved
);
create index on suggestions (status, created_at);

-- Append-only audit trail (Step 11). Insert-only; never updated/deleted.
create table audit_log (
  id            bigint generated always as identity primary key,
  at            timestamptz default now(),
  actor         text not null,                   -- user id or 'ai'
  action        text not null,                   -- email.ingested|match.made|
                                                 -- suggestion.created|suggestion.accepted|…
  entity_type   text, entity_id text,
  source_email_id uuid,
  details       jsonb
);

-- Feedback signal — every human correction trains future matching/extraction.
create table feedback (
  id            uuid primary key default gen_random_uuid(),
  suggestion_id uuid references suggestions(id),
  kind          text not null,                   -- match_wrong|insight_edited|note_rewritten
  before        jsonb, after jsonb,
  created_at    timestamptz default now()
);
```

RLS: every table scoped by `owner_user_id = auth.uid()` (or the service role
for the background worker). Notes/MOM are append-only by version; `audit_log`
is insert-only (no update/delete grant to anyone).

---

## 4. Email ingestion workflow

**Outlook (Microsoft Graph):**
1. On user sign-in, create a Graph **subscription** to
   `/me/mailFolders('inbox')/messages` (`changeType: created`) with our
   webhook URL + clientState secret. Store subscription id + expiry.
2. Graph POSTs a notification → we validate `clientState`, enqueue the
   message id. A worker fetches the full message (token from `token-store`),
   normalizes, writes to `emails`.
3. **Renewal job** re-subscribes before the ~3-day expiry. **Delta-query
   fallback** (`/me/messages/delta`) runs on a timer to catch anything the
   webhook missed (at-least-once, dedup on `(provider, provider_msg_id)`).

**Gmail:** `users.watch` → Pub/Sub topic → push endpoint → `history.list`
since last `historyId` → fetch + normalize. Same `emails` table, `provider='gmail'`.

**Body cleaning:** strip quoted reply trails (`On … wrote:`, `>` blocks),
signatures, disclaimers before storing `body_text`. (A dedicated step so the
AI only sees the new content — Step 2's "ignore greetings and signatures".)

---

## 5. Matching engine (Step 9)

Two stages — deterministic signals score first; the LLM only runs on the
ambiguous tail. Each candidate activity accumulates a weighted score:

| Signal | Weight | How |
|---|---|---|
| Thread / conversation id | 100 | `emails.thread_id == activities.thread_id` → near-certain |
| Message-ID references (`In-Reply-To`) | 95 | reply chain points at an email already linked to an activity |
| Subject similarity | 60 | normalized + fuzzy vs activity title (reuse matcher utils) |
| Doctor match | 55 | sender/body → `entity-matcher` person match → activity's `physician_npi` |
| Organization match | 40 | facility entity match |
| Meeting-date proximity | 30 | activity within ±N days of email date |
| CRM activity link | 50 | existing activity already on this thread |
| **Semantic similarity** | 0–70 | **fallback only:** Claude compares email to top-K candidate activities, returns best id + confidence + reason |

- **Score ≥ 85** → auto-link (still produces a suggestion, never silent write).
- **50–85** → link as "likely", flagged for review.
- **< 50** → no confident activity; offer "create new activity" suggestion.

Output: `{ activity_id, match_confidence, signals_used[], reasoning }` → written
to `audit_log` as `match.made`.

This extends the existing `entity-matcher.js` (already does doctor/org/fuzzy);
the new pieces are thread/message-id signals and the semantic fallback.

---

## 6. AI extraction, Notes & MOM (Steps 2, 3, 4, 8, 10)

One Anthropic call with **forced tool-use** returns a single validated object —
no prose parsing. Sketch (`src/ai-extractor.js`):

```js
const EXTRACTION_TOOL = {
  name: 'record_email_intelligence',
  description: 'Structured business intelligence from one sales email reply.',
  input_schema: {
    type: 'object',
    properties: {
      insights: { type: 'array', items: { type: 'object', properties: {
        category: { enum: ['discussion_point','action_item','follow_up','decision',
          'risk','opportunity','commitment','budget','approval','objection',
          'request','deadline'] },
        text: { type: 'string' },
        due_date: { type: ['string','null'], description: 'ISO date if stated' },
        confidence: { type: 'integer', minimum: 0, maximum: 100 },
      }, required: ['category','text','confidence'] }},
      meeting_notes: { type: 'object', properties: {
        discussion: { type: 'array', items: { type: 'string' }},
        next_steps: { type: 'array', items: { type: 'string' }},
      }},
      mom: { type: 'object', properties: {
        participants: { type: 'array', items: { type: 'string' }},
        discussion_points: { type: 'array', items: { type: 'string' }},
        action_items: { type: 'array', items: { type: 'string' }},
        next_meeting: { type: ['string','null'] },
      }},
    },
    required: ['insights','meeting_notes','mom'],
  },
};
// claude.messages.create({ model, tools:[EXTRACTION_TOOL],
//   tool_choice:{type:'tool',name:'record_email_intelligence'},
//   messages:[{role:'user', content: prompt(threadContext, cleanedBody)}] })
// → tool_use.input is already the validated payload.
```

- **Thread-aware (Step 7):** the prompt includes the consolidated thread
  history (all prior `emails` + accepted notes for the activity), so MOM is
  built over the whole conversation, not one message. We pass a compact
  rolling summary + the latest email to keep tokens bounded.
- **Confidence (Step 8):** each insight carries 0–100. Items below a threshold
  (e.g. 70) are flagged `needs_review` in the UI and never auto-accepted.
- **Prompt versioning:** `prompt_version` stored on every suggestion for audit
  and A/B.

---

## 7. Suggestion → approval workflow (Step 6)

1. Extractor output + matched activity → one `suggestions` row (`status=pending`)
   with a **diff** vs the activity's current notes/MOM/insights.
2. UI lists pending suggestions; each shows: matched meeting + match
   confidence, new notes, new action items, new insights (low-confidence
   highlighted), and the CRM field changes.
3. User action:
   - **Accept** → apply atomically: new `activity_notes` version, `insights`
     → `accepted`, CRM fields updated via idempotent writer, suggestion
     `accepted`, `audit_log` += `suggestion.accepted`.
   - **Edit before saving** → user edits → saved as `edited_payload`, applied,
     and the delta written to `feedback` (training signal).
   - **Reject** → `rejected` + reason → `feedback`.
4. **Idempotency:** applying a suggestion is keyed by `suggestion.id`; re-POST
   is a no-op. CRM writes upsert on `(activity_id, version)` so retries don't
   duplicate (Step 5 — update, never create duplicates).

**APIs:**

```
POST /api/emails/ingest            (internal: webhook → enqueue)        → 202
GET  /api/suggestions?status=pending                                    → list
GET  /api/suggestions/:id                                               → detail + diff
POST /api/suggestions/:id/accept   { edited_payload? }                  → applied activity
POST /api/suggestions/:id/reject   { reason }                           → ok
GET  /api/activities/:id           (notes history, insights, thread)    → activity
POST /api/activities/:id/rematch   (re-run matcher / re-extract)        → suggestion
GET  /api/activities/:id/mom?version=                                   → MOM doc
GET  /api/audit?entity_id=                                              → audit trail
```

---

## 8. Audit & compliance (Step 11)

- `audit_log` is append-only; granted INSERT only (no UPDATE/DELETE to any
  role) — tamper-evident.
- Every suggestion stores `model`, `prompt_version`, `match_confidence`,
  `generated_by_ai=true`, and on decision `decided_by` + `decided_at`.
- `emails.body_raw` retained as the immutable source for any generated note.
- **PII/security:** TLS everywhere; secrets in the platform vault (never in
  repo); least-privilege Graph/Gmail scopes (`Mail.Read`, `Mail.Send`,
  `Calendars.ReadWrite`); per-tenant data isolation via RLS; configurable
  retention + delete-on-request (GDPR/DPDP). PHI note: physician procedure
  data is aggregate, not patient-level — but treat email bodies as sensitive.

---

## 9. Scalability

- **Stateless API + worker pool.** Ingestion notifications enqueue to a job
  queue (BullMQ/Redis or a Postgres-backed queue); workers do fetch →
  match → extract → suggest. Scales horizontally.
- **LLM cost control:** deterministic matching avoids most LLM calls; batch +
  cache extractions; use Haiku for triage, escalate to Sonnet/Opus only for
  rich extraction; **prompt caching** on the static schema/instructions.
- **Backpressure & retries:** at-least-once ingestion with idempotent dedup;
  exponential backoff on Graph/Gmail/Anthropic 429s.
- **Multi-tenant:** partition by `owner_user_id` / org; Supabase connection
  pooling (Supavisor) for serverless callers.

---

## 10. Implementation plan (phased)

| Phase | Scope | Builds on |
|---|---|---|
| **0 — foundation** | `emails`, `activities`, `audit_log` tables; sync existing calendar events → `activities` | current Graph + Supabase |
| **1 — ingestion** | Outlook Graph subscription + webhook + delta fallback; body cleaning; write `emails` | token-store, graph.js |
| **2 — matching** | thread/msg-id + extend entity-matcher signals → `match.made`; no LLM yet | entity-matcher.js |
| **3 — AI extraction** | `ai-extractor.js` (Anthropic tool-use): insights + notes + MOM; confidence | new |
| **4 — suggestions + approval UI** | suggestions table, diff view, accept/edit/reject, idempotent CRM writer | notes.js, routes |
| **5 — thread intelligence** | consolidated thread context into extraction (Step 7) | phase 3 |
| **6 — semantic match + feedback loop** | LLM fallback matcher; `feedback` table tuning | phases 2–4 |
| **7 — Gmail + scale** | Gmail watch/Pub-Sub; job queue; multi-tenant hardening | phase 1 |

Each phase is shippable and demoable on its own; phases 1–4 deliver the core
business scenario (reply → matched meeting → notes/MOM → approval).

---

## 11. Worked example (the AIIMS scenario)

```
Incoming reply (thread T-9), from amit.sharma@aiims… , subject
"RE: Follow-up discussion regarding oncology collaboration"

Matching:    thread_id T-9 == activity A-12345 thread  → 100  (auto-link)
             doctor "Amit Sharma" → NPI match           → +55  (corroborates)
             match_confidence = 98

Extraction (Claude tool-use) →
  insights: [
    {category:'opportunity', text:'Interested in oncology trial participation', confidence:95},
    {category:'request',     text:'Requested protocol document',              confidence:96},
    {category:'follow_up',   text:'Follow-up call next week',                 confidence:90},
    {category:'budget',      text:'Needs budget details before approval',     confidence:93},
  ]
  meeting_notes.next_steps: ['Share protocol document','Send budget proposal','Schedule follow-up call']
  mom.action_items:        ['Send protocol document','Share budget details']

Suggestion S-77 (pending) → diff vs A-12345 → Approval UI:
  [Accept]  → activity_notes v2 (mom), insights accepted, audit += accepted
  [Edit]    → user trims → feedback row
  [Reject]  → feedback row
```

---

## 12. Open decisions (need your call)

1. **CRM target** — is the "CRM" the Supabase `activities` table we own, or an
   external CRM (Salesforce / HubSpot / Zoho)? Changes the writer + auth.
2. **AI provider/budget** — confirm Anthropic (Claude) and rough monthly email
   volume (drives model tier + cost).
3. **Gmail in scope now or Outlook-only first?**
4. **Hosting** — this needs always-on workers + webhooks (Render/Fly), not
   pure serverless.
