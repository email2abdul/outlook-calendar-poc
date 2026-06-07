# Deploying the live demo

The app is a stateful Node/Express server (it holds the OAuth session/token
cache). Two supported paths:

- **Long-lived process host** (Render, Railway, Fly.io, Azure App Service) —
  runs the repo unchanged with SQLite-backed sessions/notes. See
  [Deploy to Render](#deploy-to-render).
- **Vercel (serverless)** — needs an external Redis for sessions/notes
  (instances are ephemeral, so local SQLite files don't persist). The repo
  ships ready for this: `api/index.js` + `vercel.json`, and setting
  `REDIS_URL` switches the session and notes stores from SQLite to Redis.
  See [Deploy to Vercel](#deploy-to-vercel).

> ⚠️ OAuth requires secrets only you have. A deploy is **not** functional until
> you supply your Azure `MS_CLIENT_ID` / `MS_CLIENT_SECRET` and register the
> deployed redirect URI in Azure. There is no way around this — it's what makes
> "Login with Outlook" actually log in.

## Deploy to Vercel

Deploys straight from GitHub; every push to `main` redeploys.

1. [vercel.com/new](https://vercel.com/new) → **Import** the
   `email2abdul/outlook-calendar-poc` repo (sign in with GitHub). Framework
   preset: **Other** — no build command needed; `vercel.json` routes
   everything through the `api/index.js` serverless function.
2. Storage → add **Upstash for Redis** from the Vercel Marketplace (free
   tier) and connect it to the project. This injects `REDIS_URL`/`KV_URL`,
   which flips the app's session + notes stores from SQLite to Redis.
3. Project → Settings → Environment Variables:
   - `MS_CLIENT_ID` — your Azure Application (client) ID
   - `MS_CLIENT_SECRET` — your Azure client secret **value**
   - `SESSION_SECRET` — any long random string (`openssl rand -hex 32`)
   - `MS_TENANT_ID` — `common` (or your tenant ID)
   - `SUPABASE_URL` + `SUPABASE_ANON_KEY` — from the Supabase dashboard
     (Project Settings → API) — physician directory + procedure analytics
     read from the `bis_*` tables
   - `REDIRECT_URI` — set after the first deploy (step 4)
4. Deploy. Vercel assigns a URL, e.g. `https://outlook-calendar-poc.vercel.app`.
   Set `REDIRECT_URI` to `https://<your-vercel-url>/auth/callback` and redeploy.
5. In the [Azure Portal](https://portal.azure.com) → your App registration →
   **Authentication → Add a redirect URI (Web)**, add the exact same value.

Caveats on Vercel:
- **Analytics needs the Supabase vars** — the local `data/analytics.db`
  (366 MB) can't ship in a serverless function, so analytics reads the
  Supabase `bis_*` tables instead. Without them the app degrades gracefully
  and hides the analytics section; everything else works.
- Without `REDIS_URL`, OAuth logins fail intermittently (session state is
  lost between `/auth/login` and `/auth/callback`) — step 2 is not optional.

## Deploy to Render (recommended)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/email2abdul/outlook-calendar-poc)

1. Click the button (or Render dashboard → **New → Blueprint** → pick this repo).
   Render reads `render.yaml` and provisions a free web service.
2. When prompted, enter the env vars marked `sync: false`:
   - `MS_CLIENT_ID` — your Azure Application (client) ID
   - `MS_CLIENT_SECRET` — your Azure client secret **value**
   - `REDIRECT_URI` — leave blank for now (set in step 4)
   - `SESSION_SECRET` is auto-generated; `NODE_ENV=production` and
     `MS_TENANT_ID=common` are preset.
3. Deploy. Render assigns a URL, e.g. `https://outlook-calendar-poc.onrender.com`.
4. Set `REDIRECT_URI` to `https://<your-render-url>/auth/callback` and redeploy.
5. In the [Azure Portal](https://portal.azure.com) → your App registration →
   **Authentication → Add a redirect URI (Web)**, add the exact same value:
   `https://<your-render-url>/auth/callback`.

Open the URL and click **Login with Outlook**. Done.

## Notes / caveats

- **HTTPS is required** for OAuth and for the Secure session cookie. Render
  provides HTTPS automatically; `NODE_ENV=production` enables Secure cookies and
  `trust proxy` (already handled in `server.js`).
- **Free tier sleeps** after inactivity and uses an in-memory session store, so
  the login session resets on cold start — fine for a demo (just sign in again).
  For a durable session, add a Redis store (`connect-redis`) and a Render Redis
  instance; the `cachePlugin` in `src/auth.js` needs no changes.
- **Other hosts:** the app only needs `npm install` + `npm start` and the same
  env vars. On Railway/Fly/Azure, set them in that platform's dashboard and add
  the corresponding `/auth/callback` redirect URI in Azure.
