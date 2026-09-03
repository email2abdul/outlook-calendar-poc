'use strict';

const path = require('path');
const supabase = require('./supabase');

/**
 * outside_physician_app_meeting — who each meeting is with, including the people
 * Supabase has never heard of.
 *
 * Append-only: every answer (the rep's pick, an automatic email match, a name
 * match, a public-registry profile) is a NEW row stamped with the rep it was
 * made for and the moment it was made, and the LATEST row for a meeting is the
 * effective one. That makes "which data, made when, for which rep" answerable
 * and keeps a correction's history instead of erasing it.
 *
 * Same shape as the master: there is a column for every field the app already
 * shows for a BIS physician, so an outside physician renders through the same
 * layout. A field a source could not fill stays NULL, and the renderer prints
 * "Data not available" in its place rather than dropping the row.
 *
 * The EXTRA intelligence a public source can add that BIS has no column for
 * (CMS year-wise CPT volumes, Open Payments, publications, licences) is
 * deliberately NOT stored — it is shown in the pre-meeting notes, tagged as
 * extra. Persisting it is a separate decision to plan.
 *
 * Two interchangeable backends behind one async API, the same convention as
 * src/notes.js:
 *   · Supabase, when the table exists — the real store;
 *   · SQLite (data/outside-physicians.db), when Supabase is absent OR the table
 *     has not been created yet. The fallback exists so the whole flow can be
 *     tested and demoed before anybody runs the setup SQL: a choice still
 *     sticks, it is simply local to this machine.
 */

const TABLE = 'outside_physician_app_meeting';
const MISSING_TABLE = 'MISSING_OUTSIDE_PHYSICIAN_TABLE';

/**
 * The canonical field list — one place, so the SQLite schema, the row mapping
 * and the record mapping can never drift apart. `col` is the database column,
 * `key` the camelCase name the app uses.
 */
const FIELDS = [
  ['owner_user_id', 'ownerUserId', 'text'],
  ['owner_email', 'ownerEmail', 'text'],
  ['calendar_event_id', 'eventId', 'text'],
  ['series_master_id', 'seriesMasterId', 'text'],
  ['meeting_title', 'meetingTitle', 'text'],
  ['meeting_date', 'meetingDate', 'text'],

  ['source', 'source', 'text'],
  ['decided_by', 'decidedBy', 'text'],
  ['confidence', 'confidence', 'int'],
  ['status', 'status', 'text'],
  ['reason', 'reason', 'text'],
  ['candidates', 'candidates', 'json'],
  ['external_source', 'externalSource', 'text'],
  ['external_source_url', 'externalSourceUrl', 'text'],

  // mirror of bis_physicians
  ['npi', 'npi', 'text'],
  ['physician_name', 'name', 'text'],
  ['specialty', 'specialty', 'text'],
  ['email', 'email', 'text'],
  ['phone', 'phone', 'text'],
  ['esd_procedure', 'esdProcedure', 'bool'],
  ['photo_url', 'photoUrl', 'text'],
  ['linkedin_url', 'linkedinUrl', 'text'],

  // mirror of bis_facilities
  ['facility_id', 'facilityId', 'text'],
  ['facility_name', 'facilityName', 'text'],
  ['facility_type', 'facilityType', 'text'],
  ['facility_address', 'facilityAddress', 'text'],
  ['facility_city', 'city', 'text'],
  ['facility_state', 'state', 'text'],
  ['facility_zip', 'zip', 'text'],
  ['health_system', 'healthSystem', 'text'],
  ['territory', 'territory', 'text'],

  // mirror of app_contacts
  ['contact_email', 'contactEmail', 'text'],
  ['contact_mobile', 'contactMobile', 'text'],
  ['contact_linkedin_url', 'contactLinkedinUrl', 'text'],
  ['contact_confidence_score', 'contactConfidenceScore', 'int'],
  ['contact_last_verified', 'contactLastVerified', 'text'],
  ['contact_source', 'contactSource', 'text'],

  // mirror of app_accounts
  ['account_product', 'accountProduct', 'text'],
  ['account_status', 'accountStatus', 'text'],
  ['account_since_date', 'accountSinceDate', 'text'],
  ['account_source', 'accountSource', 'text'],
];

/** Field keys a caller may set — everything except the ones we stamp. */
const STAMPED = new Set(['ownerUserId', 'eventId']);

/** camelCase record → database row. Absent keys stay absent (SQL default/null). */
function toRow(rec) {
  const row = {};
  for (const [col, key, type] of FIELDS) {
    const v = rec[key];
    if (v === undefined) continue;
    if (type === 'json') row[col] = v ?? [];
    else if (type === 'bool') row[col] = v === null ? null : Boolean(v);
    else if (type === 'int') row[col] = Number.isFinite(v) ? v : null;
    else row[col] = v === null || v === '' ? null : String(v);
  }
  return row;
}

