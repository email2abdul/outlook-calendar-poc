'use strict';

const supabase = require('./supabase');

/**
 * app_meeting_physician — who each meeting is with, and what we know about them
 * that Supabase does not already hold.
 *
 * Append-only: a decision is never edited in place. Every answer — the rep's
 * pick, an automatic email match, a name match, a registry profile — is a NEW
 * row stamped with the rep it was made for and the moment it was made, and the
 * LATEST row for a meeting is the effective one. That is what makes "which
 * data, made when, for which rep" answerable, keeps the correction history
 * ("picked A on Monday, changed to B on Tuesday"), and makes newest-first the
 * natural read order everywhere.
 *
 * Rows are expected to be incomplete. A physician found by name has no NPI yet;
 * one found in NPPES has no CPT volumes until CMS answers. What is known goes in
 * the columns, everything else into `profile` (JSONB, provenance-tagged), and
 * the names of fields we know are missing go into `data_missing` so a brief can
 * print "Data is not available" in the same layout rather than quietly changing
 * shape. A later pass tops the same meeting up with another row.
 *
 * Degrades like every other store here: no Supabase → `enabled` is false and
 * every call is a null/no-op, never a crash.
 */

const TABLE = 'app_meeting_physician';

/** Thrown when the table has not been created yet, so callers can say so. */
const MISSING_TABLE = 'MISSING_MEETING_PHYSICIAN_TABLE';

function ensure() {
  if (!supabase) throw new Error('Supabase not configured');
  return supabase;
}

/** PostgREST's way of saying "no such table/column". */
function isMissingTable(error) {
  return (
    error?.code === 'PGRST205' ||
    error?.code === '42P01' ||
    /app_meeting_physician/.test(error?.message || '')
  );
}

function wrap(error, what) {
  if (isMissingTable(error)) {
    const e = new Error(MISSING_TABLE);
    e.detail = error.message;
    return e;
  }
  return new Error(`${what} failed: ${error.message}`);
}

/** DB row → the shape the rest of the app reads. */
function toRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ownerEmail: row.owner_email || null,
    eventId: row.calendar_event_id,
    seriesMasterId: row.series_master_id || null,
    meetingTitle: row.meeting_title || null,
    meetingDate: row.meeting_date || null,
    npi: row.npi || null,
    name: row.physician_name || null,
    specialty: row.specialty || null,
    facilityName: row.facility_name || null,
    city: row.city || null,
    state: row.state || null,
    inBis: Boolean(row.in_bis),
    source: row.source,
    decidedBy: row.decided_by || null,
    confidence: row.confidence ?? null,
    status: row.status || null,
    reason: row.reason || null,
    profile: row.profile || {},
    candidates: row.candidates || [],
    dataMissing: row.data_missing || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Write one decision (or one top-up) for a meeting.
 *
 * @param {object} d
 * @param {string} d.ownerUserId          the rep this row is for (required)
 * @param {string} [d.ownerEmail]
 * @param {object} d.event                normalized event (src/graph.js)
 * @param {string} [d.npi]
 * @param {string} [d.name]
 * @param {string} [d.specialty]
 * @param {string} [d.facilityName]
 * @param {string} [d.city]
 * @param {string} [d.state]
 * @param {boolean} [d.inBis]
 * @param {string} d.source               email | name | user | nppes | cms | agent
 * @param {'user'|'system'} [d.decidedBy]
 * @param {number} [d.confidence]
 * @param {string} [d.status]
 * @param {string} [d.reason]
 * @param {object} [d.profile]            provenance-tagged fields from outside BIS
 * @param {object[]} [d.candidates]       the shortlist that was shown
 * @param {string[]} [d.dataMissing]      fields known to be absent
 * @returns {Promise<object|null>} the stored record
 */
