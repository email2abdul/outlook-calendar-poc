# Dynamics 365 Leads — Poora Kaam ka Record (Hinglish)

> Ye file batati hai ki **Dynamics 365 Leads read** feature kaise banaya gaya —
> shuru se aakhir tak, har step. Naya banda bhi isse padh ke poora setup +
> code samajh sakta hai. Date: **2026-07-07**, branch `feat-add-dynamic365-lead-read`,
> commit `3f9037b`.
>
> ⚠️ **Secret yahan NAHI hai** (ye file git mein commit hoti hai). Client SECRET
> sirf `.env` mein rehta hai. Client ID / Tenant ID identifiers hain (secret nahi).

---

## 1. Feature kya hai

Outlook Calendar app ke topbar mein ek **👥 Leads** button. Click karne pe modal
khulta hai jismein **Dynamics 365 (Dataverse) ke Lead records** dikhte hain —
har lead ka **Name, Email, Status, Owner, Created**. Saath mein **search**
(naam/email/status/owner) + **pagination** (20 per page).

Ye Outlook/Graph wale login se **poori tarah alag** hai — apna alag app
registration + apni auth use karta hai.

---

## 2. Sabse pehle: 3 alag accounts ka confusion (IMPORTANT)

Is project mein 3 alag Microsoft accounts the, isliye pehle ye clear karna zaroori tha:

| Account | Kaam | Dynamics feature mein role |
|---|---|---|
| `abduljmi2009@outlook.com` | App ka Outlook login (calendar/mail) | ❌ Irrelevant |
| `wajid.jmi@gmail.com` | Personal Azure portal | ⚠️ **GALAT tenant** — ispe app mat banao |
| **`admin@revworx.io`** | Dynamics 365 admin | ✅ **SIRF yahi matter karta hai** |

**Golden rule:** App registration us Entra tenant mein banti hai jo **Dynamics org
ko own** karta hai = **`revworx.io`** (admin@revworx.io wala). Gmail wale personal
tenant pe banaoge toh token Dynamics pe kaam **nahi** karega.

**Auth flow = Client Credentials (app-only)** chuna — kyunki:
- App khud ko authenticate karta hai (koi user login nahi) → runtime pe kaunsa
  Outlook/Gmail account hai, isse **koi farak nahi padta**
- Federated Gmail Outlook login Dynamics mein valid user nahi tha, isliye
  delegated flow risky tha → app-only best fit.

---

## 3. Dynamics setup (portal ka kaam — `admin@revworx.io` se login)

> Har step **incognito window** mein `admin@revworx.io` se — gmail/outlook session mix na ho.

### STEP A — App Registration (`portal.azure.com`)
1. Entra ID → App registrations → **New registration**
2. Name: `dynamics-lead-reader`, type: **Single tenant**, Redirect URI khali → Register
3. Overview se copy: **Application (client) ID** + **Directory (tenant) ID**
4. Certificates & secrets → **New client secret** → **Value copy** (ek hi baar dikhta hai) → ye `DYNAMICS_CLIENT_SECRET`

### STEP B — Application User (`admin.powerplatform.microsoft.com`)
Ye step app ko Dynamics tak access deta hai. Iske bina 401 aata hai.
1. Environments → apna environment (`orgfa1d2553`) select
2. Settings → **Users + permissions → Application users → New app user**
3. **Add an app** → Client ID paste → select
4. **Business unit:** `orgfa1d2553` (root — mandatory, yahi ek option aata hai)
5. **Security roles:** **Salesperson** (Lead pe Read deta hai) → Save → **Create**

### STEP C — curl test (code se pehle)
```bash
# token lo
curl -X POST "https://login.microsoftonline.com/<TENANT_ID>/oauth2/v2.0/token" \
  -d "grant_type=client_credentials" \
  --data-urlencode "client_id=<CLIENT_ID>" \
  --data-urlencode "client_secret=<SECRET>" \
  --data-urlencode "scope=https://orgfa1d2553.crm.dynamics.com/.default"

# leads padho (upar mila access_token lagao)
curl "https://orgfa1d2553.crm.dynamics.com/api/data/v9.2/leads?\$select=firstname,lastname&\$top=5" \
  -H "Authorization: Bearer <ACCESS_TOKEN>"
```
Leads ki JSON aayi = setup done. (Live test mein 17-18 leads aaye.)

**Error meanings:** 401 = app user nahi / token galat · 403 = role/Lead-read nahi · invalid_client = Client ID/secret galat.

---

## 4. Config values (identifiers — secret .env mein)

```
Org URL     : https://orgfa1d2553.crm.dynamics.com
Web API      : https://orgfa1d2553.crm.dynamics.com/api/data/v9.2/
Tenant ID    : 6dbf2263-5800-4aa2-b166-9e5d25812991   (revworx.io)
Client ID    : 80adfbae-89a0-43b8-a5b5-e2987fabce6a
Client SECRET: <.env mein — yahan nahi>
Entity set   : leads   | fields: firstname,lastname,emailaddress1,createdon,statuscode,_ownerid_value
```

