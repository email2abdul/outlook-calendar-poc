# External Enrichment Agent — Design & Verified Research

**Status:** Phases 1–3 built & tested · design for P4–P5 · **Date:** 2026-08-18  
**Branch:** `feature/physician-facility-data-enrichment`  
**Builds on:** the existing outlook-calendar-poc (OAuth/Graph, Supabase `bis_*`
master data, entity-matcher, analytics, `physicianBriefHtml`, email-ingest).

When the rep schedules a meeting with a physician or facility whose email is
**not** in `bis_physicians`, the app today shows *"Nobody on this meeting matched
the BIS directory"* and stops. This document specifies an agent that fills that
gap: it identifies the person from the email alone, pulls their profile from
authoritative public sources, **re-matches them back into the BIS tables wherever
possible**, and renders a brief in which **every field carries its source** —
with explicit badges for what came from BIS, what came from a government
registry, what came from the open web, and what is *extra* intelligence that BIS
does not model at all.

---

## 1. Guiding principles

1. **BIS data wins, always.** `bis_*` is the master. External data never
   overwrites it — a disagreement becomes a visible *conflict note*, not a
   silent replacement. The cascade is designed to extract the maximum from the
   existing tables *before* and *after* going outside.
2. **Every external claim is attributable.** No field is rendered without a
   source label, and web-sourced fields carry a clickable proof URL. If we
   cannot cite it, we do not show it.
3. **Provenance is a first-class type**, not a footnote. Fields are
   `{value, source, sourceUrl, tier, confidence, retrievedAt}` end to end —
   store, API, and renderer.
4. **Free registries first, AI last.** NPPES, CMS, Open Payments, PubMed and
   ClinicalTrials.gov are free and authoritative. The paid AI call is used only
   for the one job registries cannot do: turning an opaque email address into a
   name.
5. **Reuse the existing stack.** Same Express routes, same Supabase client, same
   `app_*` table convention, same brief layout. `bis_*` stays read-only.
6. **Degrade, never crash.** Every source is independently optional — matching
   the existing store convention (null/empty when a backend is absent).

---

## 2. What the app does today (baseline)

| Concern | Today |
|---|---|
| Physician search | `src/physicians.js → search()` → Supabase RPC `bis_search_physicians`; orphan-facility fallback via `getNearbyForFacility()` |
| Free-text match | `physicians.matchInText()` (email 100 / name+facility 95 / name 70 / facility 40) and `src/entity-matcher.js → analyze()` |
| Facility search | **None.** Facilities are loaded once by `bis_directory()` and nested inside each physician; `email-intel.js → facilityInDb()` is an `ilike` existence check |
| Physician display | One renderer, `graph.physicianBriefHtml()` (`src/graph.js:619`), shared by the briefing email, `/api/physicians/:npi/brief`, `/embed/lead-brief` and `/embed/meeting-brief` |
| Facility display | 4 rows inside `physicianDetailsTable()` (`graph.js:213`); health system + territory derived in `src/territory.js` |
| ID passing | **NPI is the primary key everywhere** — routes, `app_activities.physician_npi`, notes, `app_email_intel`, `block.dataset.npi`. `facility_id` (e.g. `HSOP105211`) is secondary. Email is a lookup key only |
| Supabase | RPCs `bis_directory`, `bis_physician_analytics`, `bis_search_physicians`; PostgREST for `app_*`. Anon key, `SUPABASE_ENV` dev/prod switch |
| Filters | Free-text only — no structured filters (specialty / state / volume) |
| Frontend | Vanilla JS + `<template>` (`buildDetail` → `buildPhysicianBlock` / `buildNoMatch`) |
| Auth | MSAL delegated OAuth + `requireAuth` on `/api/*`; token-store for background engines; shared-token + CSP for `/embed/*`; **Supabase RLS is anon-all (POC)** |
| Caching | Directory in memory once at boot; `product-context` module cache; Redis for sessions/notes. **No cache on analytics, search or brief — and no cache layer for external calls exists yet** |

### The gap, precisely

- `email-ingest.js → physiciansForEvent()` returns `[]` on a miss ⇒ no activity
  link, no instant brief, no meeting-body injection.