async function record(d) {
  if (!supabase) return null;
  if (!d?.ownerUserId || !d?.event?.id || !d?.source) {
    throw new Error('record needs ownerUserId, event.id and source');
  }

  const row = {
    owner_user_id: d.ownerUserId,
    owner_email: d.ownerEmail || null,
    calendar_event_id: String(d.event.id),
    series_master_id: d.event.seriesMasterId || null,
    meeting_title: d.event.title || null,
    meeting_date: d.event.start ? String(d.event.start).slice(0, 10) : null,
    npi: d.npi ? String(d.npi) : null,
    physician_name: d.name || null,
    specialty: d.specialty || null,
    facility_name: d.facilityName || null,
    city: d.city || null,
    state: d.state || null,
    in_bis: Boolean(d.inBis),
    source: d.source,
    decided_by: d.decidedBy || 'system',
    confidence: Number.isFinite(d.confidence) ? d.confidence : null,
    status: d.status || null,
    reason: d.reason || null,
    profile: d.profile || {},
    candidates: d.candidates || [],
    data_missing: d.dataMissing || [],
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await ensure().from(TABLE).insert(row).select().single();
  if (error) throw wrap(error, 'record');
  return toRecord(data);
}

/**
 * The effective (latest) record for each of these meetings.
 *
 * One query for the whole day view — PostgREST has no per-group LIMIT, so the
 * rows come back newest-first and the first one seen per meeting wins. Bounded
 * by `perEvent` rows per meeting on average, which is what a correction history
 * looks like in practice (one or two).
 *
 * @returns {Promise<Map<string, object>>} eventId → record
 */
async function latestForEvents(ownerUserId, eventIds, { perEvent = 6 } = {}) {
  const out = new Map();
  if (!supabase) return out;

  const ids = [...new Set((eventIds || []).filter(Boolean).map(String))];
  if (!ids.length) return out;

  const { data, error } = await ensure()
    .from(TABLE)
    .select('*')
    .eq('owner_user_id', ownerUserId)
    .in('calendar_event_id', ids)
    .order('created_at', { ascending: false })
    .limit(ids.length * perEvent);
  if (error) throw wrap(error, 'latestForEvents');

  for (const row of data || []) {
    const key = String(row.calendar_event_id);
    if (!out.has(key)) out.set(key, toRecord(row)); // newest-first → first wins
  }
  return out;
}

/** The effective record for one meeting, or null. */
async function latestForEvent(ownerUserId, eventId) {
  if (!supabase || !eventId) return null;
  const { data, error } = await ensure()
    .from(TABLE)
    .select('*')
    .eq('owner_user_id', ownerUserId)
    .eq('calendar_event_id', String(eventId))
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw wrap(error, 'latestForEvent');
  return toRecord(data?.[0]);
}

/** This rep's recent decisions, newest first. */
async function listRecent(ownerUserId, limit = 100) {
  if (!supabase) return [];
  const { data, error } = await ensure()
    .from(TABLE)
    .select('*')
    .eq('owner_user_id', ownerUserId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw wrap(error, 'listRecent');
  return (data || []).map(toRecord);
}

/**
 * Is this new answer worth a row, or does the latest one already say it?
 *
 * The ingest tick re-reads the calendar every few minutes; without this, a
 * meeting that has not changed would grow a row per tick and bury the actual
 * history. A row is worth writing when the PERSON, the source or the status
 * changed — and a rep's own decision is never overwritten by an automatic one
 * that disagrees, which is decided here rather than in every caller.
 *
 * @param {object|null} latest  the effective record, if any
 * @param {object} next         { npi, source, status }
 * @returns {boolean}
 */
function isWorthRecording(latest, next) {
  if (!latest) return true;
  // A person's own choice stands until they change it themselves.
  if (latest.decidedBy === 'user' && next.decidedBy !== 'user') return false;
  return (
    (latest.npi || null) !== (next.npi || null) ||
    latest.source !== next.source ||
    (latest.status || null) !== (next.status || null)
  );
}

module.exports = {
  record,
  latestForEvent,
  latestForEvents,
  listRecent,
  isWorthRecording,
  toRecord,
  MISSING_TABLE,
  TABLE,
  enabled: Boolean(supabase),
};
