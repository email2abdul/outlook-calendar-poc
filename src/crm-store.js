'use strict';

const supabase = require('./supabase');

/**
 * Data-access layer for the email-intelligence platform (Phase 0 tables):
 * app_activities (CRM meetings/interactions), app_emails (immutable ingested
 * replies) and app_audit_log (append-only trail). All access goes through the
 * Supabase Data API with the anon key, scoped by owner_user_id in queries.
 *
 * Every method is a no-op-safe null when Supabase isn't configured, so the
 * rest of the app keeps working offline.
 */

function ensure() {
  if (!supabase) throw new Error('Supabase not configured (SUPABASE_URL / SUPABASE_ANON_KEY)');
  return supabase;
}

// ── Audit ────────────────────────────────────────────────────────────────────

/** Append one audit entry. Never throws into the caller — logs and continues. */
async function audit(entry) {
  try {
    await ensure().from('app_audit_log').insert({
      actor: entry.actor || 'system',
      action: entry.action,
      entity_type: entry.entityType || null,
      entity_id: entry.entityId || null,
      source_email_id: entry.sourceEmailId || null,
      details: entry.details || null,
    });
  } catch (err) {
    console.warn('[crm] audit write failed:', err.message);
  }
}

// ── Activities ─────────────────────────────────────────────────────────────

/**
 * Which physician a meeting's row should end up carrying — the one decision the
 * upsert must not get wrong, extracted so it can be tested without a database.
 *
 * Two ways it used to lose data, both on a routine sync:
 *  - the rep picks "Abdul H Khan" from the shortlist, then the next ingest tick
 *    (which matches on attendee EMAIL only, and this meeting has none) upserts
 *    physician_npi = null straight over it;
 *  - a meeting whose physician was resolved once — by the external agent, or at
 *    schedule time — is blanked the moment a later tick cannot re-derive them.
 *
 * So: a REP's confirmed choice outranks anything automatic, and an automatic
 * match never overwrites a known link with nothing.
 *
 * @param {object|null} existing  the app_activities row already stored, if any
 * @param {object} incoming       { physician_npi, facility_id } this sync derived
 * @returns {{physician_npi: string|null, facility_id: string|null}}
 */
function mergeActivityRow(existing, incoming) {
  const chosen = existing && existing.chosen_npi ? String(existing.chosen_npi) : null;
  return {
    physician_npi: chosen || incoming.physician_npi || existing?.physician_npi || null,
    facility_id: incoming.facility_id || existing?.facility_id || null,
  };
}

/**
 * Upsert a CRM activity from a calendar event (idempotent on
 * calendar_event_id). Returns the activity row.
 *
 * Reads the stored row first so mergeActivityRow() can protect a rep's choice
 * (and any physician already linked) from an automatic sync that no longer sees
 * them — pass `{ existing }` when the caller has already read it. Only the
 * columns in `row` are written, so chosen_npi / chosen_by / brief_status set
 * elsewhere survive untouched.
 */