`.env` mein 4 vars (ye set karne padte hain live server pe bhi + restart):
```
DYNAMICS_URL=https://orgfa1d2553.crm.dynamics.com
DYNAMICS_TENANT_ID=6dbf2263-5800-4aa2-b166-9e5d25812991
DYNAMICS_CLIENT_ID=80adfbae-89a0-43b8-a5b5-e2987fabce6a
DYNAMICS_CLIENT_SECRET=<secret>
```

---

## 5. Code — kya-kya banaya/badla

| File | Kya |
|---|---|
| **`src/dynamics.js`** (naya) | App-only token (1hr in-memory cache) + `getLeads()`. Token endpoint `login.microsoftonline.com/<tenant>/oauth2/v2.0/token`, scope `<url>/.default`. `getLeads()` `@odata.nextLink` follow karke **saare** leads laata hai (5000 safe cap). `Prefer: odata.maxpagesize=500,odata.include-annotations="*"` header — annotations se status/owner ke **FormattedValue** labels milte hain. `isConfigured()` false ho toh `[]` (graceful). |
| **`src/config.js`** | Optional `dynamics` block (url/tenantId/clientId/clientSecret + `configured` bool). `required()` NAHI — vars missing ho toh app crash nahi hota. |
| **`src/routes/api.routes.js`** | `GET /api/leads` (auth-guarded) → `{configured, leads}`. |
| **`public/index.html`** | Topbar **👥 Leads** button + `#leadsModal` overlay (search input + body + pager footer). `.intel-modal` classes reuse. |
| **`public/styles.css`** | `.leads-toolbar` / `.leads-search` / `.leads-pager` / disabled-btn. |
| **`public/app.js`** | `LEADS_COLUMNS` config (Name·Email·Status·Owner·Created), `renderLeadsTable`, client-side pagination (`LEADS_PAGE_SIZE=20`, `renderLeadsPage`), `applyLeadsSearch` (sab fields pe match), open/close + Escape/backdrop. Values `textContent` se (HTML-injection safe). |
| **`.env.example`** | `DYNAMICS_*` block + poore setup steps documented. |

### Fields (Dynamics → display)
- **Name** = `firstname` + `lastname` (ek column mein merge)
- **Email** = `emailaddress1`
- **Status** = `statuscode` ka FormattedValue (e.g. "New")
- **Owner** = `_ownerid_value` ka FormattedValue (owner ka naam)
- **Created** = `createdon` (raw ISO backend se, UI local time format)

### Pagination + Search
- 20 leads/page. `>20` ho toh pager (Prev / "Page X of Y · N leads" / Next), warna hidden.
- Search: naam/email/status/owner — instant filter, page 1 reset, "(filtered)" summary.
- Mobile: `.intel-table` reuse → `data-label` se stacked cards apne aap.

---

## 6. Ek gotcha jo samjha (17 vs 1 lead)

User ke Dynamics URL view pe **1** lead dikha, API pe **17-18**. Reason:
- URL view = **"My Open Leads"** (sirf current user ke apne leads) → 1 (Admin ka)
- 16 leads owner **"Alok Gangaramany"** (sample/demo data), 1 owner **Admin #** (user)
- API (app-only, no filter) = **saare** leads → 17-18

**Decision (user-confirmed):** app **saare leads** dikhata hai (koi owner/state filter nahi).
Dynamics UI mein sab dekhne ke liye view dropdown "My Open Leads" → "All Leads" karo.

**Tech note:** `$expand=ownerid(...)` is app user pe 0 rows deta hai (systemuser read
permission issue), isliye owner name `_ownerid_value` + FormattedValue annotation se
liya — ye reliable hai.

---

## 7. Verification (sab pass ✅)
- `node --check` sab files
- `getLeads()` direct → 17→18 leads, saare fields populated
- Server clean boot; `/api/leads` bina login → 401 (auth guard sahi)
- curl test se bhi leads aaye

---

## 8. Git
- Commit **`3f9037b`** (7 files, 397 insertions) — branch `feat-add-dynamic365-lead-read`, **pushed** to origin.
- `.env` gitignored → secret commit mein NAHI.
- PR abhi open nahi kiya.

---

## 9. Future / TODO
- [ ] **Secret rotate** before prod (chat/.env mein aa chuka).
- [ ] Live/prod server pe 4 `DYNAMICS_*` vars set karo + restart (`.env` local-only).
- [ ] Chaho toh: leads pe click → detail view; email ko mailto link; owner/status filter dropdowns; CSV export (jaise Email Sheet mein hai).
- [ ] Pagination live dekhne ke liye 21+ leads chahiye (abhi 18).
- [ ] Agar kabhi "sirf mere leads" chahiye → `_ownerid_value` / `statecode` filter (app-only mein "me" nahi hota, owner ki systemuserid explicit deni padegi).
- [ ] PR open + merge to main jab ready.
