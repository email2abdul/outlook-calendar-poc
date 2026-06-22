# KT / Developer Handoff (Hinglish)

**Kisi developer ko project handover karne ke liye complete guide.**
Architecture, har file ka role, data kahan se aata hai, scripts kaise chalte
hain, aur kya gotchas hain — sab yahan hai.

> Pehle ek baar **DEMO_README.md** padh lo — wo batata hai product kya karta hai.
> Ye file batati hai *andar se kaise kaam karta hai*.

---

## 1. Ek line me

Node.js + Express app jo Outlook (Microsoft Graph) se calendar/email padhta hai,
Supabase me rakhe medical data (physician directory + procedure analytics) se ek
**pre-meeting briefing** banata hai, aur use **email** kar deta hai — meeting se
90 min pehle ya meeting schedule karte hi.

**Stack:** Node.js, Express, `@microsoft/microsoft-graph-client` + MSAL (OAuth),
Supabase (Postgres, Data API via `@supabase/supabase-js`), `@anthropic-ai/sdk`
(Claude, sirf product-brochure ingest ke liye), SQLite/Redis (sessions + tokens).

---

## 2. Architecture & data flow

```
  Browser ── login ──► Express (server.js)
                        │
   Microsoft Graph ◄────┤  auth.js / token-store.js  (OAuth, per-user tokens)
   (calendar, email,    │
    sendMail)           │
                        ▼
              ┌─────────────────────────────────────────┐
              │  BRIEFING ENGINE                          │
              │  reminders.js (90-min poll)               │
              │  + api.routes.js (schedule / send-brief)  │
              └───────────────┬───────────────────────────┘
                              │ physician matched
                              ▼
              analytics.getLabelledAnalytics(npi)  ◄── ek jagah jahan sab juड़ता hai
                              │
        ┌─────────────┬───────┴───────┬──────────────┬───────────────┐
        ▼             ▼               ▼              ▼               ▼
   byFamily     commercialSignals  accountOpp   productContext   lumendiAccount
   (P1)         (P2)               (P3+P5)      (P6)             (P5)
        │             │               │              │               │
        └─────────────┴───────────────┴──────────────┴───────────────┘
                              │
                              ▼
                graph.sendPhysicianBriefing(...)  ──► HTML email ──► rep ka inbox
                              ▲
                contacts-store.getContact(npi) (P4) ─┘  (callers pass karte hain)
```

**Key idea:** `analytics.getLabelledAnalytics(npi)` ek central function hai jo
ek physician ka **saara intelligence** ek object me jod deta hai. Briefing usi
object ko render karti hai. Naya section add karna ho to mostly yahin + `graph.js`
ke ek HTML helper me change hota hai.

---

## 3. Data sources (ye sabse important samajhna)

### a) Supabase — do projects, ek switch
- **`SUPABASE_ENV`** (`development` | `production`) poori app ko flip karta hai.
  Logic: `src/supabase.js`.
- **dev** = `nnzcaonhhsvvlcwoddxa` · **prod** = `tjcgqdqvajaifiljawwn` (teammate ka).
- `src/supabase.js` `SUPABASE_{DEV,PROD}_URL/_ANON_KEY` resolve karta hai; legacy
  flat `SUPABASE_URL/SUPABASE_ANON_KEY` fallback hai.
- App hamesha **anon key** use karta hai (read + POC writes).

### b) `bis_*` tables (master data — read-only, real data)
- `bis_physicians`, `bis_facilities`, `bis_procedure_volumes` (~2.25M rows,
  2018–2024), `bis_cpt_reimbursement`.
- Inhe SQL functions ke through padha jaata hai: `bis_directory`,
  `bis_search_physicians`, `bis_physician_analytics(p_npi)`.
- ⚠️ **DEV me sirf 2024 ka data hai**, PROD me 2018–2024 multi-year. Isliye
  growth-trend jaise signals DEV pe "flat" dikhte hain, PROD pe rich.

### c) `app_*` tables (is app ki apni tables)
- `app_activities`, `app_emails`, `app_audit_log` (email-intelligence Phase 0/1).
- `app_contacts` (P4 — contact metadata overlay).
- `app_accounts` (P5 — Lumendi product usage).
- Inka RLS **permissive anon-all** hai (POC posture) — isliye importer scripts
  anon key se hi likh sakte hain, service-role nahi chahiye.

