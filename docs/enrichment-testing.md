# Enrichment Agent — Testing & Verification Guide

**Date:** 2026-08-18 · **Covers:** `docs/external-enrichment-agent.md` Phases 1–5

Every example below was run against the live dev data and the real public APIs —
the expected outputs are what actually came back, not what should theoretically
happen. Two ways to test: the terminal (fast, no calendar needed) and a real
Outlook meeting (true end-to-end).

---

## 0. Setup, once

```bash
# 1. Create the cache table — DDL is applied by hand (see CLAUDE.md).
#    Paste supabase/enrichment-setup.sql into the DEV project's SQL editor.
#    Until this is run the agent still works; it just caches in-process only
#    and logs one warning.

# 2. Confirm the environment
#    SUPABASE_ENV=development   → the 21,274-physician dev directory
#    ANTHROPIC_API_KEY set      → the paid web tier is available

npm run dev        # http://localhost:3002
```

Sign in at `/auth/login` before testing anything through the UI.

---

## 1. Fast path — test every case from the terminal

```
npm run enrich:try -- <email> [--free|--web] [--state NC] [--refresh] [--html]
```

`--free` = free registries only (no cost). `--web` forces the paid lookup.
`--refresh` ignores the cache. `--html` prints the rendered brief instead of the
summary.

### The seven outcomes

| # | Command | Expected `STATUS` | What it proves |
|---|---|---|---|
| 1 | `npm run enrich:try -- afrost@pennmedicine.upenn.edu` | `in_bis` · 100 · **0 ms** | Already in BIS → no enrichment, standard brief |
| 2 | `npm run enrich:try -- lisa.gangarosa@unchealth.org --free` | `recovered_in_bis` · 90 | **An email miss is not a physician miss** |
| 3 | `npm run enrich:try -- nshaheen@med.unc.edu --state NC --free` | `external` · 71 | Free tiers alone identify someone outside BIS |
| 4 | `npm run enrich:try -- nshaheen@med.unc.edu --web --refresh` | `external` · 98 | The paid tier, with proof URLs (~40 s) |
| 5 | `npm run enrich:try -- info@unch.unc.edu` | `facility_only` · 90 · **< 0.5 s** | Shared mailbox → facility, and no money spent |
| 6 | `npm run enrich:try -- abdul@primathon.in` | `not_physician` | Stops before any registry call |
| 7 | `npm run enrich:try -- zzqqxx@nowhere-clinic-xyz.com --free` | `unresolved` | Refuses to invent a person |

### Case 2 in full — the one that matters most

```
$ npm run enrich:try -- lisa.gangarosa@unchealth.org --free

STATUS      recovered_in_bis   (confidence 90)
NPI         1508935800
TIERS       T0:miss → T2:nppes-search → T3:recovered-by-npi → T4:pubmed → T4:cms-affiliation
BIS MATCH   Lisa M Gangarosa — Gastroenterology
BIS FACILITY UNC Hospitals Chapel Hill North Carolina [HSOP105211]
COLLEAGUES  Julia W Tang, Andrew J Gilman, Animesh Jain, Craig Reed, Neil D Shah
```

She **is** in `bis_physicians` as `lisa.gangarosa@unch.unc.edu`. Invited from a
different address, the old code saw nothing. Now the agent resolves her NPI from
the registry and recovers the whole BIS record. No AI, no cost.

### Case 3 vs 4 — why the paid tier exists

```bash
npm run enrich:try -- nshaheen@med.unc.edu --free            # unresolved
npm run enrich:try -- nshaheen@med.unc.edu --free --state NC # external, 71%
npm run enrich:try -- nshaheen@med.unc.edu --web --refresh   # external, 98% + proof URLs
```

Without a state hint there are twenty Shaheens across the US and the agent
correctly refuses to pick one. Give it the state and it lands on
**NPI 1467521757**. The web tier supplies that hint on its own, by reading his
UNC faculty page — and cites the pages that prove it, including one printing the
email address verbatim.

### Verify the provenance rendering

```bash
npm run enrich:try -- nshaheen@med.unc.edu --html > /tmp/brief.html && open /tmp/brief.html
```

Check for: the ⚠️ *not in your BIS database* banner, the green **Facility found
in BIS** banner, a badge (🟢/🔵/🟡/⚪) and 🔗 on every row, the
**+ EXTRA — not held in BIS** block, and **Source disagreements** listing where
BIS/NPPES overrode the web.

---

## 2. Real path — create meetings in Outlook

Book these in the calendar the app is signed in to. The rep's own address is the
**organizer** in every case; that is deliberate — it is what proves the
organizer rule.

### Test A — physician already in BIS (baseline)

| | |
|---|---|
| **Subject** | `Lumendi DiLumen — Dr Frost` |
| **Attendee** | `afrost@pennmedicine.upenn.edu` |

**Expect:** the meeting expands to the normal physician block (brief, email
intelligence, notes, actions). **No** enrichment card — nothing was enriched.

### Test B — email missing from BIS, physician is not

| | |
|---|---|
| **Subject** | `UNC GI catch-up` |
| **Attendee** | `lisa.gangarosa@unchealth.org` |

**Expect:** an *External lookup* card resolving to **Lisa M Gangarosa**,
`recovered_in_bis`, linked to **HSOP105211** with her five colleagues. Within
five minutes the ingest tick also emails the normal brief and links the meeting
to her NPI — check `[ingest] instant brief sent` in the server log.

### Test C — genuinely outside BIS

| | |
|---|---|
| **Subject** | `DiLumen intro — UNC Hospitals GI` |
| **Attendee** | `nshaheen@med.unc.edu` |

