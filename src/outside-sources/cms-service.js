'use strict';

const { getJson, buildUrl } = require('../enrichment/http');
const health = require('../enrichment/health');

/**
 * CMS "Medicare Physician & Other Practitioners — by Provider and Service".
 *
 * This is the one public source that carries what BIS carries: the CPT/HCPCS
 * lines a physician billed, with service and beneficiary counts — year by year.
 * For a physician the master has never heard of, it is the difference between a
 * name and a practice.
 *
 * Keyed by NPI, never by name. Name search on this dataset is unusable (the
 * table has one row per provider PER CODE, so a name query returns hundreds of
 * rows for the same person and dozens of same-named strangers). NPPES turns a
 * name into an NPI; this turns the NPI into volumes. That order is deliberate.
 *
 * YEARS: one dataset per data year, each with its own id, so a "year" is a
 * separate request. CMS_SERVICE_YEARS controls which — 2024 and 2023 today,
 * `CMS_SERVICE_YEARS=2024,2023,2022,…` adds more with no code change.
 *
 * The dataset ids are DISCOVERED, not hardcoded: CMS republishes them (a new
 * data year ships a new id, and the "latest" alias moves), so the catalogue is
 * read once per process and cached. CMS_DATASET_<YEAR> overrides one, for the
 * day the catalogue is unreachable and an id is known.
 *
 * ⚠️ Known reachability problem, measured twice (2026-08-18 and again
 * 2026-09-01): `data.cms.gov/data-api/v1/dataset/{id}/data` can hang and time
 * out from some networks — filtered queries and `size=1` alike, HTTP/2 and
 * HTTP/1.1 alike — while the CSV on the same host downloads fine. Everything
 * here therefore reports through ./health, so an unreachable dataset is
 * reported as unreachable and never as "this physician bills nothing". The CSV
 * bulk path stays the documented fallback if the API keeps refusing.
 */

const ID = 'cms-service';
const NAME = 'CMS Medicare Physician & Other Practitioners';
const CATALOG_URL = 'https://data.cms.gov/data.json';
const DATASET_TITLE = 'Medicare Physician & Other Practitioners - by Provider and Service';
const API = (uuid) => `https://data.cms.gov/data-api/v1/dataset/${uuid}/data`;
/** The page a rep can open to see the same numbers. */
const HUMAN_URL =
  'https://data.cms.gov/provider-summary-by-type-of-service/medicare-physician-other-practitioners/' +
  'medicare-physician-other-practitioners-by-provider-and-service';

/** How many CPT lines to keep per year — a brief, not a data dump. */
const MAX_LINES_PER_YEAR = 8;
const CATALOG_TTL_MS = 12 * 60 * 60 * 1000; // ids change when CMS republishes

/** Years to read, newest first. */
function years() {
  const raw = process.env.CMS_SERVICE_YEARS || '2024,2023';
  return [...new Set(raw.split(',').map((y) => y.trim()).filter((y) => /^\d{4}$/.test(y)))]
    .sort((a, b) => Number(b) - Number(a));
}

let catalogCache = { at: 0, byYear: new Map() };

/**
 * year → dataset uuid, from the CMS catalogue.
 *
 * Each distribution's title ends in the data year ("… : 2024-12-01") and its
 * accessURL is the API endpoint; the CSV sibling is ignored here.
 */
