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
 * Account opportunity (Lumendi spec) — the OTHER physicians at the meeting
 * physician's facility and the procedures they perform, so the rep knows who
 * else to engage and where the expansion is. Answers "Who else in this facility
 * should I engage?".
 *
 * Candidates = directory peers whose primary facility matches ∪ anyone with
 * procedure volume recorded at the facility (a physician may operate there
 * without it being their home base), minus the meeting physician. Ranked by
 * volume. One facility-scoped read; capped, with a `truncated` flag for very
 * large facilities. (The "N using Dilumen" account-status figure needs a
 * separate Lumendi data source — not derivable here.)
 */
async function getAccountOpportunity(npi, { maxPeers = 6 } = {}) {
  if (!supabase) return null;
  const physiciansDir = require('./physicians');
  const me = physiciansDir.getByNpi(npi);
  const facility = me?.facility;
  if (!facility?.id) return null;

  const { classifyCpt } = require('./procedure-families');
  const LIMIT = 5000;
  let rows = [];
  let truncated = false;
  try {
    const { data, error } = await supabase
      .from('bis_procedure_volumes')
      .select('physician_npi, cpt_code, procedure_description, total_volume')
      .eq('facility_id', String(facility.id))
      .limit(LIMIT);
    if (error) return null;
    rows = data || [];
    truncated = rows.length === LIMIT;
  } catch (err) {
    console.warn('[analytics] account-opportunity read failed:', err.message);
    return null;
  }

  // Volume + procedure families per physician active at this facility.
  const agg = {}; // npi -> { volume, families:Set }
  for (const r of rows) {
    const vol = Number(r.total_volume) || 0;
    if (!vol) continue;
    const id = String(r.physician_npi);
    (agg[id] = agg[id] || { volume: 0, families: new Set() });
    agg[id].volume += vol;
    agg[id].families.add(classifyCpt(r.cpt_code, r.procedure_description));
  }

  const selfId = String(npi);
  const ids = new Set([
    ...physiciansDir.getByFacility(facility.id, 100).map((p) => String(p.npi)),
    ...Object.keys(agg),
  ]);
  ids.delete(selfId);

  let peers = [...ids]
    .map((id) => {
      const p = physiciansDir.getByNpi(id);
      const a = agg[id];
      return {
        npi: id,
        name: p?.name || null,
        specialty: p?.specialty || null,
        email: p?.email || null,
        phone: p?.phone || null,
        esdProcedure: Boolean(p?.esdProcedure),
        volume: a?.volume || 0,
        families: a ? [...a.families].filter((f) => f !== 'Other') : [],
      };
    })
    .filter((p) => p.name || p.volume) // skip ghosts we can't name and have no activity
    .sort(
      (a, b) =>
        b.volume - a.volume || Number(Boolean(b.email)) - Number(Boolean(a.email))
    );

  // Lumendi account overlay (P5): who at this facility actually uses a product.
  // One read covering the meeting physician + every peer.
  const accounts = await require('./accounts-store').getAccounts([selfId, ...peers.map((p) => p.npi)]);
  peers = peers.map((p) => {
    const acct = accounts[p.npi];
    return { ...p, lumendiProduct: acct?.isActiveUser ? acct.product || 'Lumendi product' : null };
  });
  const lumendiUserCount = [selfId, ...peers.map((p) => p.npi)].filter(
    (id) => accounts[id]?.isActiveUser
  ).length;

  return {
    facility: { id: facility.id, name: facility.name, city: facility.city, state: facility.state },
    peerCount: peers.length,
    performingCount: peers.filter((p) => p.volume > 0).length,
    lumendiUserCount,
    truncated,
    peers: peers.slice(0, maxPeers),
  };
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
  data.accountOpportunity = await getAccountOpportunity(npi);
  // "What to discuss?" — product talking points matched to this physician's
  // procedure families (deterministic; null until brochures are ingested).
  data.productContext = require('./product-context').getTalkingPoints(data.byFamily);
  // This physician's own Lumendi account status (Commercial Signals, P5).
  data.lumendiAccount = await require('./accounts-store').getAccount(npi);

  return data;
}

module.exports = {
  getPhysicianAnalytics,
  getProcedureFamilies,
  getCommercialSignals,
  getAccountOpportunity,
  getLabelledAnalytics,
};
