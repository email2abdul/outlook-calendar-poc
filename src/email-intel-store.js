'use strict';

const supabase = require('./supabase');

/**
 * Email Intelligence Sheet store (feature/old-email-read).
 *
 * Reads/writes app_email_intel — one row per physician-related Outlook email,
 * carrying the flat-sheet fields (physician/facility/CPT/other notes, what's new
 * vs bis_*, meeting context, source email). Anon key; every method degrades to a
 * null/empty result when Supabase is unconfigured or the table is absent, so the
 * feature simply shows nothing rather than breaking the app.
 *
 * Keyed by provider_msg_id, so the backfill and the live ingest tick both upsert
 * the same row — re-processing an email updates it in place, never duplicates.
 */

function mapRow(r) {
  if (!r) return null;
  return {
    providerMsgId: r.provider_msg_id,
    ownerUserId: r.owner_user_id || null,
    physicianNpi: r.physician_npi ? String(r.physician_npi) : null,
    physicianName: r.physician_name || null,
    facilityName: r.facility_name || null,
    cptItems: Array.isArray(r.cpt_items) ? r.cpt_items : [],
    otherNotes: Array.isArray(r.other_notes) ? r.other_notes : [],
    newToDb: Array.isArray(r.new_to_db) ? r.new_to_db : [],
    meetingDate: r.meeting_date || null,
    meetingDatetime: r.meeting_datetime || null,
    withWhom: r.with_whom || null,
    emailSubject: r.email_subject || null,
    receivedAt: r.received_at || null,
    extracted: Boolean(r.extracted),
  };
}

/** True if we already have an intel row for this message. */
async function intelExists(providerMsgId) {
  if (!supabase || !providerMsgId) return false;
  try {
    const { data } = await supabase
      .from('app_email_intel')
      .select('provider_msg_id')
      .eq('provider_msg_id', providerMsgId)
      .limit(1);
    return Boolean(data?.[0]);
  } catch {
    return false;
  }
}

/** Upsert one intel row (keyed by provider_msg_id). Throws on error. */
async function upsertIntel(row) {
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase
    .from('app_email_intel')
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'provider_msg_id' });
  if (error) throw new Error(error.message);
}

/** All intel rows for one rep, newest email first (for the sheet UI / export). */
async function listIntel(ownerUserId, limit = 500) {
  if (!supabase || !ownerUserId) return [];
  try {
    const { data, error } = await supabase
      .from('app_email_intel')
      .select('*')
      .eq('owner_user_id', ownerUserId)
      .order('received_at', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error || !data) return [];
    return data.map(mapRow);
  } catch {
    return [];
  }
}

module.exports = {
  intelExists,
  upsertIntel,
  listIntel,
  mapRow,
  enabled: Boolean(supabase),
};
