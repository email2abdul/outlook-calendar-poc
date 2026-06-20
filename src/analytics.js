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
 * The physician's FULL per-CPT volume rows (with year + category) straight from
 * bis_procedure_volumes — the basis for both the procedure-family rollup and
 * the commercial signals. We read the raw rows rather than the analytics RPC
 * because the RPC caps top procedures by volume, which truncates exactly the
 * low-volume ESD/EUS signals Lumendi cares about. Bounded to one physician's
 * rows. Supabase-only; null when unconfigured or on any read error.
 */
async function readProcedureRows(npi) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('bis_procedure_volumes')
      .select('cpt_code, procedure_description, total_volume, year, procedure_category')
      .eq('physician_npi', String(npi));
    if (error || !data?.length) return null;
    return data.map((r) => ({
      cptCode: r.cpt_code,
      description: r.procedure_description,
      volume: Number(r.total_volume) || 0, // arrives as text
      year: Number(r.year) || null,
      category: r.procedure_category || null,
    }));
  } catch (err) {
    console.warn('[analytics] procedure rows read failed:', err.message);
    return null;
  }
}

/** Procedure-family rollup (Colonoscopy / ESD / EMR / EUS) from raw rows. */
function computeFamilies(rows) {
  if (!rows?.length) return null;
  const { bucketVolumes } = require('./procedure-families');
  const { families, total } = bucketVolumes(rows);
  return total ? { families, total } : null;
}

/**
 * Commercial signals (Lumendi spec) derived from the raw rows:
 *  - growthTrend: latest-year YoY + first→last direction (volume trajectory)
 *  - emerging: ESD/EMR/EUS presence & recency (the advanced-technique signal)
 *  - therapeuticShare: therapeutic vs all categorized volume (adoption proxy)
 * (Lumendi *account* status is a separate data source — not derivable here.)
 */
function computeCommercialSignals(rows) {
  if (!rows?.length) return null;
  const { classifyCpt } = require('./procedure-families');

  const yearVol = {};         // year -> volume
  const famYear = {};         // family -> { year -> volume }
  let therapeuticVol = 0, categorizedVol = 0;

  for (const r of rows) {
    if (!r.volume) continue;
    if (r.year) yearVol[r.year] = (yearVol[r.year] || 0) + r.volume;
    const fam = classifyCpt(r.cptCode, r.description);
    if (r.year) {
      (famYear[fam] = famYear[fam] || {})[r.year] =
        (famYear[fam]?.[r.year] || 0) + r.volume;
    }
    if (r.category) {
      categorizedVol += r.volume;
      if (/therapeut/i.test(r.category)) therapeuticVol += r.volume;
    }
  }

  const years = Object.keys(yearVol).map(Number).sort((a, b) => a - b);
  if (!years.length) return null;

  const latest = years[years.length - 1];
  const prev = years.length > 1 ? years[years.length - 2] : null;
  const latestVol = yearVol[latest];
  const prevVol = prev != null ? yearVol[prev] : null;
  const firstVol = yearVol[years[0]];

  const yoyPct = prevVol ? Math.round(((latestVol - prevVol) / prevVol) * 100) : null;
  const overallPct = firstVol ? Math.round(((latestVol - firstVol) / firstVol) * 100) : null;
  const direction = yoyPct == null ? 'flat' : yoyPct > 5 ? 'up' : yoyPct < -5 ? 'down' : 'flat';

  const growthTrend = {
    direction, yoyPct, overallPct,
    firstYear: years[0], latestYear: latest, latestVolume: latestVol,
    prevYear: prev, prevVolume: prevVol,
  };

  // Advanced techniques Lumendi sells into — flag those present, and whether
  // the activity is recent (last 2 yrs) or brand-new (first seen in last 2 yrs).
  const recentYears = years.slice(-2);
  const emerging = [];
  for (const fam of ['ESD', 'EMR', 'EUS']) {
    const fy = famYear[fam];
    if (!fy) continue;
    const total = Object.values(fy).reduce((s, v) => s + v, 0);
    if (!total) continue;
    const recentVolume = recentYears.reduce((s, y) => s + (fy[y] || 0), 0);
    const firstSeen = Object.keys(fy).map(Number).sort((a, b) => a - b)[0];
    emerging.push({
      family: fam,
      total,
      recentVolume,
      firstSeen,
      isRecent: recentVolume > 0,
      isNew: firstSeen >= latest - 1, // first appeared in the last ~2 years
    });
  }

  return {
    growthTrend,
    emerging,
    therapeuticShare: categorizedVol ? therapeuticVol / categorizedVol : null,
  };
}

/** Procedure-family rollup for one physician (reads + computes). */
async function getProcedureFamilies(npi) {
  return computeFamilies(await readProcedureRows(npi));
}

/** Commercial signals for one physician (reads + computes). */
async function getCommercialSignals(npi) {
  return computeCommercialSignals(await readProcedureRows(npi));
}

/**
 * Analytics with facility volumes labelled from the directory, or null.
 * Shared by the API routes and the reminder engine. Also attaches `byFamily`
 * (procedure-family rollup) and `commercialSignals` (growth/emerging/adoption)
 * when available — both derived from a single raw-rows read.
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

  const rows = await readProcedureRows(npi); // one read, two derivations
  data.byFamily = computeFamilies(rows);
  data.commercialSignals = computeCommercialSignals(rows);

  return data;
}

module.exports = {
  getPhysicianAnalytics,
  getProcedureFamilies,
  getCommercialSignals,
  getLabelledAnalytics,
};
