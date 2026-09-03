'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');

const config = require('./src/config');
const redisClient = require('./src/redis');
const physicians = require('./src/physicians');
const authRoutes = require('./src/routes/auth.routes');
const apiRoutes = require('./src/routes/api.routes');
const embedRoutes = require('./src/routes/embed.routes');
const addinRoutes = require('./src/routes/addin.routes');
const relayRoutes = require('./src/routes/relay.routes');

const app = express();

// Behind a reverse proxy / HTTPS terminator in production, trust it so that
// Secure cookies and protocol detection work correctly.
if (config.isProduction) app.set('trust proxy', 1);

app.use(express.json());

// Hold requests until the physician directory finishes loading (it may be
// fetched from Supabase at startup — a moment on a cold start).
app.use((req, res, next) => {
  physicians.ready.then(() => next(), next);
});

// ── Session: the only thing the browser holds is a signed, httpOnly cookie.
//    Access/refresh tokens are kept server-side in the MSAL token cache, which
//    lives inside the session — persisted so logins survive server restarts.
//    The MSAL refresh token then keeps the access token fresh silently; users
//    only re-authenticate when the cookie/session expires or the refresh
//    token is revoked.
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// SQLite by default; Redis when REDIS_URL/KV_URL is set (serverless hosts
// like Vercel, where a local file doesn't persist between invocations).
function createSessionStore() {
  if (redisClient) {
    const { RedisStore } = require('connect-redis');
    return new RedisStore({ client: redisClient, prefix: 'sess:' });
  }
  const SqliteStore = require('better-sqlite3-session-store')(session);
  const Database = require('better-sqlite3');
  const sessionDb = new Database(path.join(__dirname, 'data', 'sessions.db'));
  return new SqliteStore({
    client: sessionDb,
    expired: { clear: true, intervalMs: 1000 * 60 * 15 }, // purge expired rows
  });
}

app.use(
  session({
    name: 'connect.sid',
    store: createSessionStore(),
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    rolling: true, // active users keep extending their session
    cookie: {
      httpOnly: true,
      sameSite: 'lax', // allows the top-level OAuth redirect back to us
      secure: config.isProduction, // require HTTPS in production
      maxAge: SESSION_TTL_MS,
    },
  })
);

// ── Routes
app.use('/auth', authRoutes);
app.use('/api', apiRoutes);
// Public (token-gated, no session) — embedded inside Dynamics as an iframe.
app.use('/embed', embedRoutes);
// Outlook Add-in task pane (framed by Outlook; sets its own CSP). Static assets
// under public/addin/ (taskpane.js, icons) are served by express.static below.
app.use('/addin', addinRoutes);
// Public registry relay (token-gated, no session) — a developer on a network
// that blocks CMS/NPPES asks THIS host to fetch instead. Off unless RELAY_TOKEN
// is set; see src/enrichment/relay.js.
app.use('/relay', relayRoutes);

// ── Static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ── Centralised error handler — never leak stack traces to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  const status = err.statusCode || 500;
  res.status(status).json({
    error: 'internal_error',
    message: config.isProduction ? 'Something went wrong.' : err.message,
  });
});

// Listen when run directly (`npm start`); on Vercel the app is imported by
// api/index.js and the platform owns the listening socket.
if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`\n  Outlook Calendar POC running at http://localhost:${config.port}`);
    console.log(`  Environment: ${config.nodeEnv}`);
    console.log(`  Sign in:     http://localhost:${config.port}/auth/login\n`);

    const startEngines = () => {
      // Pre-meeting reminder engine — needs a long-lived process, so it runs
      // here (not on serverless; there it would be a cron-triggered endpoint).
      require('./src/reminders').start();

      // Email-intelligence ingestion — syncs calendar→CRM activities and pulls
      // Outlook reply emails (webhook on deploy, poll on localhost).
      require('./src/email-ingest').start();
    };

    // On a network that blocks the public registries, they are reached through a
    // local SOCKS tunnel (OUTSIDE_HTTP_PROXY). Make sure it is actually up
    // BEFORE the engines start looking physicians up — a tunnel that died while
    // the laptop slept used to turn every CMS lookup into a failure until
    // somebody re-ran the ssh command by hand. On the deployed server, where no
    // local proxy is configured, this resolves instantly and does nothing.
    //
    // A machine given a relay (OUTSIDE_HTTP_RELAY) needs no tunnel at all: its
    // requests leave from the relay host, so starting an ssh tunnel here would
    // be work nothing uses.
    const enrichmentRelay = require('./src/enrichment/relay');
    if (enrichmentRelay.enabled()) {
      console.log(`  [enrichment] ${enrichmentRelay.describe()} — no local tunnel needed\n`);
      startEngines();
    } else {
      require('./src/enrichment/tunnel')
        .ensure()
        .then((t) => {
          if (t.line) console.log(`  ${t.line}\n`);
        })
        .catch(() => {}) // ensure() does not throw; a boot must not depend on that
        .finally(startEngines);
    }
  });
}

module.exports = app;