- `app.js → buildNoMatch()` falls back to a manual search box.
- `lead-match.js` returns `matchedBy: null`.

All three become entry points for the agent.

---

## 3. Verified research (all executed 2026-08-18)

Test subject: **`nshaheen@med.unc.edu`** — a real academic gastroenterologist who
is **not** in `bis_physicians` (the table contains only "Shaheen Rasheed" and
"William Shaheen"). Only the email address was supplied as input.

| Tier | Source | Result |
|---|---|---|
| T0 | `bis_physicians.email` | ❌ miss |
| T1 | **Claude + `web_search` server tool** | ✅ "Nicholas James Shaheen, MD, MPH · Gastroenterology & Hepatology · Chief, Division of GI & Hepatology · UNC" — **confidence 98**, proof URLs `med.unc.edu/cgibd/…`, `med.unc.edu/ppmh/…`, `fda.gov/media/166105` (the email appears verbatim on the UNC pages). 2 searches, ~20.6k in / 1.6k out tokens |
| T2 | **NPPES NPI Registry** | ✅ NPI **1467521757**, "NICHOLAS J SHAHEEN, MD", taxonomy *Internal Medicine, Gastroenterology*, 101 Manning Dr, Chapel Hill NC 27599, 919-966-4996, license state NC |
| T3 | **CMS Facility Affiliation** (`27ea-46a8`) | ✅ CCN **340061** |
| T3 | **CMS Hospital General Information** (`xubh-q36u`) | ✅ UNC HOSPITALS · Acute Care · Government–State · **5-star** · address + phone |
| T3 | **CMS Open Payments 2024** | ✅ **29 payments** — Lucid Diagnostics, Exact Sciences, Phathom, Intercept → direct competitor / industry-relationship intel |
| T3 | **PubMed E-utilities** | ✅ 337 publications on Barrett's / endoscopy, most recent 2026 |
| T3 | **ClinicalTrials.gov v2** | ✅ overall official on an RF vapor-ablation trial |
| T4 | **Re-match into BIS** | ⚠️ NPI absent from `bis_physicians` — **but the facility is present**: `HSOP105211` "UNC Hospitals Chapel Hill North Carolina", with 6 GI colleagues (emails included) and facility-level CPT volumes (45385 snare polypectomy, 45390 EMR, 45380 biopsy) |

### Findings that shape the design

1. **An email miss is not a physician miss.** Once NPPES yields an NPI, BIS must
   be queried *again* by NPI. Even when the physician is genuinely absent, the
   **facility is often present** — which unlocks the existing volumes,
   colleagues, territory, health-system and product-fit logic. This is the
   concrete answer to *"pull as much as possible from my own tables"*.
2. **Naive facility matching is dangerous.** A first-cut `ilike` on the first two
   long words matched "UNC HOSPITALS" to *"ChristianaCare Hospitals Newark
   Delaware"*. Facility matching must filter on **city + state** and score on
   normalised token overlap, or wrong data reaches the brief.
3. **Email domain → facility is a clean signal in this dataset.** All six
   `@unch.unc.edu` physicians map to the single facility `HSOP105211`. A domain
   index built from existing rows is a free, zero-latency pre-tier.
4. **5,179 of 21,274 physicians have no email at all.** The same agent therefore
   has a second job: backfilling contact gaps in records that *are* in BIS.
5. **NPPES is occasionally flaky** — an identical query returned 0 results once
   and 1 result moments later. Retry with backoff is mandatory.
6. **`data.cms.gov/data-api/v1/dataset/{uuid}/data`** (Medicare physician CPT
   volumes) hangs and times out over both HTTP/2 and HTTP/1.1. Treat as
   unreliable; ingest from CSV or omit. Every other source above responded
   in well under 30 s.
7. **NPPES rejects a one-character wildcard.** `first_name=n*` returns HTTP 200
   with `{"Errors":[{"description":"Wildcards require at least two leading
   characters"}]}`. An initial must therefore never be sent to the API — search
   on the surname alone and rank the results on the initial client-side.
