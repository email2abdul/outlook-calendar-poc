'use strict';

const auth = require('./auth');
const graph = require('./graph');
const physiciansDir = require('./physicians');
const entityMatcher = require('./entity-matcher');
const context = require('./enrichment/context');
const enrichment = require('./enrichment');
const verify = require('./enrichment/verify');
const tokenStore = require('./token-store');
const crm = require('./crm-store');
const callNotes = require('./notes');
const analytics = require('./analytics');
const contactsStore = require('./contacts-store');
const aiExtractor = require('./ai-extractor');
const emailIntel = require('./email-intel');
const intelStore = require('./email-intel-store');

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
const INTEL_RECONCILE_DAYS = Number(process.env.INTEL_RECONCILE_DAYS) || 3;

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

/**
 * Every physician an event is with, deduped by NPI: the ATTENDEES whose email
 * is an EXACT match in the directory (so a meeting with two physician emails
 * yields two). Empty array when it's not a physician meeting.
 *
 * Identity comes from the attendee's email address and nothing else. The
 * organizer — the rep who scheduled the meeting — is never matched, and the
 * title/description are never used to guess WHO the meeting is with: this
 * function triggers the automatic brief email and the meeting-body injection,
 * so a guess here mails the wrong person's data. The title still supplies
 * facility context elsewhere (src/enrichment/context.js).
 */
async function physiciansForEvent(ev, selfEmail) {
  const found = new Map();
  for (const a of context.attendeesToEnrich(ev, { selfEmail })) {
    const p = physiciansDir.getByEmail(a.email);
    if (p) found.set(p.npi, p);
  }
  return [...found.values()];
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
    const physicians = await physiciansForEvent(ev, user.email);
    // The activity row links to a single physician (schema is one NPI per
    // activity); use the first. All matched physicians are still briefed below.
    const primary = physicians[0] || null;

    // Was this meeting already known? (Checked BEFORE the upsert so we only
    // instant-brief a genuinely new physician meeting — e.g. one just created
    // directly in Outlook — not every meeting on every poll.)
    const existed = ev.id
      ? await crm.findActivityByEventId(user.homeAccountId, ev.id)
      : null;

    const activity = await crm.upsertActivityFromEvent(
      user.homeAccountId,
      ev,
      primary?.npi,
      primary?.facility?.id
    );
    if (activity) synced++;

    // Instant-brief the matched physician(s) in ONE email (a two-physician
    // meeting → a single brief with both), only the first time it's seen.
    if (physicians.length && !existed) {
      try {
        await sendInstantBrief(token, user, ev, physicians);
      } catch (err) {
        console.warn('[ingest] instant brief failed:', err.message);
      }
    }

    // Nobody on the meeting is in BIS — the case that used to end here in
    // silence. Look the attendees (or the names in the title) up outside the
    // master instead. Not gated on `existed`: meetings that predate this
    // feature deserve it too, and briefUnknownAttendees has its own
    // `enrich:<series-or-event>` key, so it still runs exactly once per
    // meeting — and exactly once per recurring SERIES, not once per occurrence.
    if (!physicians.length) {
      try {
        const recovered = await briefUnknownAttendees(token, user, ev);
        // An attendee the agent found IS in BIS after all (their email was
        // simply missing from the master): link and brief them normally.
        if (recovered.length) {
          const primary = recovered[0];
          await crm.upsertActivityFromEvent(user.homeAccountId, ev, primary.npi, primary.facility?.id);
          await sendInstantBrief(token, user, ev, recovered);
          // Same brief onto the event itself — a physician found by name/NPI
          // deserves the in-meeting notes an email-matched one already gets.
          await enrichEventBody(token, user, ev, recovered);
        }
      } catch (err) {
        console.warn('[ingest] enrichment brief failed:', err.message);
      }
    }

    // Embed the brief INTO the meeting body so it shows inside the event in
    // Outlook. Runs for every physician meeting (not just new ones) so meetings
    // that predate this feature get enriched too; the enrich key + body marker
    // keep it to exactly once.
    if (physicians.length) {
      try {
        await enrichEventBody(token, user, ev, physicians);
      } catch (err) {
        console.warn('[ingest] enrich meeting body failed:', err.message);
      }
    }
  }
  return synced;
}

/**
 * Embed the pre-meeting brief into the meeting's own Outlook body — the same
 * brief the emails carry (buildBriefingContent), so opening the event shows it
 * inline with no add-in. Guarded by an `enriched:<eventId>` key (skip the Graph
 * round-trip on later ticks) plus a body marker inside injectBriefIntoEvent, so
 * it injects exactly once and never notifies attendees.
 */
