# Deploying the live demo

The app is a stateful Node/Express server (it holds the OAuth session/token
cache), so it needs a host that runs a long-lived process — **Render**,
**Railway**, **Fly.io**, or **Azure App Service** all work. Below is the
fastest path, using the included `render.yaml` blueprint.

> ⚠️ OAuth requires secrets only you have. A deploy is **not** functional until
> you supply your Azure `MS_CLIENT_ID` / `MS_CLIENT_SECRET` and register the
> deployed redirect URI in Azure. There is no way around this — it's what makes
> "Login with Outlook" actually log in.

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
