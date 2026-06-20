'use strict';

const fs = require('fs');
const path = require('path');
const supabase = require('./supabase');

/**
 * Physician procedure analytics — totals, yearly trend, category/payer mix,
 * top CPT codes with reimbursement rates, and facility volumes (2018–2024,
 * ~2.25M rows). Queried per NPI on demand; nothing is held in memory.
 *
 * Two interchangeable backends behind one async API:
 *  - Supabase (when SUPABASE_URL is set) — one RPC call to the
 *    bis_physician_analytics(p_npi) SQL function, which aggregates the
 *    bis_procedure_volumes table server-side. Works everywhere, including
 *    serverless hosts like Vercel.
 *  - Local SQLite (data/analytics.db from `npm run ingest`) — offline dev.
 * When neither is available every lookup returns null and the UI simply
 * hides the analytics section.
 */

const SQLITE_PATH = path.join(__dirname, '..', 'data', 'analytics.db');

// ── Supabase backend ─────────────────────────────────────────────────────────
function createSupabaseBackend(client) {
  return async function getPhysicianAnalytics(npi) {
    const { data, error } = await client.rpc('bis_physician_analytics', {
      p_npi: String(npi),
    });
    if (error) throw new Error(`analytics RPC failed: ${error.message}`);
    // The function returns the exact response shape (or null for no data).
    return data;
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
if (supabase) {
  getPhysicianAnalytics = createSupabaseBackend(supabase);
  console.log('[analytics] using Supabase (bis_physician_analytics RPC)');
} else if (fs.existsSync(SQLITE_PATH)) {
  getPhysicianAnalytics = createSqliteBackend();
  console.log('[analytics] using local data/analytics.db');
} else {
  getPhysicianAnalytics = async () => null;
  console.warn('[analytics] no Supabase config and no data/analytics.db — analytics disabled');
}

/**
 * Procedure-family volumes (Colonoscopy / ESD / EMR / EUS) for one physician —
 * the brief's "Procedure Intelligence" headline (Lumendi spec).
 *
 * The analytics RPC caps top procedures at a handful by volume, which would
 * truncate exactly the low-volume ESD/EUS signals Lumendi cares about, so this
 * reads the physician's FULL per-CPT volumes straight from bis_procedure_volumes
 * (bounded to one physician's rows) and buckets them. Supabase-only; returns
 * null when unconfigured or on any read error, so the brief just omits the
 * section rather than failing.
 */
async function getProcedureFamilies(npi) {
  if (!supabase) return null;
  const { bucketVolumes } = require('./procedure-families');
  try {
    const { data, error } = await supabase
      .from('bis_procedure_volumes')
      .select('cpt_code, procedure_description, total_volume')
      .eq('physician_npi', String(npi));
    if (error || !data?.length) return null;

    const rows = data.map((r) => ({
      cptCode: r.cpt_code,
      description: r.procedure_description,
      volume: r.total_volume, // arrives as text; bucketVolumes coerces
    }));
    const { families, total } = bucketVolumes(rows);
    return total ? { families, total } : null;
  } catch (err) {
    console.warn('[analytics] procedure-family read failed:', err.message);
    return null;
  }
}

/**
 * Analytics with facility volumes labelled from the directory, or null.
 * Shared by the API routes and the reminder engine. Also attaches `byFamily`
 * (procedure-family rollup) when available.
 */
async function getLabelledAnalytics(npi) {
  const physiciansDir = require('./physicians'); // lazy: avoids load-order coupling
  const data = await getPhysicianAnalytics(npi);
  if (!data) return null;

  data.facilities = data.facilities.map((f) => {
    const fac = physiciansDir.getFacilityById(f.facilityId);
    return {
      ...f,
      name: fac?.name || f.facilityId,
      city: fac?.city || null,
      state: fac?.state || null,
    };
  });

  data.byFamily = await getProcedureFamilies(npi);

  return data;
}

module.exports = { getPhysicianAnalytics, getProcedureFamilies, getLabelledAnalytics };
