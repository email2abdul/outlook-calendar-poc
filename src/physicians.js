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
 * Search physicians by free text (matches name, NPI, email or specialty).
 * Results with an email sort first — they're the ones we can actually invite.
 * @param {string} query
 * @param {number} [limit=20]
 */
function search(query, limit = 20) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  const matches = [];
  for (const p of physicians) {
    if (
      (p.name && p.name.toLowerCase().includes(q)) ||
      p.npi.includes(q) ||
      (p.email && p.email.toLowerCase().includes(q)) ||
      (p.specialty && p.specialty.toLowerCase().includes(q))
    ) {
      matches.push(p);
      // Collect more than `limit` so the email-first sort has options.
      if (matches.length >= limit * 5) break;
    }
  }

  matches.sort((a, b) => Number(Boolean(b.email)) - Number(Boolean(a.email)));
  return matches.slice(0, limit);
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

module.exports = { search, getByNpi, getByEmail, getFacilityById, ready };
