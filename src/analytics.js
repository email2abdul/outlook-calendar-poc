'use strict';

const fs = require('fs');
const path = require('path');
const pool = require('./db');

/**
 * Physician procedure analytics — totals, yearly trend, category/payer mix,
 * top CPT codes with reimbursement rates, and facility volumes (2018–2024,
 * ~2.25M rows). Queried per NPI on demand; nothing is held in memory.
 *
 * Two interchangeable backends behind one async API:
 *  - Supabase Postgres (when DATABASE_URL is set) — reads the bis_* tables.
 *    Works everywhere, including serverless hosts like Vercel.
 *  - Local SQLite (data/analytics.db from `npm run ingest`) — offline dev.
 * When neither is available every lookup returns null and the UI simply
 * hides the analytics section.
 */

const SQLITE_PATH = path.join(__dirname, '..', 'data', 'analytics.db');

// ── Supabase Postgres backend ────────────────────────────────────────────────
// Casts: total_volume is TEXT in bis_procedure_volumes → ::numeric to sum,
// then ::int / ::float8 so the pg driver returns JS numbers (it returns
// bigint/numeric as strings otherwise). Aliases quoted to keep camelCase.
function createPostgresBackend(pg) {
  const q = {
    summary: `
      SELECT SUM(total_volume::numeric)::int AS "totalVolume",
             MIN(year)::int AS "firstYear",
             MAX(year)::int AS "lastYear",
             COUNT(DISTINCT cpt_code)::int AS "distinctProcedures"
      FROM bis_procedure_volumes WHERE physician_npi = $1
    `,
    byYear: `
      SELECT year::int AS year, SUM(total_volume::numeric)::int AS volume
      FROM bis_procedure_volumes WHERE physician_npi = $1
      GROUP BY year ORDER BY year
    `,
    byCategory: `
      SELECT procedure_category AS category, SUM(total_volume::numeric)::int AS volume
      FROM bis_procedure_volumes WHERE physician_npi = $1
      GROUP BY procedure_category ORDER BY volume DESC
    `,
    byPayer: `
      SELECT payer_category AS payer, SUM(total_volume::numeric)::int AS volume
      FROM bis_procedure_volumes WHERE physician_npi = $1
      GROUP BY payer_category ORDER BY volume DESC
    `,
    topProcedures: `
      SELECT pv.cpt_code AS "cptCode",
             MAX(pv.procedure_description) AS description,
             SUM(pv.total_volume::numeric)::int AS volume,
             MAX(r.medicare_physician_rate)::float8 AS "medicarePhysicianRate",
             MAX(r.commercial_benchmark_rate)::float8 AS "commercialRate"
      FROM bis_procedure_volumes pv
      LEFT JOIN bis_cpt_reimbursement r ON r.cpt_code = pv.cpt_code
      WHERE pv.physician_npi = $1
      GROUP BY pv.cpt_code ORDER BY volume DESC LIMIT 8
    `,
    facilities: `
      SELECT facility_id AS "facilityId", SUM(total_volume::numeric)::int AS volume
      FROM bis_procedure_volumes WHERE physician_npi = $1
      GROUP BY facility_id ORDER BY volume DESC LIMIT 5
    `,
    snare: `
      SELECT SUM(CASE WHEN snare_used = 'Yes' THEN total_volume::numeric ELSE 0 END)::int AS "snareVolume",
             SUM(total_volume::numeric)::int AS "totalVolume"
      FROM bis_procedure_volumes WHERE physician_npi = $1
    `,
  };

  return async function getPhysicianAnalytics(npi) {
    const params = [String(npi)];
    const [summary, byYear, byCategory, byPayer, topProcedures, facilities, snare] =
      await Promise.all([
        pg.query(q.summary, params),
        pg.query(q.byYear, params),
        pg.query(q.byCategory, params),
        pg.query(q.byPayer, params),
        pg.query(q.topProcedures, params),
        pg.query(q.facilities, params),
        pg.query(q.snare, params),
      ]);

    const s = summary.rows[0];
    if (!s || !s.totalVolume) return null;

    const sn = snare.rows[0];

    return {
      summary: {
        totalVolume: s.totalVolume,
        firstYear: s.firstYear,
        lastYear: s.lastYear,
        distinctProcedures: s.distinctProcedures,
        snareShare: sn?.totalVolume ? sn.snareVolume / sn.totalVolume : 0,
      },
      byYear: byYear.rows,
      byCategory: byCategory.rows,
      byPayer: byPayer.rows,
      topProcedures: topProcedures.rows,
      facilities: facilities.rows,
    };
  };
}