async function datasetsByYear() {
  const fromEnv = new Map();
  for (const y of years()) {
    const override = process.env[`CMS_DATASET_${y}`];
    if (override) fromEnv.set(y, override.trim());
  }
  // Every wanted year pinned by env → no catalogue fetch at all.
  if (fromEnv.size === years().length) return fromEnv;

  const fresh = Date.now() - catalogCache.at < CATALOG_TTL_MS;
  if (fresh && catalogCache.byYear.size) {
    return new Map([...catalogCache.byYear, ...fromEnv]);
  }

  const res = await getJson(CATALOG_URL, { label: 'cms-catalog', timeoutMs: 30000, retries: 1 });
  const byYear = new Map();
  if (res.ok && res.body) {
    const dataset = (res.body.dataset || []).find((d) => d.title === DATASET_TITLE);
    for (const dist of dataset?.distribution || []) {
      const url = dist.accessURL || '';
      const m = /dataset\/([0-9a-f-]{36})\/data$/.exec(url);
      const year = (String(dist.title || '').match(/(\d{4})-\d{2}-\d{2}\s*$/) || [])[1];
      // The first distribution for a year is the API one; later duplicates
      // (the "latest" alias points at the newest year too) must not overwrite it.
      if (m && year && !byYear.has(year)) byYear.set(year, m[1]);
    }
    if (byYear.size) catalogCache = { at: Date.now(), byYear };
  }

  return new Map([...byYear, ...fromEnv]);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** One dataset row → a CPT line. */
function toLine(r) {
  return {
    hcpcs: r.HCPCS_Cd || null,
    description: r.HCPCS_Desc || null,
    placeOfService: r.Place_Of_Srvc === 'F' ? 'facility' : r.Place_Of_Srvc === 'O' ? 'office' : null,
    beneficiaries: num(r.Tot_Benes),
    services: num(r.Tot_Srvcs),
    avgAllowed: num(r.Avg_Mdcr_Alowd_Amt),
    avgPaid: num(r.Avg_Mdcr_Pymt_Amt),
    avgSubmitted: num(r.Avg_Sbmtd_Chrg),
  };
}

/** The provider's own details, as this dataset states them. */
function toProvider(r, year) {
  const street = [r.Rndrng_Prvdr_St1, r.Rndrng_Prvdr_St2].filter(Boolean).join(' ');
  return {
    npi: r.Rndrng_NPI ? String(r.Rndrng_NPI) : null,
    name:
      [r.Rndrng_Prvdr_First_Name, r.Rndrng_Prvdr_MI, r.Rndrng_Prvdr_Last_Org_Name]
        .filter(Boolean)
        .join(' ') || null,
    // The dataset's own words for what this provider is ("Gastroenterology").
    specialty: r.Rndrng_Prvdr_Type || null,
    primaryTaxonomy: r.Rndrng_Prvdr_Type || null,
    credential: r.Rndrng_Prvdr_Crdntls || null,
    facilityAddress: [street, r.Rndrng_Prvdr_City, r.Rndrng_Prvdr_State_Abrvtn, r.Rndrng_Prvdr_Zip5]
      .filter(Boolean)
      .join(', ') || null,
    city: r.Rndrng_Prvdr_City || null,
    state: r.Rndrng_Prvdr_State_Abrvtn || null,
    zip: r.Rndrng_Prvdr_Zip5 ? String(r.Rndrng_Prvdr_Zip5) : null,
    ruralUrban: r.Rndrng_Prvdr_RUCA_Desc || null,
    medicareParticipating: r.Rndrng_Prvdr_Mdcr_Prtcptg_Ind || null,
    latestYear: year,
  };
}

/**
 * One year's rows for one NPI.
 *
 * Returns `{ rows, failed }` rather than a bare array, because "this dataset
 * lists nothing for that NPI" and "this dataset could not be read" are the two
 * answers that must never be confused — and the caller cannot tell them apart
 * from an empty array. `failed` covers a transport error, a timeout and a 5xx;
 * the health ledger is then a second, independent signal.
 */
async function yearRows(uuid, npi, year) {
  const url = buildUrl(API(uuid), {
    'filter[Rndrng_NPI]': npi,
    size: 500,
    offset: 0,
  });
  // Deliberately short: this runs while a rep waits for a meeting panel, and a
  // dataset that is going to hang has already been seen to hang for minutes.
  const res = await getJson(url, { label: `cms-service-${year}`, timeoutMs: 15000, retries: 1 });
  if (!res.ok) return { rows: [], failed: true, kind: res.kind || 'network' };
  return { rows: Array.isArray(res.body) ? res.body : [], failed: false };
}

/**
 * Everything this dataset knows about one NPI, newest year first.
 *
 * @param {string} npi
 * @returns {Promise<{
 *   npi, name, specialty, facilityAddress, city, state, zip,
 *   years: Array<{year, services, beneficiaries, allowed, lines: object[], truncated: boolean, sourceUrl}>,
 *   externalSource, externalSourceUrl, extra: object,
 *   unreachableYears: string[]
 * }|null>}
 */
async function getByNpi(npi) {
  const clean = String(npi || '').replace(/\D/g, '');
  if (clean.length !== 10) return null;

  return health.run(async () => {
    const byYear = await datasetsByYear();
    const wanted = years();

    const found = [];
    const unreachableYears = [];
    let provider = null;

    for (const year of wanted) {
      const uuid = byYear.get(year);
      if (!uuid) {
        // The catalogue could not name this year's dataset — say so rather than
        // letting a missing year read as a year with no billing.
        unreachableYears.push(year);
        continue;
      }

      const { rows, failed } = await yearRows(uuid, clean, year);
      if (failed || health.blindFor(`cms-service-${year}`).length) {
        unreachableYears.push(year);
        continue;
      }
      if (!rows.length) continue;

      if (!provider) provider = toProvider(rows[0], year);

      const lines = rows.map(toLine).sort((a, b) => (b.services || 0) - (a.services || 0));
      found.push({
        year,
        services: lines.reduce((t, l) => t + (l.services || 0), 0),
        beneficiaries: lines.reduce((t, l) => t + (l.beneficiaries || 0), 0),
        allowed: Math.round(
          lines.reduce((t, l) => t + (l.avgAllowed || 0) * (l.services || 0), 0)
        ),
        codes: lines.length,
        lines: lines.slice(0, MAX_LINES_PER_YEAR),
        truncated: lines.length > MAX_LINES_PER_YEAR,
        sourceUrl: HUMAN_URL,
      });
    }

    // Nothing at all: still an ANSWER, and a different one depending on why.
    // Returning null for both made the brief say "volume sections need this
    // physician in bis_procedure_volumes" — as though CMS had never been asked
    // — when in fact it had been asked and had nothing (a behaviour technician
    // bills no Medicare fee-for-service). The renderer needs to be able to tell
    // "asked, nothing there" from "could not ask".
    if (!found.length && !provider) {
      return {
        npi: clean,
        years: [],
        unreachableYears,
        externalSource: ID,
        externalSourceUrl: HUMAN_URL,
        extra: {},
      };
    }

    return {
      ...(provider || { npi: clean }),
      inBis: false,
      externalSource: ID,
      externalSourceUrl: HUMAN_URL,
      years: found,
      unreachableYears,
      extra: {
        // No BIS column exists for any of this.
        credential: provider?.credential || null,
        ruralUrban: provider?.ruralUrban || null,
        medicareParticipating: provider?.medicareParticipating || null,
      },
    };
  });
}

/**
 * Not supported, and not a gap: see the note at the top — a name query on a
 * one-row-per-code table cannot identify a person. NPPES does that job.
 */
async function searchByName() {
  return [];
}

module.exports = {
  id: ID,
  name: NAME,
  url: HUMAN_URL,
  // A name cannot identify anyone in a one-row-per-code table; NPPES does that.
  nameSearchable: false,
  searchByName,
  getByNpi,
  // exported for tests / tuning
  years,
  datasetsByYear,
  toLine,
  toProvider,
  MAX_LINES_PER_YEAR,
};
