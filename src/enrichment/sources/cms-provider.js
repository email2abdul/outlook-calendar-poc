'use strict';

const { getJson, buildUrl } = require('../http');

/**
 * CMS Provider Data Catalog — hospital affiliations and hospital profiles.
 *
 * Two datasets, chained by CCN (CMS Certification Number):
 *
 *   NPI ──[ Facility Affiliation  27ea-46a8 ]──▶ CCN
 *   CCN ──[ Hospital General Info xubh-q36u ]──▶ name, address, type,
 *                                                ownership, star rating
 *
 * This is what lets an unknown physician be placed at a real hospital — and
 * that hospital name is then matched back into bis_facilities (see rematch.js),
 * which is how the enrichment recovers BIS volumes and colleagues even when the
 * physician themselves is absent from the master.
 *
 * Free, no key. Verified live 2026-08-18: NPI 1467521757 → CCN 340061 →
 * "UNC HOSPITALS", Acute Care, Government - State, 5-star.
 *
 * Not used: data.cms.gov/data-api/v1/dataset/{uuid}/data (Medicare physician
 * CPT volumes). It hung and timed out on every attempt over both HTTP/2 and
 * HTTP/1.1 — see docs/external-enrichment-agent.md §3.
 */

const DATASTORE = 'https://data.cms.gov/provider-data/api/1/datastore/query';
const AFFILIATION_ID = '27ea-46a8'; // Facility Affiliation Data
const HOSPITAL_ID = 'xubh-q36u'; // Hospital General Information

/** Human-openable dataset page, used as the field's sourceUrl. */
const datasetUrl = (id) => `https://data.cms.gov/provider-data/dataset/${id}`;

/**
 * The datastore query API takes filters as indexed bracket params:
 *   conditions[0][property]=npi&conditions[0][value]=123&conditions[0][operator]==
 * buildUrl percent-encodes the brackets, which the API accepts.
 */
function conditionParams(conditions) {
  const params = {};
  conditions.forEach((c, i) => {
    params[`conditions[${i}][property]`] = c.property;
    params[`conditions[${i}][value]`] = c.value;
    params[`conditions[${i}][operator]`] = c.operator || '=';
  });
  return params;
}

async function queryDataset(datasetId, conditions, limit = 20, label = 'cms') {
  const url = buildUrl(`${DATASTORE}/${datasetId}/0`, {
    limit,
    ...conditionParams(conditions),
  });
  const res = await getJson(url, { label, timeoutMs: 30000 });
  if (!res.ok || !res.body) return [];
  return res.body.results || [];
}

/**
 * Hospitals (and other facility types) a provider is affiliated with.
 * @returns {Promise<Array<{type:string, ccn:string, sourceUrl:string}>>}
 */
async function getAffiliations(npi) {
  const clean = String(npi || '').replace(/\D/g, '');
  if (clean.length !== 10) return [];

  const rows = await queryDataset(
    AFFILIATION_ID,
    [{ property: 'npi', value: clean }],
    25,
    'cms-affiliation'
  );

  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const ccn = r.facility_affiliations_certification_number;
    if (!ccn || seen.has(ccn)) continue;
    seen.add(ccn);
    out.push({ type: r.facility_type || null, ccn, sourceUrl: datasetUrl(AFFILIATION_ID) });
  }
  return out;
}

function normalizeHospital(r) {
  if (!r) return null;
  return {
    ccn: r.facility_id,
    name: r.facility_name || null,
    address: [r.address, r.citytown, r.state, r.zip_code].filter(Boolean).join(', '),
    street: r.address || null,
    city: r.citytown || null,
    state: r.state || null,
    zip: r.zip_code || null,
    county: r.countyparish || null,
    phone: r.telephone_number || null,
    type: r.hospital_type || null,
    ownership: r.hospital_ownership || null,
    emergencyServices: r.emergency_services || null,
    // "Not Available" is CMS's placeholder for an unrated hospital.
    rating: r.hospital_overall_rating && /^\d$/.test(r.hospital_overall_rating)
      ? Number(r.hospital_overall_rating)
      : null,
    sourceUrl: datasetUrl(HOSPITAL_ID),
  };
}

/** Full hospital profile for one CCN, or null. */
async function getHospitalByCcn(ccn) {
  if (!ccn) return null;
  const rows = await queryDataset(
    HOSPITAL_ID,
    [{ property: 'facility_id', value: String(ccn) }],
    1,
    'cms-hospital'
  );
  return normalizeHospital(rows[0]);
}

/**
 * Find hospitals by name (SQL LIKE — caller supplies the `%`), optionally
 * narrowed by state. Used by the facility-only path.
 */
async function searchHospitalsByName(name, state) {
  const clean = String(name || '').trim();
  if (clean.length < 3) return [];

  const conditions = [{ property: 'facility_name', value: `${clean}%`, operator: 'like' }];
  if (state) conditions.push({ property: 'state', value: String(state).toUpperCase() });

  const rows = await queryDataset(HOSPITAL_ID, conditions, 10, 'cms-hospital-search');
  return rows.map(normalizeHospital).filter(Boolean);
}

/** Affiliations resolved all the way to hospital profiles, in one call. */
async function getAffiliatedHospitals(npi, max = 3) {
  const affiliations = await getAffiliations(npi);
  const hospitals = [];
  for (const a of affiliations.slice(0, max)) {
    const h = await getHospitalByCcn(a.ccn);
    if (h) hospitals.push({ ...h, affiliationType: a.type });
  }
  return hospitals;
}

module.exports = {
  getAffiliations,
  getHospitalByCcn,
  getAffiliatedHospitals,
  searchHospitalsByName,
  SOURCE_AFFILIATION: 'CMS Facility Affiliation Data',
  SOURCE_HOSPITAL: 'CMS Hospital General Information',
};
