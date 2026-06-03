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

module.exports = router;
