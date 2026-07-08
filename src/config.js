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
    // Mail.Send — emailing the organizer their physician briefing.
    // Mail.Read — ingesting email replies for the intelligence platform.
    scopes: ['User.Read', 'Calendars.ReadWrite', 'Mail.Send', 'Mail.Read'],
  },

  session: {
    secret: required('SESSION_SECRET'),
  },

  // Where physician briefings are delivered. The sign-in identity can be a
  // federated address (e.g. a Gmail account) that Microsoft routes EXTERNALLY,
  // so a sendMail-to-self only lands in Sent, never the Outlook Inbox. Set
  // BRIEFING_TO_EMAIL to the real Microsoft mailbox address (e.g.
  // you@outlook.com) so the briefing is delivered internally to the Inbox.
  // When unset, briefings fall back to the signed-in user's own address.
  briefingToEmail: process.env.BRIEFING_TO_EMAIL?.trim() || null,

  graph: {
    // Host only — the Graph client appends the API version (v1.0) itself.
    // Including /v1.0 here produces a doubled .../v1.0/v1.0/... path (400).
    baseUrl: 'https://graph.microsoft.com',
  },

  // Dynamics 365 (Dataverse) — app-only read of Lead records. Fully optional and
  // independent of the Outlook/Graph auth above: it uses its OWN app registration
  // in the tenant that owns the Dynamics org (client-credentials flow). When any
  // of these are unset, `configured` is false and the Leads feature no-ops.
  dynamics: (() => {
    const url = process.env.DYNAMICS_URL?.trim().replace(/\/$/, '') || null;
    const tenantId = process.env.DYNAMICS_TENANT_ID?.trim() || null;
    const clientId = process.env.DYNAMICS_CLIENT_ID?.trim() || null;
    const clientSecret = process.env.DYNAMICS_CLIENT_SECRET?.trim() || null;
    return {
      url,
      tenantId,
      clientId,
      clientSecret,
      configured: Boolean(url && tenantId && clientId && clientSecret),
      // Part 2 (embed the lead brief INSIDE Dynamics via an iframe/side pane):
      // a shared token gates the public /embed/lead-brief endpoint (no Outlook
      // session there), and frame-ancestors lets Dynamics iframe our page.
      embedToken: process.env.DYNAMICS_EMBED_TOKEN?.trim() || null,
      embedFrameAncestors:
        process.env.DYNAMICS_EMBED_FRAME_ANCESTORS?.trim() ||
        'https://*.dynamics.com https://*.crm.dynamics.com',
    };
  })(),
};

module.exports = config;