/** Database row → the camelCase record the app reads. */
function toRecord(row) {
  if (!row) return null;
  const rec = { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at };
  for (const [col, key, type] of FIELDS) {
    let v = row[col];
    if (type === 'json' && typeof v === 'string') {
      try {
        v = JSON.parse(v);
      } catch {
        v = [];
      }
    }
    if (type === 'bool' && (v === 0 || v === 1)) v = Boolean(v);
    rec[key] = v === undefined ? null : v;
  }
  rec.candidates = rec.candidates || [];
  return rec;
}

// ── Supabase backend ─────────────────────────────────────────────────────────

function isMissingTable(error) {
  return (
    error?.code === 'PGRST205' ||
    error?.code === '42P01' ||
    new RegExp(TABLE).test(error?.message || '')
  );
}

function createSupabaseBackend(client) {
  const fail = (error, what) => {
    if (isMissingTable(error)) {
      const e = new Error(MISSING_TABLE);
      e.detail = error.message;
      return e;
    }
    return new Error(`${what} failed: ${error.message}`);
  };

  return {
    name: 'supabase',
    async insert(row) {
      const { data, error } = await client.from(TABLE).insert(row).select().single();
      if (error) throw fail(error, 'record');
      return toRecord(data);
    },
    async latestForEvents(ownerUserId, ids, perEvent) {
      const { data, error } = await client
        .from(TABLE)
        .select('*')
        .eq('owner_user_id', ownerUserId)
        .in('calendar_event_id', ids)
        .order('created_at', { ascending: false })
        .limit(ids.length * perEvent);
      if (error) throw fail(error, 'latestForEvents');
      return (data || []).map(toRecord);
    },
    async listRecent(ownerUserId, limit) {
      const { data, error } = await client
        .from(TABLE)
        .select('*')
        .eq('owner_user_id', ownerUserId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw fail(error, 'listRecent');
      return (data || []).map(toRecord);
    },
  };
}

// ── SQLite backend (used until the table exists) ─────────────────────────────

const SQL_TYPE = { text: 'TEXT', int: 'INTEGER', bool: 'INTEGER', json: 'TEXT' };

function createSqliteBackend() {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(__dirname, '..', 'data', 'outside-physicians.db'));

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ${FIELDS.map(([col, , type]) => `${col} ${SQL_TYPE[type]}`).join(',\n      ')},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outside_event
      ON ${TABLE} (owner_user_id, calendar_event_id, id DESC);
  `);

  return {
    name: 'sqlite',
    async insert(row) {
      const now = new Date().toISOString();
      const cols = [...Object.keys(row), 'created_at', 'updated_at'];
      const values = cols.map((c) => {
        const v = c === 'created_at' || c === 'updated_at' ? now : row[c];
        if (v === null || v === undefined) return null;
        if (typeof v === 'boolean') return v ? 1 : 0;
        if (typeof v === 'object') return JSON.stringify(v);
        return v;
      });
      const info = db
        .prepare(
          `INSERT INTO ${TABLE} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
        )
        .run(...values);
      return toRecord(db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(info.lastInsertRowid));
    },
    async latestForEvents(ownerUserId, ids, perEvent) {
      const marks = ids.map(() => '?').join(', ');
      return db
        .prepare(
          `SELECT * FROM ${TABLE}
           WHERE owner_user_id = ? AND calendar_event_id IN (${marks})
           ORDER BY id DESC LIMIT ?`
        )
        .all(ownerUserId, ...ids, ids.length * perEvent)
        .map(toRecord);
    },
    async listRecent(ownerUserId, limit) {
      return db
        .prepare(`SELECT * FROM ${TABLE} WHERE owner_user_id = ? ORDER BY id DESC LIMIT ?`)
        .all(ownerUserId, limit)
        .map(toRecord);
    },
  };
}

// ── Backend selection, with a one-way fallback ───────────────────────────────

let backend = null;
let sqlite = null;

function sqliteBackend() {
  if (!sqlite) sqlite = createSqliteBackend();
  return sqlite;
}

function current() {
  if (!backend) backend = supabase ? createSupabaseBackend(supabase) : sqliteBackend();
  return backend;
}

/**
 * Switch to SQLite for the rest of the process.
 *
 * Called the first time Supabase reports the table missing: the setup SQL has
 * not been run yet, and the flow still has to work — a choice must stick so it
 * can be tested. Said once, not once per meeting.
 */
function fallbackToSqlite(detail) {
  if (current().name === 'sqlite') return sqliteBackend();
  console.warn(
    `[outside-physician] ${TABLE} not found in Supabase — ` +
      'keeping decisions in data/outside-physicians.db for now. ' +
      'Run supabase/outside-physician-setup.sql to move them to the project.' +
      (detail ? ` (${detail})` : '')
  );
  backend = sqliteBackend();
  return backend;
}