8. **NPPES surname search is fuzzy.** `last_name=Shaheen` genuinely returns
   people called Williams and Decker (presumably via other-name and
   authorized-official fields). Unfiltered, this produced the worst result of
   the whole build: "Evelyn Decker, Counselor, Monterey CA" offered as the match
   for `nshaheen@med.unc.edu`. The surname must be re-checked client-side.
9. **Two BIS facilities can tie at a perfect score.** "UNC Hospitals Chapel Hill
   North Carolina" and "UNC Medical Center Chapel Hill North Carolina" both
   reduce to the single distinctive token `unc`, so the winner came down to
   iteration order. A secondary, lower-weighted comparison that keeps the
   generic words ("hospitals" vs "medical center") separates them.

---

## 4. Architecture — a five-tier, DB-first cascade

```
Meeting attendee email (unknown to BIS)
   │
T0   BIS DB            email → physician?                    FREE, 0 ms   → hit: stop, existing path
   │ miss
T0.5 Domain index      @unch.unc.edu → HSOP105211            FREE, 0 ms   (built from existing rows)
   │
T1   Identity resolve  Claude + web_search → name, title,     ~$0.15      (the only paid step)
   │                   institution, state + PROOF URLs
T2   Registry          NPPES: name+state → NPI, taxonomy,     FREE
   │                   practice address, phone, license
T3   RE-MATCH TO BIS   by NPI, and by facility(city+state+    FREE         ← maximise own data
   │                   token overlap)
T4   Public enrichment CMS affiliation → CCN → hospital;      FREE
   │                   Open Payments; PubMed; ClinicalTrials
   │
T5   Persist + render  app_external_profiles → provenance-tagged brief
```

**Ordering rationale.** T2–T4 are free and fast, so they run in parallel and
render immediately; T1 is slow (15–25 s) and paid, so its result streams into the
card afterwards rather than blocking the first paint.

---

## 5. The provenance model

Every field is an object, not a scalar:

```js
{
  value: "Gastroenterology",
  source: "NPPES NPI Registry",
  sourceUrl: "https://npiregistry.cms.hhs.gov/provider-view/1467521757",
  tier: "verified",            // db | verified | web | inferred
  confidence: 100,
  retrievedAt: "2026-08-18T09:14:22.000Z"
}
```

### Four tiers, four badges

| Badge | Tier | Meaning | Sources |
|---|---|---|---|
| 🟢 **BIS** | `db` | From your own Supabase master | `bis_physicians`, `bis_facilities`, `bis_procedure_volumes` |
| 🔵 **Verified** | `verified` | Official government registry | NPPES, CMS Care Compare, CMS Open Payments |
| 🟡 **Web** | `web` | AI-extracted from the open web — **always with a link** | Hospital bio pages, faculty directories, Doximity, news |
| ⚪ **Inferred** | `inferred` | Derived by us | email domain → org, state → territory, name → health system |

### Two explicit flags

- **`+ EXTRA`** — the field has no counterpart in the `bis_*` schema
  (publications, hospital star rating, industry payments, academic title,
  clinical trials). These are grouped under a separate
  **"Extra Intelligence (not in BIS)"** heading so the rep can tell instantly
  what is new versus what is enriched.
- **Origin banner** at the top of the card:
  > ⚠️ **This physician is not in your BIS database.** Profile assembled from
  > external sources.
  and, when a facility match succeeds:
  > ✅ **Facility found in BIS:** UNC Hospitals (`HSOP105211`) — volumes and
  > colleagues below come from BIS.

Each external field renders a small `🔗` linking to its exact source page. In the
email version this becomes a plain `<a>` so it survives Outlook rendering.

### Precedence and conflicts

`db > verified > web > inferred`. When two sources supply the same field, the
higher tier wins and the loser is retained as a conflict note:

> *NPPES reports specialty "Internal Medicine, Gastroenterology"; BIS holds
> "Gastroenterology".*

Nothing is silently overwritten, in either direction.

---

## 6. Modules