async function upsertActivityFromEvent(ownerUserId, ev, physicianNpi, facilityId, opts = {}) {
  const db = ensure();
  // The ingest tick has already read this row (to tell a new meeting from one
  // it has seen before) and passes it in, so the merge costs no second query.
  let existing = opts.existing !== undefined ? opts.existing : null;
  if (opts.existing === undefined) {
    try {
      existing = ev.id ? await findActivityByEventId(ownerUserId, ev.id) : null;
    } catch (err) {
      // A read failure must not turn into a WRITE that blanks the link.
      console.warn('[crm] activity pre-read failed:', err.message);
      existing = null;
    }
  }
  const merged = mergeActivityRow(existing, {
    physician_npi: physicianNpi || null,
    facility_id: facilityId || null,
  });

  const row = {
    owner_user_id: ownerUserId,
    title: ev.title || null,
    physician_npi: merged.physician_npi,
    facility_id: merged.facility_id,
    calendar_event_id: ev.id,
    // Graph Event objects don't expose conversationId, so meetings carry no
    // email thread id; incoming replies link by physician instead (Phase 1)
    // until the richer matching engine lands (Phase 2).
    thread_id: ev.conversationId || null,
    meeting_date: ev.start ? ev.start.slice(0, 10) : null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await db
    .from('app_activities')
    .upsert(row, { onConflict: 'calendar_event_id' })
    .select()
    .single();
  if (error) throw new Error(`upsertActivity failed: ${error.message}`);
  return data;
}

/**
 * The activity for a specific calendar event — the physician the meeting was
 * actually SCHEDULED with (written at schedule time). Lets the 90-min reminder
 * brief the same physician the auto-brief used, instead of re-guessing from the
 * title.
 */
async function findActivityByEventId(ownerUserId, calendarEventId) {
  if (!calendarEventId) return null;
  const { data } = await ensure()
    .from('app_activities')
    .select('*')
    .eq('owner_user_id', ownerUserId)
    .eq('calendar_event_id', String(calendarEventId))
    .limit(1);
  return data?.[0] || null;
}

/**
 * Every stored activity for a set of calendar events, as eventId → row.
 *
 * The day view needs "has this meeting already been decided?" for a dozen
 * meetings at once; one query with `in (…)` keeps that a single round-trip
 * instead of a dozen.
 */
async function findActivitiesByEventIds(ownerUserId, eventIds) {
  const ids = [...new Set((eventIds || []).filter(Boolean).map(String))];
  const byEventId = new Map();
  if (!ids.length) return byEventId;

  const { data, error } = await ensure()
    .from('app_activities')
    .select('*')
    .eq('owner_user_id', ownerUserId)
    .in('calendar_event_id', ids);
  if (error) throw new Error(`findActivitiesByEventIds failed: ${error.message}`);

  for (const row of data || []) byEventId.set(String(row.calendar_event_id), row);
  return byEventId;
}

/**
 * Record (or clear) the physician the REP confirmed for one meeting.
 *
 * `physician_npi` is written in step with `chosen_npi` on purpose: every
 * existing reader — the reminder brief, reply→note linking, the activity list —
 * already reads physician_npi, so the choice reaches all of them without any of
 * them learning a new column. Clearing (npi = null) drops both, which puts the
 * meeting back on the ladder.
 *
 * Throws MISSING_CHOICE_COLUMNS when supabase/meeting-choice-setup.sql has not
 * been run on this project — the caller turns that into a readable message
 * instead of a 500.
 */
async function setChosenPhysician(ownerUserId, ev, npi, { by = 'user', briefStatus, gateReason } = {}) {
  const db = ensure();
  const clearing = !npi;
  const now = new Date().toISOString();

  const row = {
    owner_user_id: ownerUserId,
    calendar_event_id: ev.id,
    title: ev.title || null,
    meeting_date: ev.start ? ev.start.slice(0, 10) : null,
    chosen_npi: clearing ? null : String(npi),
    chosen_by: clearing ? null : by,
    chosen_at: clearing ? null : now,
    physician_npi: clearing ? null : String(npi),
    brief_status: briefStatus || (clearing ? null : 'briefed'),
    gate_reason: gateReason || null,
    updated_at: now,
  };

  const { data, error } = await db
    .from('app_activities')
    .upsert(row, { onConflict: 'calendar_event_id' })
    .select()
    .single();

  if (error) {
    // PostgREST reports an unknown column as PGRST204 / "column … does not exist".
    if (/chosen_npi|chosen_by|brief_status|gate_reason/.test(error.message)) {
      const e = new Error('MISSING_CHOICE_COLUMNS');
      e.detail = error.message;
      throw e;
    }
    throw new Error(`setChosenPhysician failed: ${error.message}`);
  }
  return data;
}

/** Find an activity by email thread id (for linking replies). */
async function findActivityByThread(ownerUserId, threadId) {
  if (!threadId) return null;
  const { data } = await ensure()
    .from('app_activities')
    .select('*')
    .eq('owner_user_id', ownerUserId)
    .eq('thread_id', threadId)
    .limit(1);
  return data?.[0] || null;
}

/**
 * Most recent activity for a given physician (Phase 1 linking fallback when
 * an event carries no email thread id).
 */
async function findActivityByPhysician(ownerUserId, npi) {
  if (!npi) return null;
  const { data } = await ensure()
    .from('app_activities')
    .select('*')
    .eq('owner_user_id', ownerUserId)
    .eq('physician_npi', String(npi))
    .order('meeting_date', { ascending: false, nullsFirst: false })
    .limit(1);
  return data?.[0] || null;
}

/**
 * The specific meeting a reply is about, matched by SUBJECT. A reply subject
 * embeds the original meeting/briefing title ("RE: ⏰ In 64 min: Meeting with
 * md sufiyan — …"), so we pick the activity whose title is a substring of the
 * subject — the LONGEST match wins, so "Meeting with md sufiyan" beats a shorter
 * coincidental title. This ties the AI note to the exact meeting (eventId),
 * instead of any meeting that happens to share the physician.
 */
async function findActivityBySubject(ownerUserId, subject) {
  const subj = (subject || '').toLowerCase();
  if (!subj) return null;
  const { data } = await ensure()
    .from('app_activities')
    .select('*')
    .eq('owner_user_id', ownerUserId)
    .not('title', 'is', null)
    .limit(300);
  let best = null, bestLen = 0;
  for (const a of data || []) {
    const t = (a.title || '').trim().toLowerCase();
    if (t && subj.includes(t) && t.length > bestLen) {
      best = a;
      bestLen = t.length;
    }
  }
  return best;
}

/** List a user's activities, newest meeting first. */
async function listActivities(ownerUserId, limit = 50) {
  const { data, error } = await ensure()
    .from('app_activities')
    .select('*')
    .eq('owner_user_id', ownerUserId)
    .order('meeting_date', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw new Error(`listActivities failed: ${error.message}`);
  return data || [];
}

// ── Emails ───────────────────────────────────────────────────────────────────

/** True if we've already ingested this provider message. */
async function emailExists(provider, providerMsgId) {
  const { data } = await ensure()
    .from('app_emails')
    .select('id')
    .eq('provider', provider)
    .eq('provider_msg_id', providerMsgId)
    .limit(1);
  return Boolean(data?.[0]);
}

/**
 * Insert a normalized email and RETURN the new row (callers extract from it on a
 * fresh insert). Callers dedup via emailExists() first, so this is a plain
 * insert; a concurrent duplicate trips the unique constraint (23505) and we
 * return null so the loser skips re-processing. (Was an upsert with
 * ignoreDuplicates, which silently returned null even for new rows — so
 * downstream extraction never ran.)
 */
async function insertEmail(email) {
  const { data, error } = await ensure().from('app_emails').insert(email).select();
  if (error) {
    if (error.code === '23505') return null; // already ingested (race)
    throw new Error(`insertEmail failed: ${error.message}`);
  }
  return data?.[0] || null;
}

/** All ingested emails for one activity's thread, oldest first. */
async function listEmailsForThread(ownerUserId, threadId, limit = 50) {
  if (!threadId) return [];
  const { data } = await ensure()
    .from('app_emails')
    .select('*')
    .eq('owner_user_id', ownerUserId)
    .eq('thread_id', threadId)
    .order('received_at', { ascending: true })
    .limit(limit);
  return data || [];
}

module.exports = {
  audit,
  upsertActivityFromEvent,
  mergeActivityRow,
  findActivitiesByEventIds,
  setChosenPhysician,
  findActivityByThread,
  findActivityByPhysician,
  findActivityBySubject,
  findActivityByEventId,
  listActivities,
  emailExists,
  insertEmail,
  listEmailsForThread,
  enabled: Boolean(supabase),
};