// ── Local SQLite backend (data/analytics.db) ─────────────────────────────────
function createSqliteBackend() {
  const Database = require('better-sqlite3'); // lazy: skip native module when unused
  const db = new Database(SQLITE_PATH, { readonly: true });

  const q = {
    summary: db.prepare(`
      SELECT SUM(total_volume) AS totalVolume,
             MIN(year) AS firstYear,
             MAX(year) AS lastYear,
             COUNT(DISTINCT cpt_code) AS distinctProcedures
      FROM procedure_volumes WHERE physician_npi = ?
    `),
    byYear: db.prepare(`
      SELECT year, SUM(total_volume) AS volume
      FROM procedure_volumes WHERE physician_npi = ?
      GROUP BY year ORDER BY year
    `),
    byCategory: db.prepare(`
      SELECT procedure_category AS category, SUM(total_volume) AS volume
      FROM procedure_volumes WHERE physician_npi = ?
      GROUP BY procedure_category ORDER BY volume DESC
    `),
    byPayer: db.prepare(`
      SELECT payer_category AS payer, SUM(total_volume) AS volume
      FROM procedure_volumes WHERE physician_npi = ?
      GROUP BY payer_category ORDER BY volume DESC
    `),
    topProcedures: db.prepare(`
      SELECT pv.cpt_code AS cptCode,
             pv.procedure_description AS description,
             SUM(pv.total_volume) AS volume,
             r.medicare_physician_rate AS medicarePhysicianRate,
             r.commercial_benchmark_rate AS commercialRate
      FROM procedure_volumes pv
      LEFT JOIN cpt_reimbursement r ON r.cpt_code = pv.cpt_code
      WHERE pv.physician_npi = ?
      GROUP BY pv.cpt_code ORDER BY volume DESC LIMIT 8
    `),
    facilities: db.prepare(`
      SELECT facility_id AS facilityId, SUM(total_volume) AS volume
      FROM procedure_volumes WHERE physician_npi = ?
      GROUP BY facility_id ORDER BY volume DESC LIMIT 5
    `),
    snare: db.prepare(`
      SELECT SUM(CASE WHEN snare_used = 'Yes' THEN total_volume ELSE 0 END) AS snareVolume,
             SUM(total_volume) AS totalVolume
      FROM procedure_volumes WHERE physician_npi = ?
    `),
  };

  return async function getPhysicianAnalytics(npi) {
    const id = String(npi);
    const summary = q.summary.get(id);
    if (!summary || !summary.totalVolume) return null;

    const snare = q.snare.get(id);

    return {
      summary: {
        totalVolume: summary.totalVolume,
        firstYear: summary.firstYear,
        lastYear: summary.lastYear,
        distinctProcedures: summary.distinctProcedures,
        snareShare: snare?.totalVolume ? snare.snareVolume / snare.totalVolume : 0,
      },
      byYear: q.byYear.all(id),
      byCategory: q.byCategory.all(id),
      byPayer: q.byPayer.all(id),
      topProcedures: q.topProcedures.all(id),
      facilities: q.facilities.all(id),
    };
  };
}

// ── Backend selection ────────────────────────────────────────────────────────
let getPhysicianAnalytics;
if (pool) {
  getPhysicianAnalytics = createPostgresBackend(pool);
  console.log('[analytics] using Supabase Postgres (bis_* tables)');
} else if (fs.existsSync(SQLITE_PATH)) {
  getPhysicianAnalytics = createSqliteBackend();
  console.log('[analytics] using local data/analytics.db');
} else {
  getPhysicianAnalytics = async () => null;
  console.warn('[analytics] no DATABASE_URL and no data/analytics.db — analytics disabled');
}

module.exports = { getPhysicianAnalytics };
