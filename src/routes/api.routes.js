'use strict';

const express = require('express');
const auth = require('../auth');
const graph = require('../graph');
const physicians = require('../physicians');

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

/**
 * GET /api/physicians/search?q=smith
 * Free-text search over the physician directory (name / NPI / email /
 * specialty). Physicians with an email sort first.
 */
router.get('/physicians/search', requireAuth, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  if (q.trim().length < 2) {
    return res.json({ query: q, results: [] });
  }
  res.json({ query: q, results: physicians.search(q) });
});

/**
 * GET /api/physicians/:npi
 * Full profile (incl. primary facility) for one physician.
 */
router.get('/physicians/:npi', requireAuth, (req, res) => {
  const physician = physicians.getByNpi(req.params.npi);
  if (!physician) return res.status(404).json({ error: 'physician_not_found' });
  res.json(physician);
});

/**
 * POST /api/calendar/schedule
 * Body: { npi, subject, start, end, timeZone, notes? }
 * Creates an Outlook event with the physician as required attendee — Graph
 * emails the invite (with the physician's full details in the body) for us.
 */
router.post('/calendar/schedule', requireAuth, async (req, res, next) => {
  try {
    const { npi, subject, start, end, timeZone, notes } = req.body || {};

    for (const [name, value] of Object.entries({ npi, subject, start, end, timeZone })) {
      if (typeof value !== 'string' || value.trim() === '') {
        return res.status(400).json({ error: 'bad_request', message: `Missing field: ${name}` });
      }
    }

    const physician = physicians.getByNpi(npi);
    if (!physician) return res.status(404).json({ error: 'physician_not_found' });
    if (!physician.email) {
      return res.status(422).json({
        error: 'no_email',
        message: `${physician.name || npi} has no email on file — cannot send an invite.`,
      });
    }
    if (new Date(end) <= new Date(start)) {
      return res.status(400).json({ error: 'bad_request', message: 'End must be after start.' });
    }

    const token = await auth.getAccessToken(req);
    if (!token) return res.status(401).json({ error: 'unauthenticated' });

    const event = await graph.createMeetingWithPhysician(token, {
      subject: subject.trim(),
      start,
      end,
      timeZone,
      physician,
      notes: typeof notes === 'string' ? notes.trim() : undefined,
    });

    res.status(201).json({ created: true, event, invitee: { name: physician.name, email: physician.email } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
