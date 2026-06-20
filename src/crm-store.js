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
 * Upsert a CRM activity from a calendar event (idempotent on
 * calendar_event_id). Returns the activity row.
 */
async function upsertActivityFromEvent(ownerUserId, ev, physicianNpi, facilityId) {
  const db = ensure();
  const row = {
    owner_user_id: ownerUserId,
    title: ev.title || null,
    physician_npi: physicianNpi || null,
    facility_id: facilityId || null,
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
  findActivityByThread,
  findActivityByPhysician,
  listActivities,
  emailExists,
  insertEmail,
  listEmailsForThread,
  enabled: Boolean(supabase),
};
