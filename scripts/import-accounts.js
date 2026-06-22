'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const accounts = require('../src/accounts-store');

/**
 * Lumendi account importer (Lumendi brief spec, P5).
 *
 * Upserts rows into app_accounts from a CSV, keyed by NPI. Runs against whichever
 * Supabase project SUPABASE_ENV selects (default production), using the anon key.
 *
 *   SUPABASE_ENV=development node scripts/import-accounts.js data/accounts-seed.csv
 *
 * CSV header (order-independent; extra columns ignored):
 *   npi,product,status,since_date,source
 * Only `npi` is required per row. Empty cells are stored as null.
 */

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = text.replace(/\r\n/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const ALLOWED = ['npi', 'product', 'status', 'since_date', 'source'];

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: SUPABASE_ENV=development node scripts/import-accounts.js <accounts.csv>');
    process.exit(1);
  }
  if (!accounts.enabled) {
    console.error('Supabase not configured (check SUPABASE_ENV + URL/anon key in .env).');
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(path.resolve(file), 'utf8'));
  if (rows.length < 2) {
    console.error('CSV has no data rows.');
    process.exit(1);
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  if (!header.includes('npi')) {
    console.error('CSV must have an "npi" column.');
    process.exit(1);
  }

  let ok = 0, skipped = 0, failed = 0;
  for (const cols of rows.slice(1)) {
    const rec = {};
    header.forEach((h, i) => {
      if (!ALLOWED.includes(h)) return;
      const v = (cols[i] ?? '').trim();
      rec[h] = v === '' ? null : v;
    });
    if (!rec.npi) { skipped++; continue; }
    rec.npi = String(rec.npi);
    try {
      await accounts.upsertAccount(rec);
      ok++;
    } catch (err) {
      console.warn(`  ✗ ${rec.npi}: ${err.message}`);
      failed++;
    }
  }

  console.log(`Imported ${ok} account(s)${skipped ? `, ${skipped} skipped (no npi)` : ''}${failed ? `, ${failed} failed` : ''} (env=${process.env.SUPABASE_ENV || 'production'}).`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('import failed:', err.message);
  process.exit(1);
});
