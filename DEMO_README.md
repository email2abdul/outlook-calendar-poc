# Pre-Meeting Intelligence — Demo Guide (Hinglish)

**Pehli baar project dekhne wale ke liye 2-minute guide.**
Ye kya hai, kya karta hai, aur live demo kaise chalayein — step by step.

---

## 1. Ye hai kya?

Ye ek **pre-meeting intelligence layer hai medical-device sales reps ke liye**, jo
unke roz ke tools ke andar hi kaam karta hai — **Outlook Calendar + Email**. Jab
kisi rep ki kisi physician (doctor) ke saath meeting hoti hai, system **automatic
ek briefing email** bhej deta hai jisme meeting se pehle jo bhi jaankari chahiye
wo sab hoti hai — bina koi dashboard khole.

> **Customer (Lumendi) ka guiding principle:**
> *"Ek aur dashboard mat banao. Ek intelligence layer banao jo wahin dikhe jahan
> rep pehle se kaam karta hai: Outlook → Calendar → Email → Meeting."*

Briefing ek bade medical dataset se banti hai (physician directory + ~2.25M
procedure records) plus product knowledge, aur har physician meeting se
**90 minute pehle** email aa jaati hai (aur jab app se meeting schedule karte ho
to turant).

---

## 2. Story (ye bana kyun?)

Ye ek asli customer requirement se aaya — **Eric Coolidge, VP Sales & Marketing
@ Lumendi LLC** (DiLumen endoscopy products banate hain). Unki demand: reps ko
har meeting se pehle ek chhoti briefing mile taaki wo **6 sawaalon** ka jawab de
sakein bina kisi aur system ko khole:

1. **Kaun** se doctor se mil raha hoon? (Who)
2. Ye account **important kyun** hai? (Why)
3. **Kaunse procedures** matter karte hain? (What procedures)
4. Is facility me **aur kis-kis** se baat karun? (Who else)
5. **Contact kaise** karun? (How)
6. **Kya discuss** karun? (What to discuss)

Ye app ki briefing **chhe ke chhe** sawaalon ka jawab deti hai.

---

## 3. Briefing me kya-kya hota hai

Har briefing email in sections se banti hai (har ek live data se feed hoti hai):

| Section | Rep ko kya dikhता hai | Sawaal |
|---|---|---|
| **Physician Details** | Naam, specialty, facility + address, email/phone/LinkedIn | Q1 Who |
| **Contact Intelligence** | Verified mobile/LinkedIn + **confidence score**, last-verified & last-refresh dates | Q5 Contact kaise |
| **Procedure Intelligence** | Clinical family ke hisaab se volumes — **Colonoscopy / ESD / EMR / EUS** + CPT codes | Q3 Procedures |
| **Commercial Signals** | Growth trend, emerging advanced techniques, therapeutic adoption, **Lumendi account status** | Q2 Important kyun |
| **Procedure Analytics** | Year trend, payer mix, top CPT codes (Medicare & commercial rates), facilities | Q3 (detail) |
| **Account Opportunity** | Facility ke baaki physicians, kaun relevant procedures karta hai, **"N physicians abhi Lumendi product use karte hain"** | Q4 Aur kaun |
| **What to Discuss** | Is physician ke procedures se matched product talking points (AI ne Lumendi brochures se nikaale) | Q6 Kya discuss |
| **Meeting Notes** | Is physician ke purane meeting notes ki history | context |

---

## 4. Setup (ek baar)

**Chahiye:** Node.js 18+, ek Azure app registration (Microsoft OAuth), aur
Supabase credentials (is POC ke liye pehle se ready hain).

```bash
# 1. Dependencies install karo
npm install

# 2. .env template se banao aur bharo
cp .env.example .env
#   - MS_CLIENT_ID / MS_CLIENT_SECRET ........ Azure app registration
#   - SESSION_SECRET ......................... koi bhi lamba random string
#   - SUPABASE_ENV=development ............... kaunsa database use karna hai
#   - SUPABASE_DEV_URL / SUPABASE_DEV_ANON_KEY
#   - (ANTHROPIC_API_KEY — sirf tab jab product brochures (re)ingest karni ho)

# 3. Server start karo
npm start            # ya: npm run dev   (auto-reload ke saath)
```

App chalega **http://localhost:3000** pe (ya jo `PORT` aapke `.env` me hai).

> **Database:** `SUPABASE_ENV` ek hi variable se poori app ko **development** aur
> **production** Supabase ke beech switch karta hai. Demo ke liye
> `development` pe rakho.

---

## 5. Demo chalao (step by step)

### Step 1 — Outlook se sign in
App kholo → **Sign in** → Microsoft / Outlook account se login. Aapko apne
**calendar events** dikhne lagenge.

![Login](docs/screenshot-login.png)
![Events](docs/screenshot-events.png)

### Step 2 — Physician dhoondo aur meeting schedule karo
- **Physician search** se doctor dhoondo (naam ya facility se).
- App se uske saath ek **meeting schedule** karo.
- Meeting book hote hi app aapko us physician ki **poori briefing email** bhej
  deta hai (signed-in account ke inbox me dekho).

### Step 3 — Ya reminder engine ko karne do
App background me aapka asli calendar bhi scan karta hai. Jo bhi upcoming meeting
wo physician se match kar sakta hai (attendee email se, ya meeting title padh
ke), us meeting se **90 minute pehle** briefing email bhej deta hai — har meeting
ke liye exactly ek baar.

> Live demo tip: ek calendar event banao title *"Meeting with Dr. Michael Smith"*
> jaisa, start ~80 minute baad ka, phir scan trigger karo — briefing automatic
> aa jaayegi.

### Step 4 — Briefing padho
Email kholo aur §3 wale sections dekho. Ye highlight karo:
- **Procedure Intelligence** — rep turant dekh leta hai ki doctor ESD/EMR/EUS
  karta hai ya nahi.
- **Account Opportunity** — *"Is facility me 1 physician abhi Lumendi product use
  karta hai; 2 aur relevant procedures karte hain."*
- **What to Discuss** — is physician ke kaam ke hisaab se tailored product
  talking points.

---

## 6. Demo data note

Demo ke liye do overlays sample data ke saath aate hain taaki briefing poori
render ho:
- **Contact Intelligence** aur **Lumendi account status** chhote demo seeds use
  karte hain (`data/contacts-seed.csv`, `data/accounts-seed.csv`) jo dev DB me
  load kiye gaye hain.
- **What to Discuss** ek clearly-labeled **placeholder** use karta hai jab tak
  asli Lumendi brochures ingest nahi hoti.

Ye sab simple import scripts se real data se replace ho jaate hain
(dekho **KT_README.md**). Baaki sab (physician directory, procedure analytics,
growth, families, facility peers) **real data** hai BIS dataset se.

---

## 7. Kya ban chuka hai vs kya bacha hai

**Ban chuka & working (customer ke chhe ke chhe requirements):** Physician
overview, Procedure Intelligence, Commercial Signals, Account Opportunity,
Contact Intelligence, aur AI "What to Discuss" layer — sab Outlook email briefing
ke through, koi dashboard nahi chahiye.

**Bacha hua (sirf data, code nahi):** asli Lumendi brochure PDFs daalo taaki live
product talking points banein; asli contact & account CSVs import karo; aur
go-live pe production database pe do chhoti setup SQLs run karo. Details
**KT_README.md** me.

---

*Architecture, code walkthrough, aur developer handoff ke liye **KT_README.md** dekho.*
