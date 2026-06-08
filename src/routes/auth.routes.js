'use strict';

const express = require('express');
const auth = require('../auth');
const config = require('../config');

const router = express.Router();

/**
 * GET /auth/login
 * Kicks off the OAuth flow by redirecting to Microsoft's sign-in page.
 */
router.get('/login', async (req, res, next) => {
  try {
    const url = await auth.getAuthCodeUrl(req);
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /auth/callback
 * Microsoft redirects back here with ?code & ?state. We exchange the code for
 * tokens and start an authenticated session.
 */
router.get('/callback', async (req, res, next) => {
  try {
    if (req.query.error) {
      // User declined consent, etc.
      return res.redirect(
        `/?error=${encodeURIComponent(req.query.error_description || req.query.error)}`
      );
    }
    await auth.handleRedirect(req);
    res.redirect(config.auth.postLoginRedirect);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/logout
 * Destroys the local session. (Add Microsoft global sign-out separately if
 * full SSO logout is required.)
 */
router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

/**
 * GET/POST /auth/webhooks/outlook — Microsoft Graph change-notification
 * endpoint for inbox subscriptions (used once deployed behind a public URL).
 *
 * Graph first sends a GET-like validation with ?validationToken, which we
 * must echo back as text/plain within 10s. Notifications then arrive as POST;
 * we validate clientState and kick an ingestion pass. On localhost (no public
 * URL) ingestion runs on a poll instead — this endpoint is for production.
 */
function handleWebhook(req, res) {
  const validationToken = req.query.validationToken;
  if (validationToken) {
    return res.set('Content-Type', 'text/plain').status(200).send(validationToken);
  }

  const expected = process.env.GRAPH_WEBHOOK_SECRET;
  const ok = (req.body?.value || []).every(
    (n) => !expected || n.clientState === expected
  );
  if (!ok) return res.status(202).end(); // ignore unverified, but ack

  // Ack immediately (Graph requires <10s), then ingest out of band.
  res.status(202).end();
  require('../email-ingest').tick().catch((err) => console.warn('[webhook] tick:', err.message));
}

router.get('/webhooks/outlook', handleWebhook);
router.post('/webhooks/outlook', handleWebhook);

module.exports = router;