```
src/enrichment/
  index.js              orchestrator — runs the cascade, returns a ProvenanceProfile
  provenance.js         field() helper, tier precedence, merge + conflict capture
  rematch.js            NPI re-lookup + facility match (city+state+token overlap)
  cache.js              app_external_profiles read/write + in-memory LRU + TTL
  sources/
    nppes.js            NPI registry, individuals (NPI-1) and organisations (NPI-2)
    cms-provider.js     facility affiliation (27ea-46a8) + hospital info (xubh-q36u)
    open-payments.js    industry payments by NPI (competitor intelligence)
    literature.js       PubMed E-utilities + ClinicalTrials.gov v2
    web-identity.js     Claude web_search → citations → forced-tool-use JSON
src/routes/api.routes.js  + GET /api/enrich, POST /api/enrich/:npi/promote
src/graph.js              + externalBriefHtml() — provenance-aware sibling of physicianBriefHtml
supabase/enrichment-setup.sql
```

### Source endpoints (verified working)

| Source | Endpoint | Key |
|---|---|---|
| NPPES | `https://npiregistry.cms.hhs.gov/api/?version=2.1&last_name=&first_name=&state=&limit=` | none |
| NPPES orgs | same + `enumeration_type=NPI-2&organization_name=` | none |
| CMS affiliation | `https://data.cms.gov/provider-data/api/1/datastore/query/27ea-46a8/0?conditions[0][property]=npi&conditions[0][value]=<NPI>&conditions[0][operator]==` | none |
| CMS hospital | `…/datastore/query/xubh-q36u/0?conditions[0][property]=facility_id&conditions[0][value]=<CCN>&conditions[0][operator]==` | none |
| CMS hospital by name | same with `&conditions[0][property]=facility_name&conditions[0][value]=UNC%&conditions[0][operator]=like` | none |
| Open Payments 2024 | `https://openpaymentsdata.cms.gov/api/1/datastore/query/e6b17c6a-2534-4207-a4a1-6746a14911ff/0?conditions[0][property]=covered_recipient_npi&…` | none |
| PubMed | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=<Last>+<Initials>[Author]` then `esummary.fcgi` | none |
| ClinicalTrials | `https://clinicaltrials.gov/api/v2/studies?query.term=&fields=NCTId,BriefTitle,OverallOfficialName` | none |
| Identity | Anthropic Messages API, `web_search` server tool, then a second forced-tool-use call for strict JSON | `ANTHROPIC_API_KEY` (already set) |

> **PubMed gotcha:** the author term must use initials — `Shaheen NJ[Author]`.
> A bare `Shaheen N` returns unrelated papers across all of medicine.

### The two-call AI pattern

The repo already uses forced tool-use for strict JSON (`ai-extractor.js`,
`intel-extractor.js`). Forcing `tool_choice` would prevent the model from
searching, so identity resolution is split:

1. **Call 1** — `web_search` enabled, `tool_choice: auto`. Returns prose plus
   per-sentence citations (`{url, title}`).
2. **Call 2** — forced tool use over call 1's text + citation list, producing
   `{is_physician, full_name, first_name, last_name, credentials, specialty,
   title, institution, city, state, confidence, evidence_urls}`.

Reuse `intel-extractor.js`'s `sanitize()` pass — the same delimiter-leak gotcha
documented in `CLAUDE.md` applies here.

---

## 7. Data model

```sql
create table if not exists public.app_external_profiles (
  id                  uuid primary key default gen_random_uuid(),
  lookup_email        text,          -- what we searched by
  resolved_npi        text,          -- from NPPES (nullable)
  in_bis              boolean not null default false,
  matched_facility_id text,          -- bis_facilities hit, if any
  profile             jsonb not null,  -- full provenance-tagged profile
  sources             jsonb not null,  -- [{source, url, fields[], retrievedAt}]
  confidence          int,
  created_at          timestamptz default now(),
  refreshed_at        timestamptz default now()
);
create unique index if not exists app_external_profiles_email_idx
  on public.app_external_profiles (lower(lookup_email));
create index if not exists app_external_profiles_npi_idx
  on public.app_external_profiles (resolved_npi);
```