---

## 4. Repo layout (sirf important files)

```
server.js                 Express entry; session store (SQLite/Redis); routes mount
src/
  config.js               env parsing
  supabase.js             dev/prod switch → ek shared Supabase client
  auth.js                 MSAL OAuth (login, token refresh)
  token-store.js          per-user MSAL tokens + mail delta + reminder sent-log
  graph.js                Microsoft Graph wrapper + briefing HTML builder ★
  physicians.js           in-memory physician/facility directory (Supabase se load)
  analytics.js            procedure analytics + P1/P2/P3/P5 derivations ★
  procedure-families.js   CPT → Colonoscopy/EMR/ESD/EUS classifier (P1)
  product-context.js      brochure product knowledge → talking points match (P6)
  contacts-store.js       app_contacts read/write (P4)
  accounts-store.js       app_accounts read/write (P5)
  entity-matcher.js       text → physician/facility matching engine
  reminders.js            90-min pre-meeting briefing poller ★
  email-ingest.js         Outlook inbox delta → app_emails (email-intelligence)
  crm-store.js, notes.js, redis.js
  routes/
    auth.routes.js        /auth/login, /callback, /logout, Graph webhooks
    api.routes.js         /api/* (calendar, physicians, analytics, schedule, send-briefing) ★
scripts/
  ingest.js               (legacy) local analytics ingest
  ingest-products.js      P6 — brochure PDFs → Claude → config/product-context.json
  import-contacts.js      P4 — CSV → app_contacts
  import-accounts.js      P5 — CSV → app_accounts
supabase/
  setup.sql               base app_* + bis_* (prod-style)
  dev-setup.sql           dev project provisioning (functions + RLS, no data)
  contacts-setup.sql      P4 — app_contacts table + RLS
  accounts-setup.sql      P5 — app_accounts table + RLS
config/
  product-context.json    P6 output (abhi PLACEHOLDER seed)
  entity-aliases.json     entity-matcher aliases
data/
  contacts-seed.csv       P4 demo data
  accounts-seed.csv       P5 demo data
docs/
  email-intelligence-design.md   (alag thread — reply→MOM→CRM design)
```
★ = sabse zyada chhua jaata hai.

---

## 5. Environment variables

```ini
# Microsoft / Azure (OAuth)
MS_CLIENT_ID=            # Azure app registration → Application (client) ID
MS_CLIENT_SECRET=        # Certificates & secrets → secret VALUE
MS_TENANT_ID=common
REDIRECT_URI=http://localhost:3000/auth/callback   # Azure me bilkul match kare
POST_LOGIN_REDIRECT=/
SESSION_SECRET=          # lamba random string
PORT=3000
NODE_ENV=development

# Supabase — dev/prod switch
SUPABASE_ENV=development
SUPABASE_DEV_URL=https://nnzcaonhhsvvlcwoddxa.supabase.co
SUPABASE_DEV_ANON_KEY=
SUPABASE_PROD_URL=https://tjcgqdqvajaifiljawwn.supabase.co
SUPABASE_PROD_ANON_KEY=
# SUPABASE_DEV_SERVICE_ROLE_KEY=   # admin/seed scripts ke liye (app use nahi karta)

# Claude — sirf product brochure ingest ke liye (per-briefing koi API call nahi)
ANTHROPIC_API_KEY=

# Optional
# REDIS_URL=             # serverless hosts pe sessions/notes Redis me
# REMINDER_LEAD_MINUTES=90  REMINDER_POLL_SECONDS=300  REMINDERS_ENABLED=true
# INGEST_POLL_SECONDS=300   INGEST_ENABLED=true
```

> `.env` gitignored hai. Demo me ye **development** pe set hai.

---

## 6. Lumendi briefing — phase-by-phase (jo is project me bana)

Customer spec: `Gmail - Fwd_ Product Brochures.pdf` (Eric Coolidge → BIS →
RevWorx). Briefing ke 6 sections mapko code se:

### P1 — Procedure Intelligence  (`procedure-families.js`, `analytics.js`, `graph.js`)
- Master me CPT sirf Diagnostic/Therapeutic/Screening me bata hai — Lumendi ki
  families (Colonoscopy/EMR/ESD/EUS) nahi. Isliye `classifyCpt()` = CPT-code map
  + description-keyword fallback.
