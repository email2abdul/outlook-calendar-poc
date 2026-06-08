'use strict';

const fs = require('fs');
const path = require('path');
const supabase = require('./supabase');

/**
 * Physician directory — loads physicians + facilities into memory once at
 * startup and exposes search/lookup helpers. ~21k physicians ≈ a few MB,
 * which is fine to keep in RAM for this POC.
 *
 * Source of truth: Supabase (bis_physicians / bis_facilities via the
 * bis_directory() SQL function) when SUPABASE_URL is configured; otherwise
 * the bundled CSVs. `ready` resolves once the directory is loaded — the
 * server gates requests on it.
 */

const DATA_DIR = path.join(__dirname, '..', 'data');
const PHYSICIAN_CSV = path.join(DATA_DIR, 'physician_output_upload.csv');
const FACILITY_CSV = path.join(DATA_DIR, 'facility_output_upload.csv');

/**
 * Minimal RFC-4180 CSV parser (handles quoted fields, embedded commas,
 * escaped quotes and CRLF). Returns an array of objects keyed by header row.
 */
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  // Trailing row without a final newline.
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }

  const [header, ...records] = rows;
  return records.map((r) => {
    const obj = {};
    header.forEach((key, idx) => {
      obj[key] = (r[idx] ?? '').trim();
    });
    return obj;
  });
}

/** Normalise empty values to null so the API shape is predictable. */
function nullable(value) {
  return value !== undefined && value !== null && value !== '' ? value : null;
}

// ── In-memory indexes (filled by one of the loaders below) ──────────────────

let physicians = [];
let physiciansByNpi = new Map();
let physiciansByEmail = new Map();
let facilitiesById = new Map();

/**
 * Build all indexes from loader-agnostic rows.
 * physicianRows: { npi, name, specialty, email, phone, esdProcedure,
 *                  photoUrl, linkedinUrl, primaryFacilityId }
 * facilityRows:  { id, name, type, address, city, state, zip }
 */
function buildIndexes(physicianRows, facilityRows) {
  facilitiesById = new Map(
    facilityRows.map((f) => [
      String(f.id),
      {
        id: String(f.id),
        name: nullable(f.name),
        type: nullable(f.type),
        address: nullable(f.address),
        city: nullable(f.city),
        state: nullable(f.state),
        zip: f.zip !== undefined && f.zip !== null && f.zip !== '' ? String(f.zip) : null,
      },
    ])
  );

  physicians = physicianRows.map((p) => ({
    npi: String(p.npi),
    name: nullable(p.name),
    specialty: nullable(p.specialty),
    email: nullable(p.email),
    phone: p.phone !== undefined && p.phone !== null && p.phone !== '' ? String(p.phone) : null,
    esdProcedure: Boolean(p.esdProcedure),
    photoUrl: nullable(p.photoUrl),
    linkedinUrl: nullable(p.linkedinUrl),
    facility: facilitiesById.get(String(p.primaryFacilityId)) || null,
  }));

  physiciansByNpi = new Map(physicians.map((p) => [p.npi, p]));
  physiciansByEmail = new Map();
  for (const p of physicians) {
    if (p.email) physiciansByEmail.set(p.email.toLowerCase(), p);
  }
}

// ── Loaders ──────────────────────────────────────────────────────────────────

async function loadFromSupabase() {
  const { data, error } = await supabase.rpc('bis_directory');
  if (error) throw new Error(error.message);

  buildIndexes(data.physicians, data.facilities);
  console.log(
    `[physicians] loaded ${physicians.length} physicians, ${facilitiesById.size} facilities from Supabase`
  );
}

function loadFromCsv() {
  // The bundled CSVs were removed once Supabase became the source of truth;
  // this fallback now only fires if Supabase is unconfigured/unreachable AND
  // the CSVs happen to be present. Degrade to an empty directory otherwise so
  // the server still boots.
  if (!fs.existsSync(PHYSICIAN_CSV) || !fs.existsSync(FACILITY_CSV)) {
    buildIndexes([], []);
    console.warn('[physicians] no Supabase and no CSV files — directory empty');
    return;
  }

  const facilityRows = parseCsv(fs.readFileSync(FACILITY_CSV, 'utf8')).map((f) => ({
    id: f.facility_id,
    name: f.facility_name,
    type: f.facility_type,
    address: f.address,
    city: f.city,
    state: f.state,
    zip: f.zip,
  }));

  const physicianRows = parseCsv(fs.readFileSync(PHYSICIAN_CSV, 'utf8')).map((p) => ({
    npi: p.physician_npi,
    name: p.physician_name,
    specialty: p.specialty,
    email: p.email,
    phone: p.phone,
    esdProcedure: p.esd_procedure === 'Yes',
    photoUrl: p.photo_url,
    linkedinUrl: p.linkedin_url,
    primaryFacilityId: p.primary_facility_id,
  }));

  buildIndexes(physicianRows, facilityRows);
  console.log(
    `[physicians] loaded ${physicians.length} physicians, ${facilitiesById.size} facilities from CSV`
  );
}