14-day TTL on `refreshed_at`, then background refresh. Follows the existing
`app_*` convention; DDL is run by hand in the Supabase SQL editor, per
`CLAUDE.md`. Dev first, prod before go-live.

---

## 8. Integration points

| Location | Today | After |
|---|---|---|
| `app.js → buildNoMatch()` | "Nobody matched — pick who the meeting is with" + search box | Auto-enrich first; render the external card with badges. Search box becomes the fallback |
| `email-ingest.js → physiciansForEvent()` | miss ⇒ `[]`, no brief | miss ⇒ enqueue enrichment; send the instant brief with an `[EXTERNAL]` marker once resolved |
| `graph.physicianBriefHtml()` | unchanged | new sibling `externalBriefHtml()` — same layout plus badges and the Extra Intelligence block. The email == in-app invariant is preserved |
| `lead-match.js` | `matchedBy: null` | `matchedBy: 'external'` — Dynamics leads enrich too |
| `email-intel.js` "New to DB?" | flags only | flags **and** offers one-click enrichment |
| **new** `POST /api/enrich/:npi/promote` | — | rep-verified profile is written to `app_contacts`; `bis_*` stays read-only |

### Facility-only enrichment

When the attendee is a generic mailbox (`info@somegi.com`) or no physician
resolves:

1. Domain → organisation name (web search).
2. **NPPES organisation search** (`enumeration_type=NPI-2`) — verified working.
3. **CMS Hospital General Information name search** (`operator=like`) — verified
   working.
4. Match against `bis_facilities` on city + state + token overlap.
5. On a hit, surface that facility's BIS physicians and facility-level CPT
   volumes.

---

## 9. Cost, latency, caching

- **Web search:** $10 per 1,000 searches. On `claude-opus-4-8` ($5 / $25 per
  MTok) the measured call was ~20.6k in / 1.6k out plus 2 searches ⇒
  **≈ $0.15–0.20 per new physician**. On Sonnet-tier, ≈ $0.07.
- **Every other source is free** and needs no API key.
- **Latency:** free tiers ≈ 5 s combined; the web tier 15–25 s. Render free-tier
  results first, stream the identity block in.
- **Caching** (new, since none exists today): `app_external_profiles` keyed by
  lower(email) with a 14-day TTL, plus a small in-memory LRU per process.
  Repeat lookups cost nothing.
- **Guardrails:** per-day enrichment budget, internal-domain skip-list, and an
  early exit when the model reports `is_physician: false`.

---

## 10. Delivery phases

| Phase | Scope | Cost |
|---|---|---|
| **P1** ✅ | `sources/nppes.js`, `sources/cms-provider.js`, `rematch.js`, `provenance.js`, `states.js`, `http.js`, `GET /api/enrich` — **built and tested 2026-08-18**, see §13 | **$0 — no AI** |
| **P2** ✅ | `sources/web-identity.js` (web_search + citations + forced-tool-use JSON), `context.js` (organizer rule + title/description hints), confidence gating — **built and tested 2026-08-18**, see §14 | paid tier begins |
| **P3** ✅ | `externalBriefHtml()` + badges + Extra Intelligence block; `buildNoMatch()` auto-enrich — **built and tested 2026-08-18**, see §15 | — |
| **P4** | `app_external_profiles` cache + TTL; Open Payments, PubMed, ClinicalTrials extras | — |
| **P5** | `email-ingest` hook (unknown attendee ⇒ auto brief), `promote` flow, backfill script for the 5,179 email-less physicians | — |

P1 and P2 need no new credentials — `ANTHROPIC_API_KEY` is already configured and
`web_search` is enabled on it.

---

## 11. Open decisions

1. **Confidence threshold.** 98 % is unambiguous; 60 % (common surname, small
   private practice) is not. Proposed: **auto-show at ≥ 70, otherwise present
   "possible matches — confirm" chips** — mirroring the existing
   entity-matcher suggestion UX.
2. **Write policy.** Proposed: enrichment **never** writes to `bis_*`. It lives
   in `app_external_profiles`; only rep-verified data is promoted to
   `app_contacts`.