- `analytics.getProcedureFamilies(npi)` physician ke **poore per-CPT volumes**
  raw `bis_procedure_volumes` se padhta hai (top-N RPC nahi, kyunki ESD/EUS
  low-volume hote hain aur top-N me se gir jaate). `data.byFamily` attach.
- Render: `graph.procedureIntelligenceHtml`.

### P2 — Commercial Signals  (`analytics.js`, `graph.js`)
- `computeCommercialSignals()`: growth trend (year-range %, "YoY" word jaan-bujh
  ke hata diya kyunki years non-consecutive ho sakte hain), emerging ESD/EMR/EUS,
  therapeutic adoption. `data.commercialSignals`.
- Render: `graph.commercialSignalsHtml`.

### P3 — Account Opportunity  (`analytics.js`, `graph.js`)
- `getAccountOpportunity(npi)`: facility ke physicians = directory peers ∪ jinka
  facility pe procedure volume hai, minus khud; volume se ranked.
- Render: `graph.accountOpportunityHtml`. `data.accountOpportunity`.

### P4 — Contact Intelligence  (`contacts-store.js`, `import-contacts.js`, `contacts-setup.sql`)
- `app_contacts` table = directory ke base email/phone/linkedin ke upar **trust
  metadata overlay** (confidence, last_verified, last_refresh + optional overrides).
- `contacts-store.getContact(npi)` read. **Note:** ye briefing me callers pass
  karte hain (`reminders.js` + `api.routes.js` ke 3 call sites) — analytics object
  me attach nahi (kyunki ye physician-scoped hai, analytics nahi).
- Render: `graph.contactIntelligenceHtml`.

### P5 — Lumendi account status  (`accounts-store.js`, `import-accounts.js`, `accounts-setup.sql`)
- `app_accounts` table: npi → product/status/since. Active user = status
  `active|trial`.
- Do jagah render hota hai:
  - Per-physician status → `data.lumendiAccount` → Commercial Signals me.
  - Per-facility "N using Dilumen" → `getAccountOpportunity` ek hi accounts read
    me self+peers ka usage nikalta hai → `lumendiUserCount` + per-peer badge →
    Account Opportunity me.

### P6 — Product Context Layer (AI)  (`ingest-products.js`, `product-context.js`, `graph.js`)
- **Do-stage, taaki per-briefing koi LLM call na ho:**
  - **Ingest (rare):** `npm run ingest:products <pdfs>` — har brochure PDF →
    Claude `claude-opus-4-8` **forced tool-use** (strict `record_product` schema)
    → `config/product-context.json`. (forced tool_choice + thinking incompatible
    hain, isliye schema guarantee pe rely karte hain.)
  - **Match (per-brief, deterministic):** `product-context.getTalkingPoints(byFamily)`
    physician ki families se products match karta hai (intersection), volume se
    rank. `data.productContext`.
- Render: `graph.productContextHtml` ("What to Discuss").

> **Itihaas:** P0 = dev/prod switch + email-intelligence Phase 0/1 (pehle se).
> Is handoff ka kaam = **P1–P6**, sab committed (git log dekho: commits
> `c720a25` se `1123e08` tak).

---

## 7. Scripts kaise chalayein

```bash
# P6 — brochure PDFs se product knowledge (ANTHROPIC_API_KEY chahiye)
#   PDFs ./brochures/ me daalo, ya paths do:
npm run ingest:products data/EZ1.pdf data/C1.pdf ...
#   → config/product-context.json overwrite karta hai

# P4 — contacts import (active SUPABASE_ENV pe likhता hai)
SUPABASE_ENV=development npm run import:contacts data/contacts-seed.csv

# P5 — accounts import
SUPABASE_ENV=development npm run import:accounts data/accounts-seed.csv
```

CSV formats:
- contacts: `npi,email,mobile,linkedin_url,confidence_score,last_verified,last_refresh,source`
- accounts: `npi,product,status,since_date,source`  (status: active|trial|lapsed|prospect)
- sirf `npi` required hai; khali cells null ban jaate hain.

---

## 8. Database setup (DDL kahan chalti hai) — ⚠️ important gotcha

- Supabase **MCP sirf PROD** (`tjcgqdqvajaifiljawwn`) dekhta hai. **DEV ka DB
  password nahi hai**, sirf anon + service-role JWT (jo DDL nahi kar sakte).
