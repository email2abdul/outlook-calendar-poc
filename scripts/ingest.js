'use strict';

/**
 * One-time ingest: build data/analytics.db from the BIS procedure-volume
 * CSVs (2018–2024, ~2.25M rows) and the CPT reimbursement table.
 *
 * Usage:
 *   npm run ingest                       # uses the default source directory
 *   npm run ingest -- "/path/to/csvs"    # or point at another directory
 *
 * The source directory must contain:
 *   procedure_volume_output_upload_*.csv
 *   cpt_reimbursement_output.csv
 *
 * Streams line-by-line (the files are ~90MB each) and inserts in batched
 * transactions, so memory stays flat and the whole run takes well under a
 * minute. The resulting DB is read by src/analytics.js.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');

const DEFAULT_SRC =
  '/Users/wajid/Downloads/workspace/BIS PD/GI_Lumendi/Final Upload Lumendi CSV';

const srcDir = process.argv[2] || DEFAULT_SRC;
const dbPath = path.join(__dirname, '..', 'data', 'analytics.db');

if (!fs.existsSync(srcDir)) {
  console.error(`Source directory not found: ${srcDir}`);
  console.error('Pass it explicitly: npm run ingest -- "/path/to/Final Upload Lumendi CSV"');
  process.exit(1);
}

const volumeFiles = fs
  .readdirSync(srcDir)
  .filter((f) => /^procedure_volume_output_upload_.*\.csv$/.test(f))
  .sort()
  .map((f) => path.join(srcDir, f));

const cptFile = path.join(srcDir, 'cpt_reimbursement_output.csv');

if (volumeFiles.length === 0 || !fs.existsSync(cptFile)) {
  console.error(`Expected procedure_volume_output_upload_*.csv and cpt_reimbursement_output.csv in ${srcDir}`);
  process.exit(1);
}

/** Parse one CSV line (RFC-4180 quoting; no embedded newlines in this data). */
function parseLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

/**
 * Stream a CSV into a prepared insert. Column order is taken from the header
 * row, mapped onto `columns`, so reordered source files still load correctly.
 */
async function importCsv(db, file, table, columns, insert) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });

  let header = null;
  let batch = [];
  let total = 0;

  const insertBatch = db.transaction((rows) => {
    for (const row of rows) insert.run(row);
  });

  for await (const line of rl) {
    if (line === '') continue;
    if (!header) {
      const names = parseLine(line).map((h) => h.trim());
      header = columns.map((c) => names.indexOf(c));
      const missing = columns.filter((_, i) => header[i] === -1);
      if (missing.length) {
        throw new Error(`${path.basename(file)} is missing columns: ${missing.join(', ')}`);
      }
      continue;
    }

    const raw = parseLine(line);
    batch.push(header.map((idx) => raw[idx] ?? null));
    total++;

    if (batch.length >= 10000) {
      insertBatch(batch);
      batch = [];
      if (total % 250000 === 0) {
        console.log(`  …${total.toLocaleString()} rows`);
      }
    }
  }

  if (batch.length) insertBatch(batch);
  console.log(`  ${path.basename(file)} → ${table}: ${total.toLocaleString()} rows`);
  return total;
}

async function main() {
  // Always rebuild from scratch — the source CSVs are the system of record.
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-journal`, { force: true });

  const db = new Database(dbPath);
  // Ingest-only pragmas: we can afford to lose a half-built DB on crash.
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');

  db.exec(`
    CREATE TABLE procedure_volumes (
      year INTEGER, facility_id TEXT, physician_npi TEXT, cpt_code TEXT,
      procedure_description TEXT, procedure_category TEXT, snare_used TEXT,
      payer_category TEXT, age_group TEXT, principal_icd10 TEXT,
      total_volume INTEGER, created_at TEXT
    );
    CREATE TABLE cpt_reimbursement (
      cpt_code TEXT, procedure_name TEXT, apc_code TEXT, ms_drg TEXT,
      medicare_physician_rate REAL, medicare_asc_rate REAL,
      medicare_hospital_outpatient_rate REAL, commercial_benchmark_rate REAL,
      icd10_pcs_crosswalk TEXT, created_at TEXT
    );
  `);

  const volumeColumns = [
    'year', 'facility_id', 'physician_npi', 'cpt_code',
    'procedure_description', 'procedure_category', 'snare_used',
    'payer_category', 'age_group', 'principal_icd10', 'total_volume', 'created_at',
  ];
  const volumeInsert = db.prepare(
    `INSERT INTO procedure_volumes VALUES (${volumeColumns.map(() => '?').join(',')})`
  );

  console.log(`Ingesting from: ${srcDir}`);
  let grandTotal = 0;
  for (const file of volumeFiles) {
    grandTotal += await importCsv(db, file, 'procedure_volumes', volumeColumns, volumeInsert);
  }

  const cptColumns = [
    'cpt_code', 'procedure_name', 'apc_code', 'ms_drg',
    'medicare_physician_rate', 'medicare_asc_rate',
    'medicare_hospital_outpatient_rate', 'commercial_benchmark_rate',
    'icd10_pcs_crosswalk', 'created_at',
  ];
  const cptInsert = db.prepare(
    `INSERT INTO cpt_reimbursement VALUES (${cptColumns.map(() => '?').join(',')})`
  );
  await importCsv(db, cptFile, 'cpt_reimbursement', cptColumns, cptInsert);

  console.log('Creating index on physician_npi…');
  db.exec('CREATE INDEX idx_pv_npi ON procedure_volumes(physician_npi);');
  db.close();

  console.log(`Done: ${grandTotal.toLocaleString()} volume rows → ${dbPath}`);
}

main().catch((err) => {
  console.error('Ingest failed:', err.message);
  process.exit(1);
});