3. **Auto vs on-demand.** Proposed: **automatic** for calendar meetings (the rep
   should not have to ask), **on-demand** for Leads and the Email Sheet. Cost is
   already bounded by the P2 gating (§14) — the paid tier only fires when there
   is genuinely something to buy.
4. **Non-physician handling.** ✅ **Decided 2026-08-18.** No internal-domain
   skip-list — an exclusion by ROLE instead: **only attendees are matched, and
   the organizer (the rep who scheduled the meeting) is never matched, ever.**
   Meeting-room resources are excluded the same way. Non-clinicians additionally
   exit at `is_physician: false`, which is evidence-based rather than
   list-based, so nothing has to be configured or kept up to date.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Wrong person matched (common name) | Confidence gate; require NPPES corroboration of state/specialty before promoting to `verified`; show proof URLs so the rep can check in one click |
| Wrong facility matched | City + state filter plus token-overlap scoring — the naive `ilike` failure is documented in §3 |
| NPPES transient empty results | Retry with exponential backoff; treat 0-results as retryable, not authoritative |
| Cost runaway | Cache + TTL, per-day budget, skip-list, early `is_physician` exit |
| Stale external data | 14-day TTL with background refresh; `retrievedAt` rendered on every external field |
| Source markup / schema drift | Each source module is isolated and independently optional; a failing source omits its section rather than failing the profile |
| PHI / compliance | All sources are public government or public-web data; no patient data touched. `app_external_profiles` inherits the existing POC RLS caveat and must be tightened with the rest before production |


---

## 13. Phase 1 — what shipped

Built and verified 2026-08-18 on branch `feature/physician-facility-data-enrichment`.
No AI, no new credentials, no new dependencies; `bis_*` untouched.

```
src/enrichment/
  index.js              orchestrator: T0 → T0.5 → T2 → T3 → T4
  provenance.js         field(), tier precedence, conflicts, dropWhere()
  rematch.js            domain index, email name-hints, facility matching
  states.js             state code ↔ full name (bis_* holds names, CMS/NPPES codes)
  http.js               timeout + backoff + never-throw fetch wrapper
  sources/nppes.js      individuals, organisations, by-NPI
  sources/cms-provider.js  affiliation → CCN → hospital, hospital name search
src/routes/api.routes.js  GET /api/enrich
```

### API

`GET /api/enrich?email=&name=&firstName=&lastName=&state=&city=&npi=&facility=`
(session-authenticated, like every other `/api/*` route). At least one of
`email`, `name`, `lastName`, `npi` is required.

| `status` | Meaning |
|---|---|
| `in_bis` | Already in `bis_physicians` — use the existing brief, no enrichment |
| `recovered_in_bis` | Email was missing from the master, but the resolved NPI is in it |
| `external` | Genuinely outside BIS; registry profile returned (confidence ≥ 70) |
| `ambiguous` | Best match is 40–69 % — show as "possible match, confirm" |
| `facility_only` | Person unresolved, facility identified |
| `unresolved` | Nothing confident enough; candidates listed under `alternatives` |

The response carries `profile.fields`, `profile.extra` (the `+ EXTRA` group),
`profile.conflicts`, `profile.notes`, `profile.sources`, plus `matchedFacility`,
`colleagues`, `alternatives`, `confidence`, `tiers` and `elapsedMs`.

### Measured results

| Case | Input | Result |
|---|---|---|
| A | `lisa.gangarosa@unch.unc.edu` (in BIS) | `in_bis`, 100 %, **0 ms** |
| B | `nshaheen@med.unc.edu`, no hints | `unresolved` — 20 Shaheens nationwide, none confident. 4 alternatives listed. 5.4 s |
| C | same **+ `state=NC`** | `external`, **NPI 1467521757**, 71 %, facility → **HSOP105211** with the 6 GI colleagues. 1.9 s |
| D | `name=Nicholas Shaheen, MD&state=NC` | `external`, 100 %, same facility. 1.0 s |
| E | `jgreenwood@unch.unc.edu` (unknown person, known domain) | `ambiguous` 46 % + 3 alternatives; facility still resolved from the domain index. 7.1 s |
| F | `info@unch.unc.edu` (generic mailbox) | `facility_only`, 90 %, **3 ms** — recognised as an organisational address |
| G | `npi=1467521757` | `external`, 100 %, 1.0 s |
| H | `zzqqxx@nowhere-clinic-xyz.com` | `unresolved`, no false claim. 4.7 s |