/** Resolves when the directory is loaded; the server gates requests on this. */
let ready;
if (supabase) {
  ready = loadFromSupabase().catch((err) => {
    console.error(`[physicians] Supabase load failed (${err.message}) — falling back to CSV`);
    loadFromCsv();
  });
} else {
  loadFromCsv();
  ready = Promise.resolve();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Search physicians by free text — matches name, NPI, email, specialty,
 * facility name or facility city. Best matches first (ranked in Supabase by
 * the bis_search_physicians function: exact email/NPI > name > email >
 * facility > city > specialty); physicians with an email sort ahead — they're
 * the ones we can actually invite. Several physicians matching the same name
 * all come back, so the user picks who they're actually meeting.
 * @param {string} query
 * @param {number} [limit=20]
 */
async function search(query, limit = 20) {
  const q = String(query || '').trim();
  if (!q) return [];

  if (supabase) {
    const { data, error } = await supabase.rpc('bis_search_physicians', {
      p_query: q,
      p_limit: limit,
    });
    if (error) throw new Error(`search RPC failed: ${error.message}`);
    // No physician hits, but the query names a facility we know? It's an
    // unlinked (orphan) facility — offer same-city physicians instead.
    if (data.length === 0) {
      const ql = q.toLowerCase();
      const fac = [...facilitiesById.values()].find(
        (f) => f.name && f.name.toLowerCase().includes(ql)
      );
      if (fac) return getNearbyForFacility(fac, limit);
    }
    return data.map((p) => ({
      npi: String(p.npi),
      name: nullable(p.name),
      specialty: nullable(p.specialty),
      email: nullable(p.email),
      phone: p.phone !== undefined && p.phone !== null && p.phone !== '' ? String(p.phone) : null,
      esdProcedure: Boolean(p.esdProcedure),
      photoUrl: nullable(p.photoUrl),
      linkedinUrl: nullable(p.linkedinUrl),
      facility: p.facility
        ? {
            ...p.facility,
            id: String(p.facility.id),
            zip: p.facility.zip !== undefined && p.facility.zip !== null ? String(p.facility.zip) : null,
          }
        : null,
    }));
  }

  // Local fallback: filter the in-memory index (also matches facility).
  const ql = q.toLowerCase();
  const matches = [];
  for (const p of physicians) {
    if (
      (p.name && p.name.toLowerCase().includes(ql)) ||
      p.npi.includes(ql) ||
      (p.email && p.email.toLowerCase().includes(ql)) ||
      (p.specialty && p.specialty.toLowerCase().includes(ql)) ||
      (p.facility?.name && p.facility.name.toLowerCase().includes(ql)) ||
      (p.facility?.city && p.facility.city.toLowerCase().includes(ql))
    ) {
      matches.push(p);
      // Collect more than `limit` so the email-first sort has options.
      if (matches.length >= limit * 5) break;
    }
  }

  matches.sort((a, b) => Number(Boolean(b.email)) - Number(Boolean(a.email)));
  if (matches.length === 0) {
    // Same orphan-facility fallback as the Supabase path.
    const fac = [...facilitiesById.values()].find((f) => f.name && f.name.toLowerCase().includes(ql));
    if (fac) return getNearbyForFacility(fac, limit);
  }
  return matches.slice(0, limit);
}

// Words too generic to identify a facility on their own.
const FACILITY_STOPWORDS = new Set([
  'hospital', 'medical', 'center', 'centre', 'clinic', 'health', 'healthcare',
  'regional', 'community', 'memorial', 'general', 'university', 'institute',
  'the', 'and', 'for', 'saint',
]);

/**
 * Physicians referenced in free text (e.g. a meeting title) — matched against
 * the Supabase-loaded directory by email, name or facility:
 *  - email in the text → exact hit (100)
 *  - all words of a physician's name present (middle initials ignored, so a
 *    title saying "Adam Smith" matches "Adam J Smith") → 70, or 95 when the
 *    facility also appears
 *  - facility name present (≥2 of its words, at least one distinctive) → 40
 * Returns up to `limit` ranked matches — several physicians sharing a name
 * all come back, so the user picks who the meeting is actually with.
 */
function matchInText(text, limit = 5) {
  if (!text) return [];
  const raw = String(text);
  // Token set, so "Ali" doesn't hit inside "California".
  const tokens = new Set(raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

  const scored = new Map(); // npi → { p, score }
  const add = (p, score) => {
    const prev = scored.get(p.npi);
    if (!prev || prev.score < score) scored.set(p.npi, { p, score });
  };

  // 1. Emails in the text → exact directory hits.
  for (const e of raw.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []) {
    const p = physiciansByEmail.get(e.toLowerCase());
    if (p) add(p, 100);
  }

  // 2. Name / facility mentions.
  for (const p of physicians) {
    let nameHit = false;
    if (p.name) {
      const words = p.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
      nameHit = words.length >= 2 && words.every((w) => tokens.has(w));
    }

    let facilityHit = false;
    if (p.facility?.name) {
      // De-duplicated, so "Fort Smith Fort Smith" can't double-count a word.
      const words = [
        ...new Set(p.facility.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3)),
      ];
      const present = words.filter((w) => tokens.has(w));
      facilityHit = present.length >= 2 && present.some((w) => !FACILITY_STOPWORDS.has(w));
    }

    if (nameHit && facilityHit) add(p, 95);
    else if (nameHit) add(p, 70);
    else if (facilityHit) add(p, 40);
  }

  return [...scored.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(Boolean(b.p.email)) - Number(Boolean(a.p.email)) ||
        String(a.p.name).localeCompare(String(b.p.name))
    )
    .slice(0, limit)
    .map((x) => x.p);
}

/** Full profile for one physician by NPI, or null. */
function getByNpi(npi) {
  return physiciansByNpi.get(String(npi)) || null;
}

/** Full profile for one physician by email (case-insensitive), or null. */
function getByEmail(email) {
  if (!email) return null;
  return physiciansByEmail.get(String(email).toLowerCase()) || null;
}

/** Facility record by ID (used to label analytics facility volumes). */
function getFacilityById(id) {
  return facilitiesById.get(String(id)) || null;
}

// ── Master-data accessors (entity-matching engine) ───────────────────────────

/** Every physician profile (the in-memory, Supabase-loaded master). */
function getAllPhysicians() {
  return physicians;
}

/** Every facility record. */
function getAllFacilities() {
  return [...facilitiesById.values()];
}

/** Physicians whose primary facility is `facilityId` — email-holders first. */
function getByFacility(facilityId, limit = 5) {
  const id = String(facilityId);
  return physicians
    .filter((p) => p.facility?.id === id)
    .sort((a, b) => Number(Boolean(b.email)) - Number(Boolean(a.email)))
    .slice(0, limit);
}

/** Physicians practicing in a city (and state, if given) — email-holders first. */
function getByCity(city, state, limit = 5) {
  if (!city) return [];
  const c = String(city).toLowerCase();
  const s = state ? String(state).toLowerCase() : null;
  return physicians
    .filter(
      (p) =>
        p.facility?.city &&
        p.facility.city.toLowerCase() === c &&
        (!s || (p.facility.state || '').toLowerCase() === s)
    )
    .sort((a, b) => Number(Boolean(b.email)) - Number(Boolean(a.email)))
    .slice(0, limit);
}

/**
 * Same-city fallback for an "orphan" facility — one that exists in the
 * master (e.g. the ~2.3k ASC records) but has no physician linked to it.
 * Returns nearby physicians tagged with a matchHint so the UI can say why.
 */
function getNearbyForFacility(facility, limit = 5) {
  if (!facility?.city) return [];
  return getByCity(facility.city, facility.state, limit).map((p) => ({
    ...p,
    matchHint: `same city as ${facility.name} — ${facility.city}${facility.state ? ', ' + facility.state : ''}`,
  }));
}

module.exports = {
  search,
  getByNpi,
  getByEmail,
  getFacilityById,
  getAllPhysicians,
  getAllFacilities,
  getByFacility,
  getByCity,
  getNearbyForFacility,
  matchInText,
  ready,
};
