'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');

const config = require('./src/config');
const authRoutes = require('./src/routes/auth.routes');
const apiRoutes = require('./src/routes/api.routes');

const app = express();

// Behind a reverse proxy / HTTPS terminator in production, trust it so that
// Secure cookies and protocol detection work correctly.
if (config.isProduction) app.set('trust proxy', 1);

app.use(express.json());

// ── Session: the only thing the browser holds is a signed, httpOnly cookie.
//    Access/refresh tokens are kept server-side in the MSAL token cache, which
//    lives inside the session — persisted to SQLite so logins survive server
//    restarts. The MSAL refresh token then keeps the access token fresh
//    silently; users only re-authenticate when the cookie/session expires or
//    the refresh token is revoked.
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

const sessionDb = new Database(path.join(__dirname, 'data', 'sessions.db'));
app.use(
  session({
    name: 'connect.sid',
    store: new SqliteStore({
      client: sessionDb,
      expired: { clear: true, intervalMs: 1000 * 60 * 15 }, // purge expired rows
    }),
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

app.listen(config.port, () => {
  console.log(`\n  Outlook Calendar POC running at http://localhost:${config.port}`);
  console.log(`  Environment: ${config.nodeEnv}`);
  console.log(`  Sign in:     http://localhost:${config.port}/auth/login\n`);
});