Case C is the design's central claim, demonstrated end to end: a physician who
is **not** in `bis_physicians` is identified, and the brief is still populated
from BIS — the right facility, its territory and health system, and six real
colleagues — because the facility *is* in the master.

Candidate lookups run in parallel, which cut the worst case (H) from 17 s to
4.7 s.

### Known limits (addressed by P2)

- Without a state hint, a common surname cannot be resolved from the email
  alone — case B. The web identity tier reads the name and institution off the
  person's own page, which supplies exactly the missing hint.
- Only institutional address conventions are parsed (`first.last@`,
  `nshaheen@`). An opaque local part yields nothing until P2.
- Nothing is cached yet: every call re-queries the registries (P4).


---

## 14. Phase 2 — what shipped

Built and verified 2026-08-18. Adds the paid identity tier and the matching
rules the rep set.

```
src/enrichment/sources/web-identity.js   T1 — email → name, via Claude + web_search
src/enrichment/context.js                who to enrich + title/description hints
src/email-ingest.js, src/reminders.js    organizer rule enforced
src/routes/api.routes.js                 organizer rule + ?context= & ?useWeb=
```

### The matching rules

**Only attendees are matched. The organizer is never matched — ever.** The
organizer is the rep who scheduled the meeting; briefing them on themselves, or
spending an AI lookup on them, is always wrong. This is enforced in one place
(`context.attendeesToEnrich`) and applied at every site that resolves a
physician: the calendar API, the ingest engine's auto-brief and meeting-body
injection, and the reminder engine. Meeting rooms (`type: 'resource'`) and the
signed-in user are excluded by the same rule. **This replaces the
internal-domain skip-list** — an exclusion by role needs no configuration and
cannot go stale.

**The title and description are context, not identity.** They supply the
facility, city and other details the organizer typed in — resolved through the
existing entity-matcher, so a confident hit returns a real `bis_facilities` row
with its city and state. Person entities found there are ignored for
identification, and any that are really the organizer's own name are stripped
before the analysis is used anywhere.

### The web identity tier

Two calls, because they cannot be one: `web_search` needs `tool_choice: auto`
(forcing a tool would prevent searching), then a second forced-tool-use call
turns the findings into strict JSON — the repo's established pattern, including
the `sanitize()` delimiter-leak pass from `CLAUDE.md`.

**It uses the basic `web_search_20250305`, not the newer `web_search_20260209`.**
Measured head-to-head on the same prompt and model:

| Tool version | Time | Citations |
|---|---|---|
| `web_search_20250305` | **14 s** | **7 (4 unique proof URLs)** |
| `web_search_20260209` | 200 s+, once a 396 s timeout | **0** |

The newer variant filters results through code execution, which appears to cost
the per-sentence citations. Citations are not a nice-to-have here — a
web-sourced field with no link to prove it is exactly what this design refuses
to render.

### Cost gating

The paid call fires only when there is something to buy. It is skipped when the
caller already supplied a name, when the mailbox is organisational (`info@`,
`scheduling@`…), when `ANTHROPIC_API_KEY` is unset, or when the caller passes
`useWeb=never`. `useWeb=always` forces it. A confident `is_physician: false`
ends the enrichment immediately — before any registry call.

### Measured results

| Case | Result | Paid call |
|---|---|---|
| `nshaheen@med.unc.edu`, **email only, no hints** | `external`, **98 %**, NPI 1467521757, facility **HSOP105211** + 6 GI colleagues, 4 proof URLs. 41 s | yes — 2 searches, 24.4k in / 2.1k out |
| same, `useWeb=never` | `unresolved` (P1 behaviour, unchanged), 5.1 s | no |
| `info@unch.unc.edu` | `facility_only`, 90 %, 3 ms | no |
| `name=Nicholas Shaheen&state=NC` | `external`, 100 %, 1.0 s | no |
| `abdul@primathon.in` (real non-clinician) | `not_physician` — "Technology Advisor / Director", no brief produced. 33 s | yes, then stopped |
| Meeting with organizer + physician + room + colleague | enriches **only** the two non-organizer people; room and organizer dropped | — |

