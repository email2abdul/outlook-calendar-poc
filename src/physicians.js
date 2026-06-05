'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Physician directory — loads the physician + facility CSVs into memory once
 * at startup and exposes search/lookup helpers. ~21k physicians ≈ a few MB,
 * which is fine to keep in RAM for this POC (no DB needed).
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

/** Normalise empty strings to null so the API shape is predictable. */
function nullable(value) {
  return value && value !== '' ? value : null;
}

// ── Load both CSVs once at module init (startup). ───────────────────────────

const facilitiesById = new Map();
for (const f of parseCsv(fs.readFileSync(FACILITY_CSV, 'utf8'))) {
  facilitiesById.set(f.facility_id, {
    id: f.facility_id,
    name: nullable(f.facility_name),
    type: nullable(f.facility_type),
    address: nullable(f.address),
    city: nullable(f.city),
    state: nullable(f.state),
    zip: nullable(f.zip),
  });
}

const physicians = parseCsv(fs.readFileSync(PHYSICIAN_CSV, 'utf8')).map((p) => ({
  npi: p.physician_npi,
  name: nullable(p.physician_name),
  specialty: nullable(p.specialty),
  email: nullable(p.email),
  phone: nullable(p.phone),
  esdProcedure: p.esd_procedure === 'Yes',
  photoUrl: nullable(p.photo_url),
  linkedinUrl: nullable(p.linkedin_url),
  facility: facilitiesById.get(p.primary_facility_id) || null,
}));

const physiciansByNpi = new Map(physicians.map((p) => [p.npi, p]));

console.log(
  `[physicians] loaded ${physicians.length} physicians, ${facilitiesById.size} facilities`
);

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

module.exports = { search, getByNpi };
