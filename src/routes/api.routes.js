'use strict';

const express = require('express');
const auth = require('../auth');
const graph = require('../graph');

const router = express.Router();

/** Guard: require an authenticated session, else 401 (JSON). */
function requireAuth(req, res, next) {
  if (!auth.isAuthenticated(req)) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  next();
}

/**
 * GET /api/me
 * Returns the current auth status and basic profile for the frontend.
 */
router.get('/me', async (req, res, next) => {
  try {
    if (!auth.isAuthenticated(req)) {
      return res.json({ authenticated: false });
    }
    const token = await auth.getAccessToken(req);
    if (!token) return res.json({ authenticated: false });

    const profile = await graph.getMe(token);
    res.json({ authenticated: true, user: profile });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/calendar/today?timeZone=America/Los_Angeles
 * Returns today's events for the signed-in user, sorted by start time.
 */
router.get('/calendar/today', requireAuth, async (req, res, next) => {
  try {
    const token = await auth.getAccessToken(req);
    if (!token) return res.status(401).json({ error: 'unauthenticated' });

    const timeZone = typeof req.query.timeZone === 'string' ? req.query.timeZone : undefined;
    const data = await graph.getTodaysEvents(token, timeZone);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
