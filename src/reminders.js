'use strict';

const auth = require('./auth');
const graph = require('./graph');
const physiciansDir = require('./physicians');
const context = require('./enrichment/context');
const callNotes = require('./notes');
const analytics = require('./analytics');
const contactsStore = require('./contacts-store');
const crm = require('./crm-store');
const tokenStore = require('./token-store');

/**
 * Pre-meeting reminder engine.
 *
 * Every REMINDER_POLL_SECONDS it walks every signed-in salesperson (from the
 * token store), silently refreshes their tokens, scans their upcoming
 * calendar, and for ANY meeting that matches a physician in the master data —
 * whether it was created through this app or directly in Outlook — emails
 * them a reminder + full briefing (details, analytics, their meeting-note
 * history) REMINDER_LEAD_MINUTES before the meeting starts. A persisted
 * sent-log guarantees exactly one reminder per meeting per user.
 */

const LEAD_MINUTES = Number(process.env.REMINDER_LEAD_MINUTES) || 90;
const POLL_SECONDS = Number(process.env.REMINDER_POLL_SECONDS) || 300;

/** UTC epoch-ms of an event's start (getUpcomingEvents returns UTC times). */
function startUtcMs(ev) {
  if (!ev.start) return null;
  const iso = ev.start.replace(/\.\d+$/, '');
  const ms = Date.parse(iso.endsWith('Z') ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Every physician this meeting is with, deduped by NPI. A meeting can list more
 * than one physician as an attendee (the rep invited two doctors) — each gets
 * their own brief. Sources:
 *  1) attendees whose email is an EXACT match in the master directory (ALL of
 *     them — this is what makes a two-physician meeting produce two briefs);
 *  2) the physician the meeting was SCHEDULED with (the app_activity) — kept so
 *     an app-scheduled physician who isn't listed as an email attendee is still
 *     briefed, and the reminder matches the auto-brief;
 *
 * Identity comes from those two sources only. The organizer is never matched,
 * and the title/description are never used to guess who the meeting is with —
 * a wrong guess here emails a brief about the wrong physician.
 */
async function physiciansForEvent(ev, ownerUserId, selfEmail) {
  const found = new Map(); // npi → physician (dedupes overlap between sources)

  // 1) exact email matches on the ATTENDEE list. The organizer (the rep who
  //    scheduled the meeting) is never matched — see enrichment/context.js.
  for (const a of context.attendeesToEnrich(ev, { selfEmail })) {
    const p = physiciansDir.getByEmail(a.email);
    if (p) found.set(p.npi, p);
  }

  // 2) the physician the meeting was scheduled with (authoritative for
  //    app-created meetings; may already be one of the email matches above).
  if (ownerUserId && ev.id) {
    try {
      const act = await crm.findActivityByEventId(ownerUserId, ev.id);
      if (act?.physician_npi) {
        const p = physiciansDir.getByNpi(act.physician_npi);
        if (p) found.set(p.npi, p);
      }
    } catch {
      /* activity lookup unavailable — the attendee matches still stand */
    }
  }

  return [...found.values()];
}

/** Back-compat single-physician helper — the first match, or null. */
async function physicianForEvent(ev, ownerUserId, selfEmail) {
  return (await physiciansForEvent(ev, ownerUserId, selfEmail))[0] || null;
}

/** One scan over all users — exported for tests and manual runs. */
async function tick() {
  let users;
  try {
    users = await tokenStore.listUsers();
  } catch (err) {
    console.warn('[reminders] user list failed:', err.message);
    return;
  }

  for (const user of users) {
    try {
      const token = await auth.getAccessTokenForUser(user);
      if (!token) continue; // refresh token gone — resumes after next sign-in

      const events = await graph.getUpcomingEvents(token, LEAD_MINUTES + 5);
      for (const ev of events) {
        if (ev.isAllDay) continue;
        const ms = startUtcMs(ev);
        if (ms == null) continue;

        const minutes = Math.round((ms - Date.now()) / 60000);
        if (minutes <= 0 || minutes > LEAD_MINUTES) continue;
        if (await tokenStore.wasReminderSent(user.homeAccountId, ev.id)) continue;

        // Every physician on the meeting (exact-email attendees + scheduled
        // physician) goes into ONE reminder email with a section each.
        const physicians = await physiciansForEvent(ev, user.homeAccountId, user.email);
        if (!physicians.length) continue; // not a physician meeting — no reminder

        const bundles = [];
        for (const physician of physicians) {
          bundles.push({
            physician,
            notes: await callNotes.getNotes(physician.npi, user.email),
            analytics: await analytics.getLabelledAnalytics(physician.npi),
            contact: await contactsStore.getContact(physician.npi),
          });
        }
        const names = physicians.map((p) => p.name || p.npi).join(', ');

        await graph.sendPhysiciansBriefing(token, {
          toEmail: user.email,
          physicians: bundles,
          event: { title: ev.title, start: ev.start, timeZone: ev.timeZone },
          subject: `⏰ In ${minutes} min: ${ev.title} — ${names}`,
          intro:
            `Reminder: your meeting "${ev.title}" starts in about ${minutes} minutes. ` +
            (physicians.length > 1
              ? `${physicians.length} physicians are on this meeting; their briefings are below.`
              : 'Your briefing is below.'),
        });
        await tokenStore.markReminderSent(user.homeAccountId, ev.id);
        console.log(`[reminders] sent to ${user.email} — "${ev.title}" (${names}) in ${minutes} min`);
      }
    } catch (err) {
      console.warn(`[reminders] ${user.email || user.homeAccountId}:`, err.message);
    }
  }
}

let timer = null;

/** Start polling (no-op when already running or REMINDERS_ENABLED=false). */
function start() {
  if (process.env.REMINDERS_ENABLED === 'false') {
    console.log('[reminders] disabled via REMINDERS_ENABLED=false');
    return;
  }
  if (timer) return;
  timer = setInterval(tick, POLL_SECONDS * 1000);
  timer.unref?.(); // never keep the process alive on its own
  tick();
  console.log(
    `[reminders] engine on — emailing ${LEAD_MINUTES} min before matched meetings (poll: ${POLL_SECONDS}s)`
  );
}

module.exports = { start, tick, physiciansForEvent, physicianForEvent };