- Iska matlab: **naye tables DEV me banane ke liye SQL Supabase dashboard ke
  SQL Editor me manually run karni padti hai.**
- Jo SQLs run hone chahiye (har project me ek baar):
  - `supabase/contacts-setup.sql` → `app_contacts`
  - `supabase/accounts-setup.sql` → `app_accounts`
- **Abhi tak ye DEV me run ho chuki hain. PROD me NAHI.** Go-live pe PROD ke SQL
  editor me dono chalani hongi.

---

## 9. Local run

```bash
npm install
cp .env.example .env      # bharo (section 5)
npm start                 # http://localhost:3000
# dev me auto-reload: npm run dev
```

Boot pe console batata hai: kaunsa Supabase env, analytics backend, reminder &
ingest engines on/off.

---

## 10. Testing approach

- Is project me formal test suite nahi hai; **verification throwaway Node
  scripts** se hui (har phase live dev/prod data ke against — 8–18 tests/phase,
  sab pass).
- Testability ke liye `graph.js` ke HTML helpers exported hain
  (`analyticsHtml`, `commercialSignalsHtml`, `accountOpportunityHtml`,
  `contactIntelligenceHtml`, `productContextHtml`) — inhe mock data de ke render
  verify kar sakte ho.
- Pattern: `SUPABASE_ENV=... node -e "require(...)"` se module load + ek physician
  pe `getLabelledAnalytics(npi)` chala ke object inspect karo.

---

## 11. Known limitations / abhi kya pending hai

**Code complete, sirf real data/ops baaki:**
1. **Brochures:** asli 4 Lumendi PDFs `./brochures/` me daal ke
   `npm run ingest:products` — abhi `config/product-context.json` PLACEHOLDER hai.
2. **Real contacts/accounts:** demo seeds ki jagah asli CSVs import karo.
3. **PROD tables:** `contacts-setup.sql` + `accounts-setup.sql` PROD me run karo.

**Optional / future (P7):**
- Health System aur Territory identification — facility data me ye columns nahi
  (mapping data chahiye).
- Standalone mobile-friendly brief view (abhi HTML email mobile pe render hota
  hai, dedicated page nahi).
- RLS tighten karna (abhi POC anon-all hai — production se pehle lock down karo).

**Behavioral notes:**
- DEV me sirf 2024 data → growth signals flat; demo PROD pe richer.
- `.env` ek baar mid-development rewrite hua tha; `SUPABASE_ENV=development` +
  dev/prod switch vars restore kiye gaye.

---

## 12. Go-live checklist (PROD)

- [ ] `.env` me `SUPABASE_ENV=production` + PROD URL/anon key
- [ ] PROD SQL editor me `contacts-setup.sql` + `accounts-setup.sql` run
- [ ] Asli contacts/accounts CSVs PROD pe import
- [ ] Asli brochures ingest → real `config/product-context.json`
- [ ] `REDIRECT_URI` production URL pe + Azure app registration me update
- [ ] `NODE_ENV=production`, behind HTTPS, `REDIS_URL` set (serverless ho to)
- [ ] RLS policies tighten (anon-all hata ke proper auth)
- [ ] Graph webhook (`/auth/webhooks/outlook`) + `GRAPH_WEBHOOK_SECRET` set

---

## 13. API endpoints (quick reference)

```
GET  /auth/login · /auth/callback · POST /auth/logout
GET|POST /auth/webhooks/outlook            Graph change-notifications
GET  /api/me                               signed-in user
GET  /api/calendar/today · /api/calendar/day
POST /api/calendar/schedule                meeting banao → auto-briefing email
GET  /api/physicians/search · /api/physicians/:npi
GET  /api/physicians/:npi/analytics        ← P1–P6 sab is object me aata hai
GET|POST /api/physicians/:npi/notes
POST /api/physicians/:npi/send-briefing     manual briefing trigger
POST /api/entities/analyze                  text → matched entities
GET  /api/activities · /api/activities/:id/emails · POST /api/ingest/run
```

---

*Koi bhi naya briefing section add karna ho: (1) `analytics.getLabelledAnalytics`
me data attach karo, (2) `graph.js` me ek `xxxHtml()` helper banao, (3) usko
`sendPhysicianBriefing` ke content array me daalo. Bas.*
