'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');

const config = require('./src/config');
const authRoutes = require('./src/routes/auth.routes');
const apiRoutes = require('./src/routes/api.routes');

const app = express();

// Behind a reverse proxy / HTTPS terminator in production, trust it so that
// Secure cookies and protocol detection work correctly.
if (config.isProduction) app.set('trust proxy', 1);

app.use(express.json());

// ── Session: the only thing the browser holds is a signed, httpOnly cookie.
//    Access/refresh tokens are kept server-side in the MSAL token cache.
//    NOTE: the default MemoryStore is fine for this single-process demo only.
//    For production, plug in a shared store (e.g. connect-redis).
app.use(
  session({
    name: 'connect.sid',
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax', // allows the top-level OAuth redirect back to us
      secure: config.isProduction, // require HTTPS in production
      maxAge: 1000 * 60 * 60, // 1 hour
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