**Expect:** the card appears within a few seconds from the free tiers. Because
the address alone is ambiguous, press **🔎 Identify with web search** — after
~40 s it resolves to Nicholas Shaheen at 98% with clickable proof URLs, the
facility matched to HSOP105211, and Extra Intelligence showing industry
payments, publications and trials.

The ingest tick separately emails a **🔎 Outside BIS: …** brief. Check the
server log for `[ingest] external brief sent`.

### Test D — the organizer must never be matched

| | |
|---|---|
| **Subject** | `Internal sync` |
| **Attendees** | your own address **only** (you are also the organizer) |

**Expect:** *no* enrichment card, *no* brief, no paid call. Then add a physician:

| | |
|---|---|
| **Subject** | `UNC GI + internal` |
| **Attendees** | your own address **and** `nshaheen@med.unc.edu` |

**Expect:** exactly **one** card — for the physician. Your own address is
skipped even though it is on the attendee list. Add a meeting room to the invite
and confirm it is skipped too.

### Test E — title and description as context

| | |
|---|---|
| **Subject** | `Lumendi demo — Cleveland Clinic Mayfield Hts` |
| **Description** | `ESD volumes discussion` |
| **Attendee** | anyone not in BIS |

**Expect:** the facility resolves from the *title* to
**HSOP101167 — Cleveland Clinic Mayfield Heights Ohio** and is passed to the
lookup as a hint. Confirm the reverse too: put a **person's** name in the title
and check it is *not* used to identify anyone — identity only ever comes from
the attendee's email address.

### Test F — shared mailbox

| | |
|---|---|
| **Subject** | `UNC Hospitals — scheduling` |
| **Attendee** | `info@unch.unc.edu` |

**Expect:** `facility_only` almost instantly (the domain index is built on first
use, then it is sub-millisecond), facility HSOP105211 plus its physicians,
and **no** paid call — the agent recognises an organisational address.

---

## 3. Verify the rules explicitly

### Cost guards — confirm money is only spent when it must be

```bash
npm run enrich:try -- nshaheen@med.unc.edu --free    # PAID LOOKUP line absent
npm run enrich:try -- info@unch.unc.edu              # absent — shared mailbox
npm run enrich:try -- --name "Nicholas Shaheen" --state NC   # absent — name supplied
npm run enrich:try -- nshaheen@med.unc.edu --web --refresh   # present: N searches, tokens
```

Only the last one prints a `PAID LOOKUP` line. In the UI, simply opening a
meeting never spends — the web tier is behind the button.

### Cache

```bash
npm run enrich:try -- nshaheen@med.unc.edu --web --refresh   # ~40 s
npm run enrich:try -- nshaheen@med.unc.edu                   # ~0 ms, "from cache"
npm run enrich:try -- nshaheen@med.unc.edu --refresh         # full run again
```

Cache rules worth confirming: a BIS hit is never cached (case 1 stays 0 ms
because it is a live in-memory lookup), a failure is never cached (repeat case 7
and watch it retry rather than answer instantly), and a free-tier answer never
satisfies a request that wants the paid tier.

### Backfill

```bash
npm run enrich:backfill -- --facility HSOP105211 --limit 6
```

Expect all six UNC gastroenterologists as `recovered_in_bis`, with **Neil D Shah
— $26,959 from 5 companies** among them. Add `--write` to store the results.
`--missing-email --limit 20` targets the 5,179 physicians with no address; note
that sweeping all of them through the paid tier would cost roughly **$780**, so
the defaults are free-tier, 20 rows, dry run.

### Promote

```bash
curl -X POST http://localhost:3002/api/enrich/promote \
  -H 'content-type: application/json' -b <your session cookie> \
  -d '{"npi":"1467521757","email":"nshaheen@med.unc.edu","confidence":98,"source":"web"}'
```

Then confirm the row in `app_contacts` and that the brief's **Contact
Intelligence** section shows it, with `source` recording who confirmed it.

---

## 4. The edge case worth seeing

```bash
npm run enrich:try -- agilman@unchealth.org --free   # unresolved (39%)
npm run enrich:try -- agilman@unchealth.org --web    # external, 95% — ANDREW L GILMAN
```

BIS holds **Andrew J Gilman** (NPI 1336534387) at UNC. The web tier, working
from a guessed address, confidently resolves **Andrew L Gilman** (NPI
1770673477) — a different middle initial, and `external` rather than
`recovered_in_bis`.

Neither answer is obviously wrong from the outside, which is exactly the point:
a high confidence score is not certainty. This is why every field carries a
source link, why disagreements are shown rather than resolved silently, and why
promoting anything into `app_contacts` requires a person to press the button.
When two candidates are this close, open the proof URLs before trusting either.

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Everything returns `unresolved`, log shows `[enrichment:nppes] giving up … fetch failed` | **DNS**, not the app. `npiregistry.cms.hhs.gov` intermittently `SERVFAIL`s on the local router (192.168.31.1) while 8.8.8.8 resolves it fine — seen twice during development | `nslookup npiregistry.cms.hhs.gov 8.8.8.8` to confirm, then point the router/host at 8.8.8.8 or 1.1.1.1. The agent degrades safely meanwhile and never caches the failure |
| `[enrichment:cache] app_external_profiles not found` | Setup SQL not run | Run `supabase/enrichment-setup.sql`; caching stays in-process until then |
| `PAID LOOKUP` never appears | `ANTHROPIC_API_KEY` unset, or the caller supplied a name / used a shared mailbox | Check the key; force with `--web` |
| Publication count looks implausible | A common surname. The count is narrowed by affiliation **and** specialty, and labelled *"surname match only"* when it cannot be | Open the `searchTerm` in PubMed and check |
| No enrichment card in the UI | An attendee already matched BIS (nothing to enrich), or the only attendee is the organizer | Check `status` via `npm run enrich:try` |
