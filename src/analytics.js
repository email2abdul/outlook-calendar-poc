'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Physician procedure analytics — reads data/analytics.db, a one-time SQLite
 * ingest of the BIS procedure-volume CSVs (2018–2024, ~2.25M rows) and CPT
 * reimbursement rates. Queried per NPI on demand; nothing is held in memory.
 *
 * The DB is optional (it's too big for git): when absent, every lookup
 * returns null and the UI simply hides the analytics section.
 */

const DB_PATH = path.join(__dirname, '..', 'data', 'analytics.db');

let db = null;
if (fs.existsSync(DB_PATH)) {
  const Database = require('better-sqlite3'); // lazy: skip native module when no DB
  db = new Database(DB_PATH, { readonly: true });
  console.log('[analytics] procedure-volume DB connected');
} else {
  console.warn('[analytics] data/analytics.db not found — analytics disabled');
}

const q = db
  ? {
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
    }
  : null;

/**
 * Everything we know about a physician's procedure activity, or null when
 * there is no data (or the DB is missing).
 */
function getPhysicianAnalytics(npi) {
  if (!db) return null;

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
}

module.exports = { getPhysicianAnalytics };