async function enrichEventBody(token, user, ev, physicians) {
  if (!ev.id || !physicians.length) return;
  const key = `enriched:${ev.id}`;
  if (await tokenStore.wasReminderSent(user.homeAccountId, key)) return;

  const bundles = [];
  for (const physician of physicians) {
    bundles.push({
      physician,
      notes: await callNotes.getNotes(physician.npi, user.email),
      analytics: await analytics.getLabelledAnalytics(physician.npi),
      contact: await contactsStore.getContact(physician.npi),
      verification: await verify.verifyPhysician(physician),
    });
  }
  const content = graph.buildBriefingContent({
    physicians: bundles,
    event: { title: ev.title, start: ev.start, timeZone: ev.timeZone },
    intro: 'Auto-added BIS pre-meeting brief for this meeting:',
  });

  const injected = await graph.injectBriefIntoEvent(token, ev.id, content);
  await tokenStore.markReminderSent(user.homeAccountId, key);
  if (injected) {
    const names = physicians.map((p) => p.name || `NPI ${p.npi}`).join(', ');
    console.log(`[ingest] brief embedded in meeting "${ev.title}" (${names})`);
  }
}

/**
 * Embed a brief for someone OUTSIDE the master into the meeting body.
 *
 * The counterpart to enrichEventBody for the enrichment path: same idempotency
 * key, so a meeting gets one injected brief and never two, and the same
 * provenance-tagged HTML the external email carries — every field labelled with
 * the registry it came from, since none of it is BIS-verified.
 */
async function injectExternalBrief(token, user, ev, enrichments) {
  const key = `enriched:${ev.id}`;
  if (await tokenStore.wasReminderSent(user.homeAccountId, key)) return;

  const names = enrichments.map(
    (r) => r.profile?.fields?.name?.value || r.query?.name || r.query?.email || 'unknown contact'
  );
  const content = [
    `<p>${'Auto-added BIS pre-meeting notes. '}` +
      `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} NOT in the BIS master — ` +
      'the profile below was assembled from public registries, each field labelled ' +
      'with its source.</p>',
    ...enrichments.map((r) => graph.externalBriefHtml(r)),
  ].join('');

  const injected = await graph.injectBriefIntoEvent(token, ev.id, content);
  await tokenStore.markReminderSent(user.homeAccountId, key);
  if (injected) {
    console.log(`[ingest] external brief embedded in meeting "${ev.title}" (${names.join(', ')})`);
  }
}

/**
 * Instant pre-meeting brief — sent the first time a physician meeting is seen
 * (e.g. created directly in Outlook, which never hits the app's schedule route).
 * The same brief body the schedule/reminder emails use, so all three match.
 * Deduped on a distinct `instant:…` key so it fires independently of the timed
 * reminder and never repeats. All physicians on the meeting go into one email
 * (a section each).
 *
 * Keyed on the SERIES for a recurring meeting, for the same reason enrichment
 * is: calendarView hands us one event per occurrence, each with its own id and
 * (on a first sync) no activity row yet, so an occurrence-keyed instant brief
 * mailed the rep ~29 identical "🆕 New meeting" briefs for one weekly meeting.
 * The physicians are folded into the key, so an occurrence edited to be with a
 * different doctor is still briefed. A non-recurring meeting keeps its
 * `instant:<eventId>` key exactly as before.
 */
async function sendInstantBrief(token, user, ev, physicians) {
  if (!user.email || !ev.id || !physicians.length) return;
  const key = `instant:${context.seriesKey(ev, physicians)}`;
  if (await tokenStore.wasReminderSent(user.homeAccountId, key)) return;

  const bundles = [];
  for (const physician of physicians) {
    bundles.push({
      physician,
      notes: await callNotes.getNotes(physician.npi, user.email),
      analytics: await analytics.getLabelledAnalytics(physician.npi),
      contact: await contactsStore.getContact(physician.npi),
      verification: await verify.verifyPhysician(physician),
    });
  }
  const names = physicians.map((p) => p.name || `NPI ${p.npi}`).join(', ');

  await graph.sendPhysiciansBriefing(token, {
    toEmail: user.email,
    physicians: bundles,
    event: { title: ev.title, start: ev.start, timeZone: ev.timeZone },
    subject: `🆕 New meeting: ${ev.title} — ${names}`,
    intro:
      `A meeting "${ev.title}" with ${names} was just added to your calendar. ` +
      (physicians.length > 1 ? 'Their pre-meeting briefs are below.' : 'Your pre-meeting brief is below.'),
  });
  await tokenStore.markReminderSent(user.homeAccountId, key);
  console.log(`[ingest] instant brief sent to ${user.email} — "${ev.title}" (${names})`);
}