The first row is the case Phase 1 could not solve: with no state hint, twenty
Shaheens nationwide made the registry ambiguous. The web tier reads the name and
institution off the person's own faculty page — including a page that prints the
email address verbatim — and that supplies the missing hint. Evidence recorded
with it: *"The email nshaheen@med.unc.edu appears directly next to Nicholas J.
Shaheen…"*

### Known limits

- 41 s end-to-end when the paid tier runs. The free tiers resolve in 1–5 s, so
  P3's UI should render those first and stream the identity block in.
- For a non-physician the *identity* may be imprecise (it only has to be
  confident that the person is not a clinician) — nothing is rendered from it.
- Still no caching: every call re-queries (P4).


---

## 15. Phase 3 — what shipped

Built and verified 2026-08-18. The enrichment is now visible in the app, and
the title-based person fallback is gone.

```
src/graph.js               + externalBriefHtml()  (sibling of physicianBriefHtml)
src/routes/api.routes.js   /api/enrich now returns rendered `html`
public/app.js              buildEnrichment() — auto-lookup inside a meeting
public/styles.css          .enrich* card framing
src/email-ingest.js        title→person fallback REMOVED
src/reminders.js           title→person fallback REMOVED
```

### Identity is now attendee-email only

Both engines previously fell back to matching a PERSON out of the meeting
title/description when no attendee email matched. That is removed. These are the
functions that send the automatic brief email and inject the brief into the
meeting body, so a wrong guess mails the wrong physician's data to the rep. The
reminder engine still honours the physician the rep **explicitly scheduled**
with (`app_activities`), which is a recorded choice rather than a guess, and the
title/description still supply facility context — just never an identity.

### The rendered brief

`externalBriefHtml(result)` is a deliberate sibling of `physicianBriefHtml`,
not a branch inside it: this brief carries things the BIS one never does.

- **Origin banner** — ⚠️ not in BIS / ✅ recovered from BIS / 🚫 non-physician,
  plus a green banner naming the BIS facility when one was matched, so the rep
  can see at a glance which data is their own.
- **Per-field provenance** — every row shows its badge (🟢 BIS · 🔵 Verified ·
  🟡 Web · ⚪ Inferred), its source name, and a 🔗 to the page that proves it.
- **Extra Intelligence** — fields BIS has no column for, under a
  `+ EXTRA — not held in BIS` tag: title, institution, licence, CMS star rating,
  ownership, CCN, and the clickable evidence URLs.
- **Source disagreements** — rendered, never silently resolved. A live example:
  *kept **NICHOLAS J SHAHEEN** (NPPES) over "Nicholas James Shaheen" (Web)*;
  *kept **UNC Hospitals Chapel Hill North Carolina** (BIS) over "UNC HOSPITALS"
  (CMS)*.
- **Colleagues at this facility** — from BIS, the payoff when the person
  themselves is absent from the master.
- **Sources footer** — one line per source listing exactly which fields it fed.
- Headings adapt: with no person resolved the table is titled *Facility
  details*, not *Physician details*.

### In the app

Opening a meeting whose attendees are not in BIS now runs the lookup
automatically, one card per attendee — **and never for the organizer**, filtered
on the client as well as the server.

The lookup is two-stage on purpose: the free tiers answer in 1–5 s and run
automatically, and the ~40 s paid web tier sits behind a **"🔎 Identify with web
search"** button that only appears when the free tiers actually fell short
(`unresolved`, `facility_only`, `ambiguous`). The rep sees something
immediately, and no meeting costs money just by being opened.

`/api/enrich` returns the rendered `html` alongside the JSON — the same
convention `/api/physicians/:npi/brief` and `/api/leads/match` already follow. A
physician already in BIS gets the **standard** brief (nothing about them is
enriched); a recovered one gets the origin banner followed by their full BIS
brief.