/** Run one backend call, falling back to SQLite if the table is missing. */
async function run(fn) {
  try {
    return await fn(current());
  } catch (err) {
    if (err.message === MISSING_TABLE) return fn(fallbackToSqlite(err.detail));
    throw err;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Write one answer for a meeting (a decision, or a later top-up).
 *
 * Required: `ownerUserId`, `event` (normalized event) and `source`. Everything
 * else is optional and stays NULL when a source could not supply it — that null
 * is what the renderer turns into "Data not available".
 */
async function record(d) {
  if (!d?.ownerUserId || !d?.event?.id || !d?.source) {
    throw new Error('record needs ownerUserId, event.id and source');
  }

  const rec = { ...d };
  delete rec.event;
  const row = toRow({
    ...rec,
    ownerUserId: d.ownerUserId,
    eventId: String(d.event.id),
    seriesMasterId: d.event.seriesMasterId || null,
    meetingTitle: d.event.title || null,
    meetingDate: d.event.start ? String(d.event.start).slice(0, 10) : null,
    decidedBy: d.decidedBy || 'system',
    candidates: d.candidates || [],
  });

  return run((b) => b.insert(row));
}

/**
 * The effective (latest) record for each meeting, as eventId → record.
 *
 * One query for the whole day view. Rows come back newest-first, so the first
 * one seen per meeting is the effective one — PostgREST has no per-group LIMIT,
 * and a correction history is one or two rows deep in practice.
 */
async function latestForEvents(ownerUserId, eventIds, { perEvent = 6 } = {}) {
  const out = new Map();
  const ids = [...new Set((eventIds || []).filter(Boolean).map(String))];
  if (!ids.length) return out;

  const rows = await run((b) => b.latestForEvents(ownerUserId, ids, perEvent));
  for (const rec of rows) {
    if (!out.has(rec.eventId)) out.set(rec.eventId, rec);
  }
  return out;
}

/** The effective record for one meeting, or null. */
async function latestForEvent(ownerUserId, eventId) {
  if (!eventId) return null;
  return (await latestForEvents(ownerUserId, [eventId], { perEvent: 1 })).get(String(eventId)) || null;
}

/** This rep's recent records, newest first. */
async function listRecent(ownerUserId, limit = 100) {
  return run((b) => b.listRecent(ownerUserId, limit));
}

/**
 * A directory physician → this table's mirror fields.
 *
 * The row is a snapshot of what the master said at the moment of the decision,
 * in the same field names an outside source fills, so both render identically.
 * Anything the master itself does not hold stays null — `esdProcedure` included,
 * where null means "unknown" and false would be a claim.
 */
function mirrorFromPhysician(p) {
  if (!p) return {};
  const f = p.facility || null;
  return {
    npi: p.npi || null,
    name: p.name || null,
    specialty: p.specialty || null,
    email: p.email || null,
    phone: p.phone || null,
    esdProcedure: typeof p.esdProcedure === 'boolean' ? p.esdProcedure : null,
    photoUrl: p.photoUrl || null,
    linkedinUrl: p.linkedinUrl || null,
    facilityId: f?.id || null,
    facilityName: f?.name || null,
    facilityType: f?.type || null,
    facilityAddress: f?.address || null,
    city: f?.city || null,
    state: f?.state || null,
    zip: f?.zip || null,
    healthSystem: f?.healthSystem || null,
    territory: f?.territory || null,
    inBis: true,
  };
}

/**
 * Is this new answer worth a row, or does the latest one already say it?
 *
 * The ingest tick re-reads the calendar every few minutes; without this a
 * meeting that has not changed would grow a row per tick and bury the rows that
 * matter. A row is worth writing when the PERSON, the source or the status
 * changed — and an automatic pass never records over an answer the rep gave by
 * hand, which is decided here rather than in every caller.
 */
function isWorthRecording(latest, next) {
  if (!latest) return true;
  if (latest.decidedBy === 'user' && next.decidedBy !== 'user') return false;
  return (
    (latest.npi || null) !== (next.npi || null) ||
    latest.source !== next.source ||
    (latest.status || null) !== (next.status || null)
  );
}

/** Which backend is in use — 'supabase' or 'sqlite'. For /api/me and support. */
function backendName() {
  return current().name;
}

module.exports = {
  record,
  mirrorFromPhysician,
  latestForEvent,
  latestForEvents,
  listRecent,
  isWorthRecording,
  backendName,
  toRecord,
  toRow,
  FIELDS,
  STAMPED,
  MISSING_TABLE,
  TABLE,
  // Always available now: SQLite stands in until the Supabase table exists.
  enabled: true,
};