/**
 * Look up the attendees of a meeting that matched nobody in BIS.
 *
 * This is the gap the enrichment agent exists to close: before, a meeting whose
 * attendees were not in bis_physicians produced no activity link, no brief and
 * no meeting-body injection — the rep walked in with nothing.
 *
 * Two outcomes are worth acting on:
 *   - `recovered_in_bis` — the physician IS in the master, their email just
 *     wasn't. Returned to the caller so the meeting is linked and briefed
 *     through the normal path.
 *   - `external` — genuinely outside BIS; the rep gets the provenance-tagged
 *     brief by email instead.
 *
 * Runs once per meeting (dedup key), never for the organizer, and only for
 * meetings we have not seen before, so a poll every five minutes cannot spend
 * repeatedly on the same event.
 *
 * @returns {Promise<object[]>} BIS physicians recovered by NPI (usually empty)
 */
async function briefUnknownAttendees(token, user, ev) {
  if (!ev.id) return [];

  // Who to look up: attendees when the meeting has any, otherwise the people
  // NAMED in the title. A meeting typed straight into Outlook ("meeting with dr
  // Geoffrey Aaron") carries no attendee at all, and used to produce nothing —
  // no brief, no notes, nothing on the event.
  const attendees = context.attendeesToEnrich(ev, { selfEmail: user.email });
  const subjects = attendees.length
    ? attendees.map((a) => ({ email: a.email, name: a.name || null, via: 'attendee' }))
    : context
        .namesFromEvent(ev, { selfEmail: user.email })
        .map((p) => ({ email: null, name: p.name, via: 'meeting title' }));
  if (!subjects.length) return [];

  // Keyed on the SERIES, not the occurrence: calendarView expands a recurring
  // meeting into one event per occurrence, so `enrich:<occurrenceId>` bought a
  // full lookup ~29 times over the 30-day window for one weekly meeting with
  // one person. Falls back to the event id for a non-recurring meeting, so
  // one-off meetings — and keys already written — behave exactly as before.
  const key = `enrich:${context.seriesKey(ev, subjects)}`;
  if (await tokenStore.wasReminderSent(user.homeAccountId, key)) return [];
  await tokenStore.markReminderSent(user.homeAccountId, key);

  const meetingContext = [ev.title, ev.description].filter(Boolean).join('. ').slice(0, 500);
  // Facility / city / state the title mentions — a name alone matches many
  // providers in NPPES, and geography is what separates them.
  let hints = {};
  try {
    hints = await context.hintsFromEvent(ev, { selfEmail: user.email });
  } catch {
    /* context is a bonus, never a blocker */
  }

  const recovered = [];
  const external = [];

  for (const subject of subjects) {
    const result = await enrichment.enrich({
      email: subject.email || undefined,
      name: subject.email ? undefined : subject.name,
      state: hints.state || undefined,
      city: hints.city || undefined,
      facilityName: hints.facilityName || hints.mentionedFacilities?.[0] || undefined,
      meetingContext,
    });

    if (result.status === 'recovered_in_bis' && result.physician) {
      recovered.push(result.physician);
    } else if (result.status === 'external') {
      external.push(result);
    } else if (subject.via === 'meeting title') {
      console.log(
        `[ingest] title name "${subject.name}" on "${ev.title}" → ${result.status} ` +
          `(confidence ${result.confidence}) — not briefed`
      );
    }
  }

  if (external.length && user.email) {
    const to = await graph.sendExternalBriefing(token, {
      toEmail: user.email,
      enrichments: external,
      event: { title: ev.title, start: ev.start, timeZone: ev.timeZone },
    });
    console.log(
      `[ingest] external brief sent to ${to} — "${ev.title}" ` +
        `(${external.length} ${subjects[0].via}(s) outside BIS)`
    );

    // …and put the same brief ON the meeting, so the rep opening the event in
    // Outlook has the pre-meeting notes there rather than in a separate mail.
    try {
      await injectExternalBrief(token, user, ev, external);
    } catch (err) {
      console.warn('[ingest] external brief injection failed:', err.message);
    }
  }

  return recovered;
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

    // Email Intelligence sheet: upsert a structured row for this new inbox
    // email (physician/facility/CPT + what's new vs bis_*), so the sheet keeps
    // growing as mail arrives. Best-effort — never breaks ingestion.
    try {
      await emailIntel.processMessage({ msg, user, cleanedBody });
    } catch (err) {
      console.warn('[ingest] intel-sheet upsert failed:', err.message);
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
 * Self-heal the Email Intelligence sheet.
 *
 * The live tick only attempts an intel row when an email is FIRST ingested
 * (intel runs inside ingestEmails, on the new inbox-delta message). The delta
 * cursor never resurfaces that message again, so if the intel attempt failed
 * transiently — Supabase/AI blip, or the upsert simply never landed — the email
 * stays permanently absent from the sheet, even though it sits in app_emails.
 *
 * This pass closes that gap: each tick we re-scan the recent inbox window and
 * (re)process any message that still has NO intel row. Bounded to
 * INTEL_RECONCILE_DAYS (default 3) so it can't grind the whole archive every
 * poll. Cost is low: existing rows are loaded once and checked in-memory, and
 * non-physician mail is re-evaluated cheaply because buildRow short-circuits
 * (returns null) before the Claude enrichment pass ever runs. Once a row exists
 * the message is skipped forever, so this converges. Best-effort.
 *
 * NOTE: only heals MISSING rows. A row that saved but with extracted=false
 * (AI was disabled/failed at the time) is treated as done and not re-enriched —
 * re-running AI over partial rows is a separate concern (use the backfill).
 */
async function reconcileIntel(token, user, { sinceDays = INTEL_RECONCILE_DAYS } = {}) {
  if (!intelStore.enabled) return 0;

  let messages;
  try {
    messages = await graph.getInboxMessages(token, { sinceDays });
  } catch (err) {
    console.warn('[ingest] intel reconcile fetch failed:', err.message);
    return 0;
  }
  if (!messages.length) return 0;

  // Load the rep's existing intel rows once and check membership in-memory,
  // rather than one existence query per message.
  let have;
  try {
    const rows = await intelStore.listIntel(user.homeAccountId, 500);
    have = new Set(rows.map((r) => r.providerMsgId).filter(Boolean));
  } catch (err) {
    console.warn('[ingest] intel reconcile list failed:', err.message);
    return 0;
  }

  let healed = 0;
  for (const msg of messages) {
    if (!msg.providerMsgId || have.has(msg.providerMsgId)) continue;
    try {
      const cleanedBody = cleanBody(msg.bodyText || msg.bodyPreview);
      const r = await emailIntel.processMessage({ msg, user, cleanedBody });
      if (r === 'saved') healed++;
    } catch (err) {
      console.warn('[ingest] intel reconcile failed:', err.message);
    }
  }
  return healed;
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

  // Tie the note to the SPECIFIC meeting this reply is about (so its eventId is
  // set and the UI can scope it to that meeting) — already-linked activity,
  // else the activity whose title the reply subject embeds.
  const meeting = activity || (await crm.findActivityBySubject(user.homeAccountId, msg.subject));

  // Physician: the meeting's, else the sender, else a subject entity-match.
  const npi =
    meeting?.physician_npi ||
    senderPhysician?.npi ||
    (await physicianNpiForEmail({ activity: null, senderPhysician: null, msg }));
  if (!npi) return;

  try {
    const physician = physiciansDir.getByNpi(npi);
    const insight = await aiExtractor.extractFromReply({
      bodyText: cleanedBody,
      physicianName: physician?.name,
      meetingTitle: meeting?.title || msg.subject,
      fromName: msg.fromName,
    });
    if (!insight) return;

    await callNotes.addNote({
      npi,
      organizerEmail: user.email,
      eventId: meeting?.calendar_event_id || null,
      meetingDate: meeting?.meeting_date || null,
      notes: aiExtractor.formatNote(insight, {
        receivedAt: msg.receivedAt,
        meetingTitle: meeting?.title,
      }),
      source: 'ai',
    });
    await crm.audit({
      actor: 'ai',
      action: 'insight.extracted',
      entityType: 'email',
      entityId: msg.providerMsgId,
      details: { npi, eventId: meeting?.calendar_event_id || null, subject: msg.subject },
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
      const healed = await reconcileIntel(token, user);
      if (activities || emails || sent || healed) {
        console.log(`[ingest] ${user.email}: ${activities} activities synced, ${emails} inbox + ${sent} sent replies, ${healed} intel rows healed`);
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
  reconcileIntel, extractToNote, physicianNpiForEmail, isReplySubject, // exported for tests
  briefUnknownAttendees,
};
