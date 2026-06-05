'use strict';

require('dotenv').config();

/**
 * Centralised, validated configuration.
 *
 * Everything that touches the environment lives here so the rest of the
 * codebase can depend on a single typed object instead of reaching into
 * `process.env`. This keeps the auth/graph modules reusable and easy to test.
 */

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable "${name}". ` +
        'Copy .env.example to .env and fill it in (see README.md).'
    );
  }
  return value.trim();
}

const tenant = process.env.MS_TENANT_ID?.trim() || 'common';

const config = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: (process.env.NODE_ENV || 'development') === 'production',

  auth: {
    clientId: required('MS_CLIENT_ID'),
    clientSecret: required('MS_CLIENT_SECRET'),
    tenant,
    authority: `https://login.microsoftonline.com/${tenant}`,
    redirectUri: process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback',
    postLoginRedirect: process.env.POST_LOGIN_REDIRECT || '/',

    // Principle of least privilege: only the delegated permissions we use.
    // `openid`, `profile` and `offline_access` are added automatically by MSAL.
    // ReadWrite (superset of Read) — we now create meetings, not just list them.
    scopes: ['User.Read', 'Calendars.ReadWrite'],
  },

  session: {
    secret: required('SESSION_SECRET'),
  },

  graph: {
    // Host only — the Graph client appends the API version (v1.0) itself.
    // Including /v1.0 here produces a doubled .../v1.0/v1.0/... path (400).
    baseUrl: 'https://graph.microsoft.com',
  },
};

module.exports = config;
