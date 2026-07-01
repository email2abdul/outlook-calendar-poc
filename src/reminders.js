'use strict';

const auth = require('./auth');
const graph = require('./graph');
const physiciansDir = require('./physicians');
const entityMatcher = require('./entity-matcher');
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
 * The physician this meeting is with. Priority:
 *  1) the physician the meeting was SCHEDULED with (the app_activity for this
 *     event) — authoritative, so the reminder briefs the SAME physician the
 *     auto-brief did and the two emails match;
 *  2) an attendee in the directory;
 *  3) a confident entity match from the title/description.
 */
async function physicianForEvent(ev, ownerUserId) {
  if (ownerUserId && ev.id) {
    try {
      const act = await crm.findActivityByEventId(ownerUserId, ev.id);
      if (act?.physician_npi) {
        const p = physiciansDir.getByNpi(act.physician_npi);
        if (p) return p;
      }
    } catch {
      /* fall through to attendee/title matching */
    }
  }
  for (const a of ev.attendees || []) {
    const p = physiciansDir.getByEmail(a.email);
    if (p) return p;
  }
  const analysis = await entityMatcher.analyze(
    [ev.title, ev.description].filter(Boolean).join('. ')
  );
  const match = analysis.matched_entities.find((m) => m.entity_type === 'person');
  return match ? physiciansDir.getByNpi(match.master_id) : null;
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

        const physician = await physicianForEvent(ev, user.homeAccountId);
        if (!physician) continue; // not a physician meeting — no reminder

        await graph.sendPhysicianBriefing(token, {
          toEmail: user.email,
          physician,
          notes: await callNotes.getNotes(physician.npi, user.email),
          analytics: await analytics.getLabelledAnalytics(physician.npi),
          contact: await contactsStore.getContact(physician.npi),
          event: { title: ev.title, start: ev.start, timeZone: ev.timeZone },
          subject: `⏰ In ${minutes} min: ${ev.title} — ${physician.name || physician.npi}`,
          intro: `Reminder: your meeting "${ev.title}" starts in about ${minutes} minutes. Your briefing is below.`,
        });
        await tokenStore.markReminderSent(user.homeAccountId, ev.id);
        console.log(`[reminders] sent to ${user.email} — "${ev.title}" in ${minutes} min`);
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

module.exports = { start, tick, physicianForEvent };
