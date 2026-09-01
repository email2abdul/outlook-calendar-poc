'use strict';

const express = require('express');
const auth = require('../auth');
const graph = require('../graph');
const physicians = require('../physicians');
const callNotes = require('../notes');
const analytics = require('../analytics');
const contactsStore = require('../contacts-store');
const entityMatcher = require('../entity-matcher');
const crm = require('../crm-store');
const emailIngest = require('../email-ingest');
const emailIntelStore = require('../email-intel-store');
const dynamics = require('../dynamics');
const leadMatch = require('../lead-match');
const enrichment = require('../enrichment');
const meetingContext = require('../enrichment/context');
const meetingMatch = require('../meeting-match');
const outsideStore = require('../outside-physician-store');
const outsideSources = require('../outside-sources');
const verify = require('../enrichment/verify');

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

/** The signed-in user's stable id (owner key for CRM rows). */
function ownerId(req) {
  return req.session.account?.homeAccountId || null;
}

// ── Email-intelligence platform: CRM activities + ingested emails ───────────

/**
 * GET /api/activities — the signed-in salesperson's synced CRM activities
 * (calendar meetings), newest first, each with its matched physician name.
 */
router.get('/activities', requireAuth, async (req, res, next) => {
  try {
    const activities = await crm.listActivities(ownerId(req));
    const withPhysician = activities.map((a) => ({
      ...a,
      physician: a.physician_npi ? physicians.getByNpi(a.physician_npi) : null,
    }));
    res.json({ activities: withPhysician });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/activities/:id/emails — the ingested email thread for one activity.
 */
router.get('/activities/:id/emails', requireAuth, async (req, res, next) => {
  try {
    const activities = await crm.listActivities(ownerId(req));
    const activity = activities.find((a) => a.id === req.params.id);
    if (!activity) return res.status(404).json({ error: 'activity_not_found' });
    const emails = await crm.listEmailsForThread(ownerId(req), activity.thread_id);
    res.json({ activity, emails });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/ingest/run — trigger an ingestion pass now (sync activities +
 * pull new email replies) instead of waiting for the poll. Handy for demos.
 */
router.post('/ingest/run', requireAuth, async (req, res, next) => {
  try {
    await emailIngest.tick();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

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
    // Whether the master directory actually loaded. An empty directory answers
    // every physician lookup with "nobody", which is indistinguishable from a
    // genuine miss — so say it out loud rather than letting the UI guess.
    res.json({
      authenticated: true,
      user: profile,
      directory: { ready: physicians.isLoaded(), physicians: physicians.getAllPhysicians().length },
    });
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
    // organizer's latest meeting note for that physician (the "last call" hint).
    const organizer = organizerEmail(req);

    // What has already been DECIDED for these meetings — the latest record per
    // meeting, one query for the whole day. A physician the rep confirmed
    // outranks every automatic guess below, and is why a shortlist is asked
    // once rather than on every page load.
    let decided = new Map();
    if (outsideStore.enabled) {
      try {
        decided = await outsideStore.latestForEvents(
          ownerId(req),
          data.events.map((e) => e.id)
        );
      } catch (err) {
        // No decision history is a worse day view, not a broken one — and a
        // missing table is a setup step, not an error worth 500-ing over.
        console.warn('[api] meeting decisions unavailable:', err.message);
      }
    }

    data.events = await Promise.all(
      data.events.map(async (ev) => {
        // Only ATTENDEES are matched against the directory — never the person
        // who scheduled the meeting (nor the signed-in user). They stay on the
        // list for display, but carry no physician match.
        const attendees = await Promise.all(
          ev.attendees.map(async (a) => {
            const excluded = meetingContext.isOrganizer(ev, a.email, organizer);
            const physician = excluded ? null : physicians.getByEmail(a.email);
            return {
              ...a,
              isOrganizer: excluded,
              physician,
              lastNote: physician ? await callNotes.getLatestNote(physician.npi, organizer) : null,
            };
          })
        );

        // When an attendee is an EXACT email match, that IS who the meeting is
        // with — skip the title analysis entirely so no title-based option
        // chips compete with the confirmed physician (and save the AI call).
        const attendeeNpis = new Set(attendees.map((a) => a.physician?.npi).filter(Boolean));
        if (attendeeNpis.size) {
          return { ...ev, attendees, titleMatches: [], titlePeople: [], entityAnalysis: null, match: null };
        }

        // No email match — run the rep's ladder (src/meeting-match.js) BEFORE
        // any title analysis, because it decides whether a name path is even
        // allowed: the title must say "Dr"/"Doctor", and then the name has to
        // be in the master. Its answer is what the UI renders.
        // Only a decision the REP made pins the meeting; an automatic record is
        // just history, and must not stop the ladder re-deriving (and improving)
        // its own answer.
        const decision = decided.get(String(ev.id)) || null;
        const match = meetingMatch.matchMeeting(ev, {
          selfEmail: organizer,
          chosenNpi: decision?.decidedBy === 'user' ? decision.npi : null,
        });

        // Resolved by name, or narrowed to a shortlist the rep picks from:
        // either way the person is IN the master, so title chips and external
        // lookups would only compete with the answer we already have.
        if (match.status === 'matched' || match.status === 'choose') {
          return { ...ev, attendees, titleMatches: [], titlePeople: [], entityAnalysis: null, match };
        }

        // The gate said no: the title never calls anyone a doctor. Person
        // chips from the title are exactly what the gate withholds, so they
        // are not computed at all (nor is the analysis that produces them).
        // An attendee who HAS an address is still looked up outside BIS — that
        // is an email path, not a name path, and the gate does not govern it.
        if (match.status === 'gate_blocked') {
          return { ...ev, attendees, titleMatches: [], titlePeople: [], entityAnalysis: null, match };
        }

        // No email match — fall back to entity analysis over the WHOLE event
        // text (title + description): people / facilities / organizations /
        // locations are extracted, classified and matched against the Supabase
        // master data. Matched physicians (and suggestions, when nothing clears
        // the confidence threshold) become option chips so the user picks who
        // the meeting is actually with.
        // Title/description give facility and other context — but a person
        // named there who is really the organizer is filtered out first.
        const entityAnalysis = meetingContext.stripOrganizerPeople(
          await entityMatcher.analyze([ev.title, ev.description].filter(Boolean).join('. ')),
          ev,
          organizer
        );
        const titleMatches = entityMatcher.physicianProfilesFrom(entityAnalysis, {
          exclude: attendeeNpis,
        });

        // People NAMED in the title who are NOT in the master. Without this a
        // meeting booked as "meeting with dr Geoffrey Aaron" — no attendee, no
        // BIS row — showed nothing at all; the UI enriches these by name.
        const matchedNames = titleMatches.map((p) => String(p.name || '').toLowerCase());
        const titlePeople = meetingContext
          .namesFromEvent(ev, { selfEmail: organizer })
          .filter((person) => {
            const tokens = person.name.toLowerCase().split(/\s+/);
            return !matchedNames.some((n) => tokens.every((t) => n.includes(t)));
          });

        return { ...ev, attendees, titleMatches, titlePeople, entityAnalysis, match };
      })
    );

    res.json(data);
  } catch (err) {
    next(err);
  }
}

router.get('/calendar/day', requireAuth, dayHandler);
router.get('/calendar/today', requireAuth, dayHandler);

/**
 * POST /api/entities/analyze
 * Body: { text }
 * Analyze ANY text — meeting title, email subject/body, message — and return
 * extracted entities (people / facilities / organizations / locations), their
 * classification (Doctor, Professor, Hospital, Medical College, University,
 * …), matches against the master data with 0–100 confidence, and top-5
 * suggestions with reasons when nothing clears the confidence threshold.
 */
router.post('/entities/analyze', requireAuth, async (req, res, next) => {
  try {
    const { text } = req.body || {};
    if (typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({ error: 'bad_request', message: 'text is required' });
    }
    res.json(await entityMatcher.analyze(text));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/physicians/search?q=smith
 * Free-text search over the physician directory (name / NPI / email /
 * specialty / facility name / facility city), ranked best-match-first in
 * Supabase. Physicians with an email sort first.
 */
router.get('/physicians/search', requireAuth, async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (q.trim().length < 2) {
      return res.json({ query: q, results: [] });
    }
    res.json({ query: q, results: await physicians.search(q) });
  } catch (err) {
    next(err);
  }
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
router.get('/physicians/:npi/analytics', requireAuth, async (req, res, next) => {
  try {
    const physician = physicians.getByNpi(req.params.npi);
    if (!physician) return res.status(404).json({ error: 'physician_not_found' });

    res.json({ npi: physician.npi, analytics: await analytics.getLabelledAnalytics(physician.npi) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/physicians/:npi/brief
 * The pre-meeting brief HTML — the SAME body the email briefing uses
 * (graph.physicianBriefHtml), so the in-app brief and the emailed brief match
 * exactly. Sections with no data for this physician render empty (omitted).
 */
router.get('/physicians/:npi/brief', requireAuth, async (req, res, next) => {
  try {
    const physician = physicians.getByNpi(req.params.npi);
    if (!physician) return res.status(404).json({ error: 'physician_not_found' });

    const [analyticsData, contact, verification] = await Promise.all([
      analytics.getLabelledAnalytics(physician.npi),
      contactsStore.getContact(physician.npi),
      verify.verifyPhysician(physician),
    ]);
    res.json({
      npi: physician.npi,
      html: graph.physicianBriefHtml({ physician, analytics: analyticsData, contact, verification }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/physicians/:npi/notes
 * The signed-in organizer's meeting-note history with this physician,
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
 * Save a meeting note for this physician.
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
 * details plus the organizer's full meeting-note history with them.
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
      analytics: await analytics.getLabelledAnalytics(physician.npi),
      contact: await contactsStore.getContact(physician.npi),
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
 * Unless includePreviousNotes === false, the organizer's latest meeting note with this
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

    // Persist the meeting → physician link (the EXPLICITLY chosen physician),
    // keyed by calendar event id, so the 90-min reminder briefs this same
    // physician — making the reminder's brief match the auto-brief's. Best-effort.
    const homeAccountId = req.session.account?.homeAccountId;
    if (homeAccountId && crm.enabled) {
      try {
        await crm.upsertActivityFromEvent(homeAccountId, event, physician.npi, physician.facility?.id);
      } catch (err) {
        console.warn('[schedule] activity link failed:', err.message);
      }
    }

    // Auto-brief the salesperson: full physician info (details + analytics +
    // their note history) lands in their own inbox the moment the meeting is
    // booked. A mail failure must not fail the booking itself.
    let briefingSent = false;
    let briefingTo = null;
    let briefingError = null;
    const to = organizerEmail(req);
    if (!to) {
      briefingError = 'No organizer email on session';
    } else {
      try {
        briefingTo = await graph.sendPhysicianBriefing(token, {
          toEmail: to,
          physician,
          notes: await callNotes.getNotes(physician.npi, to),
          analytics: await analytics.getLabelledAnalytics(physician.npi),
          contact: await contactsStore.getContact(physician.npi),
          event: { title: event.title, start: event.start, timeZone: event.timeZone },
        });
        briefingSent = true;
      } catch (err) {
        briefingError = err.message;
        console.warn('[schedule] auto-briefing failed:', err.message);
      }
    }

    res.status(201).json({
      created: true,
      event,
      briefingSent,
      briefingTo, // where the brief actually went (may differ from the rep via BRIEFING_TO_EMAIL)
      briefingError,
      invitee: { name: physician.name, email: physician.email },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/email-intel — the signed-in rep's Email Intelligence Sheet: one row
 * per physician-related inbox email (physician/facility/CPT + what's new vs the
 * bis_* data, with meeting context), newest first. Powers the in-app sheet + CSV.
 */
router.get('/email-intel', requireAuth, async (req, res, next) => {
  try {
    const rows = await emailIntelStore.listIntel(ownerId(req));
    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/meetings/match?eventId=… — who is this meeting with?
 *
 * The cheap ladder only (src/meeting-match.js): attendee email in the master →
 * the "Dr"/"Doctor" gate on the title → that name in the master. Nothing paid
 * and nothing external runs here, so the UI can call it for any meeting.
 *
 * `status` tells the caller what to render:
 *   matched         → `physicians` — show the brief(s)
 *   choose          → `groups[].candidates` — the rep picks (≤ 5 each)
 *   needs_external  → nobody in BIS; the registries are the next step
 *   gate_blocked    → normal meeting; no lookup was run (title has no "Dr")
 *   no_name         → gate passed but no readable full name
 *
 * The event is re-read from Graph rather than taken from the request, so a
 * meeting the rep just edited is judged on its CURRENT title and attendees.
 */
router.get('/meetings/match', requireAuth, async (req, res, next) => {
  try {
    const eventId = typeof req.query.eventId === 'string' ? req.query.eventId.trim() : '';
    if (!eventId) {
      return res.status(400).json({ error: 'bad_request', message: 'eventId is required.' });
    }

    const token = await auth.getAccessToken(req);
    let event;
    try {
      event = await graph.getEventById(token, eventId);
    } catch (err) {
      // A deleted/moved event is a client mistake, not a server fault.
      if (err.statusCode === 404 || err.code === 'ErrorItemNotFound') {
        return res.status(404).json({ error: 'not_found', message: 'That meeting no longer exists.' });
      }
      throw err;
    }

    const result = meetingMatch.matchMeeting(event, { selfEmail: organizerEmail(req) });
    res.json({
      eventId,
      title: event.title,
      start: event.start,
      timeZone: event.timeZone,
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/meetings/outside?eventId=… — who this meeting could be with, from the
 * public sources, when the BIS master has nobody.
 *
 * Deliberately NOT part of the day view: this leaves the building (NPPES today,
 * whatever is registered tomorrow), so it runs when a rep opens the meeting, not
 * for twelve meetings on page load.
 *
 * The NAME is not taken from the request. It is re-derived server-side from the
 * current event through the same ladder — the "Dr"/"Doctor" gate, the organizer
 * exclusion, the conservative title reader — because a client-supplied name
 * would walk straight past all three.
 *
 * A candidate whose NPI turns out to be in bis_physicians is flagged `inBis`:
 * the physician WAS in the master all along, under a name or address the meeting
 * never carried, and that is the best outcome this endpoint can report.
 */
router.get('/meetings/outside', requireAuth, async (req, res, next) => {
  try {
    const eventId = typeof req.query.eventId === 'string' ? req.query.eventId.trim() : '';
    if (!eventId) {
      return res.status(400).json({ error: 'bad_request', message: 'eventId is required.' });
    }

    const token = await auth.getAccessToken(req);
    let event;
    try {
      event = await graph.getEventById(token, eventId);
    } catch (err) {
      if (err.statusCode === 404 || err.code === 'ErrorItemNotFound') {
        return res.status(404).json({ error: 'not_found', message: 'That meeting no longer exists.' });
      }
      throw err;
    }

    const organizer = organizerEmail(req);
    const match = meetingMatch.matchMeeting(event, { selfEmail: organizer });

    // Only a meeting the ladder could not resolve inside BIS has anything to
    // look up outside it.
    if (match.status !== 'needs_external') {
      return res.json({
        eventId,
        status: match.status,
        searched: false,
        reason: match.reason,
        groups: [],
        failures: [],
        sources: outsideSources.list().map((x) => ({ id: x.id, name: x.name, url: x.url })),
      });
    }

    // Geography is what separates same-named providers, and the meeting usually
    // carries it (title, description, location).
    let hints = {};
    try {
      hints = await meetingContext.hintsFromEvent(event, { selfEmail: organizer });
    } catch {
      /* context is a bonus, never a blocker */
    }

    const groups = [];
    const failures = [];
    for (const name of match.unresolvedNames) {
      const { firstName, lastName } = enrichment.splitName(name);
      const found = await outsideSources.searchByName(
        { firstName, lastName, state: hints.state || undefined, city: hints.city || undefined },
        { limit: meetingMatch.MAX_CANDIDATES }
      );
      failures.push(...found.failures);

      const candidates = found.candidates.map((c) => {
        // Free, and the most valuable check there is: does the master already
        // hold this NPI under a different name/address?
        const bis = c.npi ? physicians.getByNpi(c.npi) : null;
        return bis
          ? { ...c, ...outsideStore.mirrorFromPhysician(bis), inBis: true, extra: c.extra }
          : { ...c, inBis: false };
      });

      groups.push({ name, source: 'title', total: candidates.length, candidates });
    }

    res.json({
      eventId,
      status: match.status,
      searched: true,
      reason: match.reason,
      // The names that were looked up — needed by the UI even when a source was
      // unreachable and there is no candidate to carry them.
      names: match.unresolvedNames,
      hints: { city: hints.city || null, state: hints.state || null, facility: hints.facilityName || null },
      groups,
      // A source that could not be reached is NOT a source that said "nobody" —
      // the UI has to be able to say which happened.
      failures,
      sources: outsideSources.list().map((x) => ({ id: x.id, name: x.name, url: x.url })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/meetings/choose — remember which physician this meeting is with.
 * Body: { eventId, npi }   ·   npi: null clears the choice
 *
 * The shortlist asks a question only the rep can answer; this is where the
 * answer is kept — as a new row in app_meeting_physician, stamped with the rep
 * and the moment, so the history survives a correction. app_activities is then
 * pointed at the same physician through the column it already has, so the
 * reminder brief and reply→note linking follow the choice with no change of
 * their own.
 *
 * Until supabase/outside-physician-setup.sql is run, the store keeps the row in
 * a local SQLite file instead and `storedIn` says so, so the whole flow can be
 * tested before the table exists.
 */
router.post('/meetings/choose', requireAuth, async (req, res, next) => {
  try {
    const eventId = typeof req.body?.eventId === 'string' ? req.body.eventId.trim() : '';
    const rawNpi = req.body?.npi;
    if (!eventId) {
      return res.status(400).json({ error: 'bad_request', message: 'eventId is required.' });
    }
    const clearing = rawNpi === null || rawNpi === undefined || rawNpi === '';
    const npi = clearing ? null : String(rawNpi).trim();
    if (!clearing && !/^\d{10}$/.test(npi)) {
      return res.status(400).json({ error: 'bad_request', message: 'npi must be 10 digits, or null to clear.' });
    }
    if (!crm.enabled) {
      return res.status(503).json({
        error: 'unavailable',
        message: 'Supabase is not configured, so the choice cannot be remembered.',
      });
    }

    // In the master? Then the brief is the standard one.
    const physician = npi ? physicians.getByNpi(npi) : null;

    // Not in the master — the NPI must then belong to a registered source, and
    // it is re-fetched FROM that source rather than taken from the request: the
    // browser is not allowed to decide what a physician's details are.
    const sourceId = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    let outside = null;
    if (npi && !physician) {
      const src = sourceId ? outsideSources.byId(sourceId) : null;
      if (!src) {
        return res.status(400).json({
          error: 'bad_request',
          message: `NPI ${npi} is not in the BIS directory. Pass \`source\` (one of: ` +
            `${outsideSources.list().map((x) => x.id).join(', ')}) to record an outside physician.`,
        });
      }
      try {
        outside = src.getByNpi ? await src.getByNpi(npi) : null;
      } catch (err) {
        return res.status(502).json({
          error: 'source_unreachable',
          message: `${src.name} could not be reached, so this choice was not recorded. Try again.`,
          detail: err.message,
        });
      }
      if (!outside) {
        return res.status(400).json({
          error: 'bad_request',
          message: `${src.name} has no provider with NPI ${npi}.`,
        });
      }
    }

    const token = await auth.getAccessToken(req);
    let event;
    try {
      event = await graph.getEventById(token, eventId);
    } catch (err) {
      if (err.statusCode === 404 || err.code === 'ErrorItemNotFound') {
        return res.status(404).json({ error: 'not_found', message: 'That meeting no longer exists.' });
      }
      throw err;
    }

    // Append a new row rather than editing one: the correction history ("A on
    // Monday, B on Tuesday") is the point, and the latest row is what counts.
    // The store keeps this in SQLite until the Supabase table exists, so the
    // flow is testable before anybody runs the setup SQL.
    // The mirror fields, from whichever side has them. `extra` is left out on
    // purpose: it is shown in the notes, not stored (a separate decision).
    const mirror = physician
      ? outsideStore.mirrorFromPhysician(physician)
      : outside
        ? { ...outside, extra: undefined, inBis: false }
        : {};
    delete mirror.extra;

    const who = physician?.name || outside?.name || npi;
    const record = await outsideStore.record({
      ownerUserId: ownerId(req),
      ownerEmail: organizerEmail(req),
      event,
      ...mirror,
      npi,
      source: 'user',
      decidedBy: 'user',
      confidence: 100,
      status: npi ? 'briefed' : 'needs_confirm',
      reason: npi
        ? `${who} confirmed by ${organizerEmail(req) || 'the rep'}` +
          (outside ? ` (from ${outsideSources.byId(sourceId)?.name || sourceId}; not in BIS).` : '.')
        : `Choice cleared by ${organizerEmail(req) || 'the rep'}; the meeting is back on the ladder.`,
    });

    // Keep the meeting row pointing at the same physician, using the column it
    // already has, so the reminder brief and reply→note linking follow along.
    try {
      if (crm.enabled) await crm.setActivityPhysician(ownerId(req), event, npi);
    } catch (err) {
      console.warn('[api] activity physician update failed:', err.message);
    }

    await crm.audit({
      actor: 'user',
      action: npi ? 'meeting.physician_chosen' : 'meeting.physician_choice_cleared',
      entityType: 'outside_physician',
      entityId: record?.id ? String(record.id) : null,
      details: { eventId, npi, title: event.title, by: organizerEmail(req) },
    });

    // An outside physician has no /api/physicians/:npi/brief to fetch, so the
    // notes come back with the save — same sections as the BIS brief, with
    // "Data not available" wherever the source had nothing.
    const html = outside
      ? graph.outsideBriefHtml({
          record,
          extra: outside.extra || {},
          sourceName: outsideSources.byId(sourceId)?.name || sourceId,
          sourceUrl: outside.externalSourceUrl || outsideSources.byId(sourceId)?.url || null,
        })
      : null;

    res.json({
      saved: true,
      eventId,
      cleared: !npi,
      // 'sqlite' means the Supabase table has not been created yet — the choice
      // is kept locally so it can be tested, and the UI says so.
      storedIn: outsideStore.backendName(),
      inBis: Boolean(physician),
      physician: physician
        ? { npi: physician.npi, name: physician.name, specialty: physician.specialty || null }
        : outside
          ? { npi: outside.npi, name: outside.name, specialty: outside.specialty || null }
          : null,
      html,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/enrich?email=&name=&firstName=&lastName=&state=&city=&npi=&facility=
 *
 * Identify someone who is NOT in the BIS directory and build a
 * provenance-tagged profile for them — every field carrying the source it came
 * from (see docs/external-enrichment-agent.md).
 *
 * Free tiers (BIS + NPPES + CMS) always run. The paid web-identity tier runs
 * only when there is something to buy — no name supplied and a personal-looking
 * mailbox; pass `useWeb=never` to force it off or `useWeb=always` to force it
 * on. `context` passes the meeting title/description for disambiguation.
 *
 * `status` tells the caller what happened:
 *   in_bis            → already in bis_physicians, use the normal brief
 *   recovered_in_bis  → the email was missing, but the NPI is in the master
 *   external          → genuinely outside BIS; registry profile returned
 *   facility_only     → person unresolved, facility identified
 *   not_physician     → identified, but not a clinician — no brief produced
 *   unresolved        → nothing confident enough; candidates listed
 *   lookup_failed     → a registry was unreachable (DNS/network) — no conclusion
 *                       was reached about this person; `sourcesDown` says which
 */
router.get('/enrich', requireAuth, async (req, res, next) => {
  try {
    const { email, name, firstName, lastName, state, city, npi, facility, context, useWeb, refresh } =
      req.query;

    if (!email && !name && !lastName && !npi) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'Provide at least one of: email, name, lastName, npi.',
      });
    }

    const result = await enrichment.enrich({
      email: typeof email === 'string' ? email : undefined,
      name: typeof name === 'string' ? name : undefined,
      firstName: typeof firstName === 'string' ? firstName : undefined,
      lastName: typeof lastName === 'string' ? lastName : undefined,
      state: typeof state === 'string' ? state : undefined,
      city: typeof city === 'string' ? city : undefined,
      npi: typeof npi === 'string' ? npi : undefined,
      facilityName: typeof facility === 'string' ? facility : undefined,
      meetingContext: typeof context === 'string' ? context : undefined,
      useWeb: useWeb === 'never' || useWeb === 'always' ? useWeb : undefined,
      refresh: refresh === '1' || refresh === 'true',
    });

    // Render server-side, like /api/physicians/:npi/brief and /api/leads/match:
    // a physician already in BIS gets the STANDARD brief (nothing is enriched
    // about them), anyone else gets the provenance-tagged external one.
    if (result.status === 'in_bis' && result.physician) {
      const [analyticsData, contact, verification] = await Promise.all([
        analytics.getLabelledAnalytics(result.physician.npi),
        contactsStore.getContact(result.physician.npi),
        verify.verifyPhysician(result.physician),
      ]);
      result.html = graph.physicianBriefHtml({
        physician: result.physician,
        analytics: analyticsData,
        contact,
        verification,
      });
    } else if (result.status === 'recovered_in_bis' && result.physician) {
      const [analyticsData, contact, verification] = await Promise.all([
        analytics.getLabelledAnalytics(result.physician.npi),
        contactsStore.getContact(result.physician.npi),
        verify.verifyPhysician(result.physician),
      ]);
      result.html =
        graph.externalBriefHtml(result) +
        graph.physicianBriefHtml({
          physician: result.physician,
          analytics: analyticsData,
          contact,
          verification,
        });
    } else {
      result.html = graph.externalBriefHtml(result);
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/enrich/promote
 * Body: { npi, email?, mobile?, linkedinUrl?, confidence?, source? }
 *
 * Promote enriched contact details the rep has CONFIRMED into app_contacts,
 * the Contact Intelligence overlay the brief already reads.
 *
 * This is the only path by which enrichment data becomes part of the app's own
 * records, and it is deliberately manual: the agent writes to its cache
 * automatically, but a human decides what is trustworthy enough to keep.
 * bis_* is never written to — the master stays read-only.
 */
router.post('/enrich/promote', requireAuth, async (req, res, next) => {
  try {
    const { npi, email, mobile, linkedinUrl, confidence, source } = req.body || {};
    if (typeof npi !== 'string' || !/^\d{10}$/.test(npi.trim())) {
      return res.status(400).json({ error: 'bad_request', message: 'A 10-digit npi is required.' });
    }
    if (!email && !mobile && !linkedinUrl) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'Nothing to promote — provide at least one of email, mobile, linkedinUrl.',
      });
    }
    if (!contactsStore.enabled) {
      return res.status(503).json({ error: 'unavailable', message: 'Contact store not configured.' });
    }

    const today = new Date().toISOString().slice(0, 10);
    await contactsStore.upsertContact({
      npi: npi.trim(),
      email: typeof email === 'string' ? email.trim().toLowerCase() : null,
      mobile: typeof mobile === 'string' ? mobile.trim() : null,
      linkedin_url: typeof linkedinUrl === 'string' ? linkedinUrl.trim() : null,
      confidence_score: Number.isFinite(confidence) ? confidence : null,
      last_verified: today,
      last_refresh: today,
      // Provenance travels with the row: a later reader can tell this came from
      // the agent and was accepted by a person, not typed in from nowhere.
      source: typeof source === 'string' && source.trim()
        ? `enrichment:${source.trim()} (confirmed by ${organizerEmail(req) || 'user'})`
        : `enrichment (confirmed by ${organizerEmail(req) || 'user'})`,
    });

    res.status(201).json({ promoted: true, npi: npi.trim() });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/leads — Lead records read from Dynamics 365 (app-only). Phase 1
 * returns just first/last name. `configured` tells the UI whether the Dynamics
 * env vars are set, so it can show a helpful hint instead of an empty list.
 */
router.get('/leads', requireAuth, async (req, res, next) => {
  try {
    if (!dynamics.isConfigured()) {
      return res.json({ configured: false, leads: [] });
    }
    const leads = await dynamics.getLeads();
    res.json({ configured: true, leads });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/leads/match?email=&firstName=&lastName=&company=
 * Enrich a Dynamics lead with BIS (Supabase) data. Matches the lead to a
 * physician in priority order (email → name → facility) and, for a physician
 * hit, returns the SAME pre-meeting brief HTML the email/in-app brief use
 * (graph.physicianBriefHtml). For a facility-only hit, returns the facility +
 * candidate physicians there. `matchedBy:null` when nothing matches.
 */
router.get('/leads/match', requireAuth, async (req, res, next) => {
  try {
    const { email, firstName, lastName, company } = req.query;
    const result = await leadMatch.matchLeadToBis({ email, firstName, lastName, company });

    if (result.matchedBy === 'email' || result.matchedBy === 'name') {
      // Re-resolve the full profile by NPI so the brief has every field.
      const physician =
        physicians.getByNpi(result.physician.npi) || result.physician;
      const [analyticsData, contact, verification] = await Promise.all([
        analytics.getLabelledAnalytics(physician.npi),
        contactsStore.getContact(physician.npi),
        verify.verifyPhysician(physician),
      ]);
      return res.json({
        matchedBy: result.matchedBy,
        physician: {
          npi: physician.npi,
          name: physician.name,
          specialty: physician.specialty,
          facility: physician.facility || null,
        },
        html: graph.physicianBriefHtml({ physician, analytics: analyticsData, contact, verification }),
      });
    }

    if (result.matchedBy === 'facility') {
      return res.json({
        matchedBy: 'facility',
        facility: result.facility || null,
        candidates: (result.candidates || []).map((c) => ({
          npi: c.npi,
          name: c.name,
          specialty: c.specialty || null,
        })),
      });
    }

    return res.json({ matchedBy: null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
