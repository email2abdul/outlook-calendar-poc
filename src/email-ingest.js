'use strict';

const auth = require('./auth');
const graph = require('./graph');
const physiciansDir = require('./physicians');
const entityMatcher = require('./entity-matcher');
const tokenStore = require('./token-store');
const crm = require('./crm-store');
const callNotes = require('./notes');
const aiExtractor = require('./ai-extractor');

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
    const cleanedBody = cleanBody(msg.bodyText || msg.bodyPreview);
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
      body_text: cleanedBody,
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
      // Per-reply AI MOM → Meeting Notes. Runs once per email (only on a fresh
      // insert), so each reply is summarized exactly once. Best-effort.
      await extractToNote({ activity, cleanedBody, msg, user });
    }
  }

  if (deltaLink) await tokenStore.setMailDelta(user.homeAccountId, deltaLink);
  return ingested;
}

/** True for actual replies ("RE: ...") — used to skip the original briefing/invite. */
function isReplySubject(subject) {
  return /^\s*re\s*:/i.test(subject || '');
}

/**
 * Ingest the rep's OWN replies from Sent Items. When the rep replies to a
 * briefing/meeting thread, that reply lands in Sent (not the Inbox), so the
 * inbox delta never sees it. We fetch recent Sent Items, keep only replies
 * ("RE: …" — skipping the briefings/invites the app itself sent), and run the
 * same AI-MOM extraction. Dedup is on (provider, provider_msg_id); extraction
 * runs once per reply (only on a fresh insert). No delta — a bounded recent
 * fetch each tick is enough.
 */
async function ingestSentReplies(token, user) {
  let messages;
  try {
    messages = await graph.getRecentSent(token, 25);
  } catch (err) {
    console.warn('[ingest] sent-items fetch failed:', err.message);
    return 0;
  }

  let n = 0;
  for (const msg of messages) {
    if (!msg.providerMsgId || !isReplySubject(msg.subject)) continue; // replies only
    if (await crm.emailExists('outlook', msg.providerMsgId)) continue;

    const activity = await crm.findActivityByThread(user.homeAccountId, msg.threadId);
    const cleanedBody = cleanBody(msg.bodyText || msg.bodyPreview);
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
      body_text: cleanedBody,
      body_raw: msg.bodyHtml || msg.bodyText || msg.bodyPreview,
      received_at: msg.receivedAt,
    });
    if (row) {
      n++;
      await crm.audit({
        actor: 'system',
        action: 'email.ingested',
        entityType: 'email',
        entityId: row.id,
        sourceEmailId: row.id,
        details: { subject: msg.subject, folder: 'sentitems' },
      });
      await extractToNote({ activity, cleanedBody, msg, user });
    }
  }
  return n;
}

/**
 * Resolve which physician an incoming email concerns, most reliable first:
 *  1) the linked activity's physician,
 *  2) the sender (a physician replying from their own address),
 *  3) an entity match on the SUBJECT — briefing/meeting replies carry the
 *     physician name (e.g. "RE: Briefing: Aaron P Baas — …"), so a reply links
 *     even when the sender is the rep themselves.
 * Returns an npi or null.
 */
async function physicianNpiForEmail({ activity, senderPhysician, msg }) {
  if (activity?.physician_npi) return activity.physician_npi;
  if (senderPhysician?.npi) return senderPhysician.npi;
  if (msg.subject) {
    try {
      const analysis = await entityMatcher.analyze(msg.subject);
      const m = analysis.matched_entities.find((x) => x.entity_type === 'person');
      if (m) return m.master_id;
    } catch {
      /* matcher failure → no subject match */
    }
  }
  return null;
}

/**
 * Read one reply with AI and save the extracted points as an AI Meeting Note,
 * so the rep sees the MOM in the UI. Resolves the physician from the activity /
 * sender / subject, and only summarizes REPLIES (or physician-sent mail) so the
 * original briefing/invite self-email isn't summarized. Best-effort: a failure
 * here never breaks ingestion.
 */
async function extractToNote({ activity, cleanedBody, msg, user }) {
  if (!aiExtractor.enabled || !cleanedBody) return;

  const senderPhysician = msg.fromEmail ? physiciansDir.getByEmail(msg.fromEmail) : null;
  // Skip non-replies from the rep (the briefing/invite itself); keep replies and
  // anything a physician sent directly.
  if (!isReplySubject(msg.subject) && !senderPhysician) return;

  const npi = await physicianNpiForEmail({ activity, senderPhysician, msg });
  if (!npi) return;

  try {
    const physician = physiciansDir.getByNpi(npi);
    const insight = await aiExtractor.extractFromReply({
      bodyText: cleanedBody,
      physicianName: physician?.name,
      meetingTitle: activity?.title || msg.subject,
      fromName: msg.fromName,
    });
    if (!insight) return;

    await callNotes.addNote({
      npi,
      organizerEmail: user.email,
      eventId: activity?.calendar_event_id || null,
      meetingDate: activity?.meeting_date || null,
      notes: aiExtractor.formatNote(insight, { receivedAt: msg.receivedAt }),
      source: 'ai',
    });
    await crm.audit({
      actor: 'ai',
      action: 'insight.extracted',
      entityType: 'email',
      entityId: msg.providerMsgId,
      details: { npi, subject: msg.subject },
    });
  } catch (err) {
    console.warn('[ingest] AI extraction failed:', err.message);
  }
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
      const sent = await ingestSentReplies(token, user);
      if (activities || emails || sent) {
        console.log(`[ingest] ${user.email}: ${activities} activities synced, ${emails} inbox + ${sent} sent replies`);
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

module.exports = {
  start, tick, cleanBody, syncActivities, ingestEmails, ingestSentReplies,
  extractToNote, physicianNpiForEmail, isReplySubject, // exported for tests
};
