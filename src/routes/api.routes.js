'use strict';

const express = require('express');
const auth = require('../auth');
const graph = require('../graph');
const physicians = require('../physicians');
const callNotes = require('../notes');
const analytics = require('../analytics');

const router = express.Router();

/** Guard: require an authenticated session, else 401 (JSON). */
function requireAuth(req, res, next) {
  if (!auth.isAuthenticated(req)) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  next();
}

/** The signed-in organizer's email (notes are scoped per organizer). */
function organizerEmail(req) {
  return req.session.account?.username?.toLowerCase() || null;
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
 * GET /api/calendar/day?date=2026-06-05&timeZone=America/Los_Angeles
 * Returns the signed-in user's events for one day (default: today), sorted
 * by start time. Kept available at /calendar/today for backward compat.
 */
async function dayHandler(req, res, next) {
  try {
    const token = await auth.getAccessToken(req);
    if (!token) return res.status(401).json({ error: 'unauthenticated' });

    const timeZone = typeof req.query.timeZone === 'string' ? req.query.timeZone : undefined;

    let date;
    if (typeof req.query.date === 'string' && req.query.date !== '') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) {
        return res.status(400).json({ error: 'bad_request', message: 'date must be YYYY-MM-DD' });
      }
      date = req.query.date;
    }

    const data = await graph.getEventsForDay(token, timeZone, date);

    // Enrich attendees: match each email against the physician directory so
    // the UI can show the physician's full profile inline — plus the
    // organizer's latest call note for that physician (the "last call" hint).
    const organizer = organizerEmail(req);
    data.events = await Promise.all(
      data.events.map(async (ev) => ({
        ...ev,
        attendees: await Promise.all(
          ev.attendees.map(async (a) => {
            const physician = physicians.getByEmail(a.email);
            return {
              ...a,
              physician,
              lastNote: physician ? await callNotes.getLatestNote(physician.npi, organizer) : null,
            };
          })
        ),
      }))
    );

    res.json(data);
  } catch (err) {
    next(err);
  }
}

router.get('/calendar/day', requireAuth, dayHandler);
router.get('/calendar/today', requireAuth, dayHandler);

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
 * GET /api/physicians/:npi/analytics
 * Procedure-volume intelligence for one physician (2018–2024): totals,
 * yearly trend, category/payer mix, top CPT codes with reimbursement rates,
 * and where they operate. 204-style null when we have no data for them.
 */
router.get('/physicians/:npi/analytics', requireAuth, (req, res) => {
  const physician = physicians.getByNpi(req.params.npi);
  if (!physician) return res.status(404).json({ error: 'physician_not_found' });

  res.json({ npi: physician.npi, analytics: labelledAnalytics(physician.npi) });
});

/** Analytics with facility volumes labelled from the directory, or null. */
function labelledAnalytics(npi) {
  const data = analytics.getPhysicianAnalytics(npi);
  if (!data) return null;

  data.facilities = data.facilities.map((f) => {
    const fac = physicians.getFacilityById(f.facilityId);
    return {
      ...f,
      name: fac?.name || f.facilityId,
      city: fac?.city || null,
      state: fac?.state || null,
    };
  });

  return data;
}

/**
 * GET /api/physicians/:npi/notes
 * The signed-in organizer's call-note history with this physician,
 * newest first.
 */
router.get('/physicians/:npi/notes', requireAuth, async (req, res, next) => {
  try {
    const physician = physicians.getByNpi(req.params.npi);
    if (!physician) return res.status(404).json({ error: 'physician_not_found' });
    res.json({ npi: physician.npi, notes: await callNotes.getNotes(physician.npi, organizerEmail(req)) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/physicians/:npi/notes
 * Body: { notes, eventId?, meetingDate? (YYYY-MM-DD) }
 * Save a call note for this physician.
 */
router.post('/physicians/:npi/notes', requireAuth, async (req, res, next) => {
  try {
    const physician = physicians.getByNpi(req.params.npi);
    if (!physician) return res.status(404).json({ error: 'physician_not_found' });

    const { notes, eventId, meetingDate } = req.body || {};
    if (typeof notes !== 'string' || notes.trim() === '') {
      return res.status(400).json({ error: 'bad_request', message: 'notes is required' });
    }
    if (meetingDate && !/^\d{4}-\d{2}-\d{2}$/.test(meetingDate)) {
      return res.status(400).json({ error: 'bad_request', message: 'meetingDate must be YYYY-MM-DD' });
    }

    const note = await callNotes.addNote({
      npi: physician.npi,
      organizerEmail: organizerEmail(req),
      eventId: typeof eventId === 'string' ? eventId : null,
      meetingDate: meetingDate || null,
      notes: notes.trim(),
    });

    res.status(201).json({ note });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/physicians/:npi/send-briefing
 * Body: { eventTitle?, eventStart? }
 * Emails the signed-in organizer (salesperson) a briefing: the physician's
 * details plus the organizer's full call-note history with them.
 */
router.post('/physicians/:npi/send-briefing', requireAuth, async (req, res, next) => {
  try {
    const physician = physicians.getByNpi(req.params.npi);
    if (!physician) return res.status(404).json({ error: 'physician_not_found' });

    const to = organizerEmail(req);
    if (!to) return res.status(400).json({ error: 'bad_request', message: 'No organizer email on session.' });

    const token = await auth.getAccessToken(req);
    if (!token) return res.status(401).json({ error: 'unauthenticated' });

    const { eventTitle, eventStart } = req.body || {};

    await graph.sendPhysicianBriefing(token, {
      toEmail: to,
      physician,
      notes: await callNotes.getNotes(physician.npi, to),
      analytics: labelledAnalytics(physician.npi),
      event: {
        title: typeof eventTitle === 'string' ? eventTitle : undefined,
        start: typeof eventStart === 'string' ? eventStart : undefined,
      },
    });

    res.json({ sent: true, to });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/calendar/schedule
 * Body: { npi, subject, start, end, timeZone, notes?, includePreviousNotes? }
 * Creates an Outlook event with the physician as required attendee — Graph
 * emails the invite (with the physician's full details in the body) for us.
 * Unless includePreviousNotes === false, the organizer's latest call note with this
 * physician is appended to the invite as a "Previous call summary".
 */
router.post('/calendar/schedule', requireAuth, async (req, res, next) => {
  try {
    const { npi, subject, start, end, timeZone, notes, includePreviousNotes } = req.body || {};

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

    const previousNote =
      includePreviousNotes === false
        ? null
        : await callNotes.getLatestNote(physician.npi, organizerEmail(req));

    const event = await graph.createMeetingWithPhysician(token, {
      subject: subject.trim(),
      start,
      end,
      timeZone,
      physician,
      notes: typeof notes === 'string' ? notes.trim() : undefined,
      previousNote,
    });

    res.status(201).json({ created: true, event, invitee: { name: physician.name, email: physician.email } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
