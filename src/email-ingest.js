'use strict';

const auth = require('./auth');
const graph = require('./graph');
const physiciansDir = require('./physicians');
const entityMatcher = require('./entity-matcher');
const tokenStore = require('./token-store');
const crm = require('./crm-store');

/**
 * Phase 0 + 1: foundation + Outlook ingestion.
 *
 *  - Activity sync: each signed-in salesperson's calendar events (recent +
 *    upcoming) are upserted into app_activities, with the matched physician
 *    resolved via attendees → entity matcher.
 *  - Email ingestion: the inbox delta is pulled per user; each new reply is
 *    cleaned, written to app_emails (immutable), and linked to an activity by
 *    conversation thread when possible. (Richer matching = Phase 2; AI
 *    extraction = Phase 3.)
 *
 * On a public host this is driven by Graph webhooks; on localhost (no public
 * URL) the same logic runs on a poll, so it's fully testable in dev.
 */

const POLL_SECONDS = Number(process.env.INGEST_POLL_SECONDS) || 300;
const ACTIVITY_WINDOW_MAX = 30 * 24 * 60; // sync meetings up to 30 days ahead

// ── Body cleaning — keep only the new content the sender just wrote ──────────

const QUOTE_MARKERS = [
  /^From:.*$/im,                                  // forwarded/replied header block
  /^On .+ wrote:$/im,                             // "On <date> <name> wrote:"
  /^_{5,}$/m,                                      // "_____" Outlook separator
  /^-{2,}\s*Original Message\s*-{2,}$/im,
  /^Sent from my \w+/im,
];
const SIGNATURE_MARKERS = [
  /^--\s*$/m,                                       // standard "-- " sig delimiter
  /^(Best|Regards|Thanks|Thank you|Sincerely|Cheers|Warm regards)[,!.]?\s*$/im,
];

/** Strip quoted reply trails and signatures; return just the new message. */
function cleanBody(text) {
  if (!text) return '';
  let body = String(text).replace(/\r\n/g, '\n');

  // Cut at the earliest quoted-reply marker.
  let cut = body.length;
  for (const re of QUOTE_MARKERS) {
    const m = body.match(re);
    if (m && m.index < cut) cut = m.index;
  }
  // Drop lines that are quoted (leading ">").
  body = body
    .slice(0, cut)
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');

  // Trim a trailing signature block.
  for (const re of SIGNATURE_MARKERS) {
    const m = body.match(re);
    if (m && m.index > body.length * 0.3) {
      body = body.slice(0, m.index);
      break;
    }
  }

  return body.replace(/\n{3,}/g, '\n\n').trim();
}

/** The physician an event is with: a directory attendee, else a title match. */
async function physicianForEvent(ev) {
  for (const a of ev.attendees || []) {
    const p = physiciansDir.getByEmail(a.email);
    if (p) return p;
  }
  const analysis = await entityMatcher.analyze(
    [ev.title, ev.description].filter(Boolean).join('. ')
  );
  const m = analysis.matched_entities.find((x) => x.entity_type === 'person');
  return m ? physiciansDir.getByNpi(m.master_id) : null;
}

// ── Per-user sync ────────────────────────────────────────────────────────────

async function syncActivities(token, user) {
  // Upcoming meetings (calendarView starts at "now"). Enough for a POC: it
  // gives incoming replies an activity to link onto. Past-window sync can be
  // added later if replies arrive long after a meeting.
  const events = await graph.getUpcomingEvents(token, ACTIVITY_WINDOW_MAX);

  let synced = 0;
  for (const ev of events) {
    if (ev.isAllDay) continue;
    const physician = await physicianForEvent(ev);
    const activity = await crm.upsertActivityFromEvent(
      user.homeAccountId,
      ev,
      physician?.npi,
      physician?.facility?.id
    );
    if (activity) synced++;
  }
  return synced;
}

async function ingestEmails(token, user) {
  const prevDelta = await tokenStore.getMailDelta(user.homeAccountId);
  const { messages, deltaLink } = await graph.getInboxDelta(token, prevDelta);

  let ingested = 0;
  for (const msg of messages) {
    if (!msg.providerMsgId) continue;
    if (await crm.emailExists('outlook', msg.providerMsgId)) continue;

    // Link the reply to an activity: by email thread first (rarely set, since
    // Graph events expose no conversationId), then by the sender physician —
    // the reply usually comes from the doctor we met. (Phase 2 generalizes
    // this into the full weighted matching engine.)
    let activity = await crm.findActivityByThread(user.homeAccountId, msg.threadId);
    if (!activity && msg.fromEmail) {
      const physician = physiciansDir.getByEmail(msg.fromEmail);
      if (physician) {
        activity = await crm.findActivityByPhysician(user.homeAccountId, physician.npi);
      }
    }
    const row = await crm.insertEmail({
      provider: 'outlook',
      provider_msg_id: msg.providerMsgId,
      internet_msg_id: msg.internetMsgId,
      thread_id: msg.threadId,
      owner_user_id: user.homeAccountId,
      activity_id: activity?.id || null,
      from_email: msg.fromEmail,
      from_name: msg.fromName,
      to_emails: msg.toEmails,
      cc_emails: msg.ccEmails,
      subject: msg.subject,
      body_text: cleanBody(msg.bodyText || msg.bodyPreview),
      body_raw: msg.bodyHtml || msg.bodyText || msg.bodyPreview,
      received_at: msg.receivedAt,
    });
    if (row) {
      ingested++;
      await crm.audit({
        actor: 'system',
        action: 'email.ingested',
        entityType: 'email',
        entityId: row.id,
        sourceEmailId: row.id,
        details: { subject: msg.subject, linkedActivity: activity?.id || null },
      });
    }
  }

  if (deltaLink) await tokenStore.setMailDelta(user.homeAccountId, deltaLink);
  return ingested;
}

/** One pass over all signed-in salespeople. Exported for manual runs/tests. */
async function tick() {
  if (!crm.enabled) return;
  let users;
  try {
    users = await tokenStore.listUsers();
  } catch (err) {
    console.warn('[ingest] user list failed:', err.message);
    return;
  }

  for (const user of users) {
    try {
      const token = await auth.getAccessTokenForUser(user);
      if (!token) continue;

      const activities = await syncActivities(token, user);
      const emails = await ingestEmails(token, user);
      if (activities || emails) {
        console.log(`[ingest] ${user.email}: ${activities} activities synced, ${emails} new emails`);
      }
    } catch (err) {
      console.warn(`[ingest] ${user.email || user.homeAccountId}:`, err.message);
    }
  }
}

let timer = null;

function start() {
  if (process.env.INGEST_ENABLED === 'false') {
    console.log('[ingest] disabled via INGEST_ENABLED=false');
    return;
  }
  if (!crm.enabled) {
    console.log('[ingest] no Supabase — email ingestion off');
    return;
  }
  if (timer) return;
  timer = setInterval(tick, POLL_SECONDS * 1000);
  timer.unref?.();
  tick();
  console.log(`[ingest] engine on — syncing activities + ingesting Outlook replies (poll: ${POLL_SECONDS}s)`);
}

module.exports = { start, tick, cleanBody, syncActivities, ingestEmails };
