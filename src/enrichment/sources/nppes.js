'use strict';

const { getJson, buildUrl } = require('../http');

/**
 * NPPES NPI Registry — the authoritative US provider directory (CMS).
 *
 * Free, no API key, no rate-limit documented. This is the tier that turns a
 * name into a canonical **NPI**, which matters more than the profile fields it
 * returns: NPI is this app's primary key everywhere (routes, app_activities,
 * notes, app_email_intel), so resolving one is what lets an "unknown" attendee
 * be looked up in bis_* at all.
 *
 * Individuals are NPI-1, organisations (hospitals, practices) NPI-2.
 *
 * Verified live 2026-08-18: `last_name=Shaheen&first_name=Nicholas&state=NC`
 * → NPI 1467521757, taxonomy "Internal Medicine, Gastroenterology",
 * 101 Manning Dr, Chapel Hill NC. Note the same query returned 0 results once
 * and 1 moments later, hence `retryIfEmpty` below.
 */

const API = 'https://npiregistry.cms.hhs.gov/api/';
const VERSION = '2.1';

/** Public provider page a human can open to verify a claim. */
function providerUrl(npi) {
  return `https://npiregistry.cms.hhs.gov/provider-view/${npi}`;
}

function addressOf(result, purpose) {
  return (result.addresses || []).find((a) => a.address_purpose === purpose) || null;
}

function formatAddress(a) {
  if (!a) return null;
  return [a.address_1, a.address_2, a.city, a.state, (a.postal_code || '').slice(0, 5)]
    .filter(Boolean)
    .join(', ');
}

/** NPPES result → the flat shape the rest of the enrichment code expects. */
function normalizeIndividual(r) {
  const basic = r.basic || {};
  const location = addressOf(r, 'LOCATION') || addressOf(r, 'MAILING');
  const taxonomies = (r.taxonomies || []).map((t) => ({
    code: t.code,
    desc: t.desc,
    primary: Boolean(t.primary),
    license: t.license || null,
    state: t.state || null,
  }));
  const primary = taxonomies.find((t) => t.primary) || taxonomies[0] || null;

  return {
    npi: String(r.number),
    firstName: basic.first_name || null,
    middleName: basic.middle_name || null,
    lastName: basic.last_name || null,
    name: [basic.first_name, basic.middle_name, basic.last_name].filter(Boolean).join(' ') || null,
    credential: basic.credential || null,
    // NPPES writes "--" for absent prefix/suffix; treat as absent.
    prefix: basic.name_prefix && basic.name_prefix !== '--' ? basic.name_prefix : null,
    gender: basic.sex || null,
    status: basic.status || null, // "A" = active
    soleProprietor: basic.sole_proprietor || null,
    enumerationDate: basic.enumeration_date || null,
    lastUpdated: basic.last_updated || null,
    specialty: primary ? primary.desc : null,
    taxonomies,
    license: primary ? primary.license : null,
    licenseState: primary ? primary.state : null,
    address: formatAddress(location),
    city: location ? location.city : null,
    state: location ? location.state : null,
    zip: location ? (location.postal_code || '').slice(0, 5) : null,
    phone: location ? location.telephone_number || null : null,
    fax: location ? location.fax_number || null : null,
    sourceUrl: providerUrl(r.number),
  };
}

/** NPI-2 (organisation) result → flat shape. */
function normalizeOrganization(r) {
  const basic = r.basic || {};
  const location = addressOf(r, 'LOCATION') || addressOf(r, 'MAILING');
  const primary = (r.taxonomies || []).find((t) => t.primary) || (r.taxonomies || [])[0] || null;
  return {
    npi: String(r.number),
    name: basic.organization_name || null,
    authorizedOfficial:
      [basic.authorized_official_first_name, basic.authorized_official_last_name]
        .filter(Boolean)
        .join(' ') || null,
    type: primary ? primary.desc : null,
    status: basic.status || null,
    address: formatAddress(location),
    city: location ? location.city : null,
    state: location ? location.state : null,
    zip: location ? (location.postal_code || '').slice(0, 5) : null,
    phone: location ? location.telephone_number || null : null,
    sourceUrl: providerUrl(r.number),
  };
}

const isEmptyResult = (body) => !body || body.result_count === 0 || !(body.results || []).length;

/**
 * NPPES reports validation problems as HTTP 200 with an `Errors` array
 * (e.g. "Wildcards require at least two leading characters"). Those never
 * succeed on a retry, so surface them once and stop.
 */
function rejectedByApi(body, label) {
  const errors = body?.Errors;
  if (!Array.isArray(errors) || !errors.length) return false;
  console.warn(
    `[enrichment:${label}] NPPES rejected the query: ` +
      errors.map((e) => `${e.field || '?'}: ${e.description}`).join('; ')
  );
  return true;
}

/**
 * Search individual providers (NPI-1).
 *
 * NPPES needs at least one NAME — a bare `state` is rejected — but EITHER half
 * will do: `first_name=KATIE&state=CA` returns results (verified 2026-09-01),
 * which is what makes a meeting that only says "Dr Katie" searchable at all.
 * A last name is still much better: it is the field the registry indexes, and a
 * first name alone returns strangers who merely share it.
 *
 * @param {object} q
 * @param {string} [q.lastName]  either this or firstName is required
 * @param {string} [q.firstName] may be a single initial — see below
 * @param {string} [q.state]     2-letter code
 * @param {string} [q.city]
 * @param {number} [q.limit=20]
 * @returns {Promise<object[]>} normalized providers, empty on any failure
 */
async function searchIndividuals(q = {}) {
  const lastName = (q.lastName || '').trim();
  const firstName = (q.firstName || '').trim();

  // NPPES rejects a one-character wildcard ("Wildcards require at least two
  // leading characters", verified 2026-08-18), and a bare initial is not a
  // valid exact first name either. So an initial is NOT sent to the API — the
  // caller keeps it as a hint and ranks the returned surname matches on it.
  const sendLastName = lastName.length >= 2 ? lastName : null;
  const sendFirstName = firstName.length >= 2 ? firstName : null;
  if (!sendLastName && !sendFirstName) return [];

  const url = buildUrl(API, {
    version: VERSION,
    enumeration_type: 'NPI-1',
    last_name: sendLastName,
    first_name: sendFirstName,
    state: q.state || null,
    city: q.city || null,
    limit: q.limit || 20,
  });

  const res = await getJson(url, { label: 'nppes', retryIfEmpty: isEmptyResult });
  if (!res.ok || !res.body || rejectedByApi(res.body, 'nppes')) return [];

  // NPPES name search is fuzzy — a `last_name=Shaheen` query genuinely returns
  // people called Williams and Decker (verified 2026-08-18), presumably via
  // other-name and authorized-official fields. Left in, those become
  // confident-looking wrong answers, so whichever half we searched on is
  // enforced here.
  const field = sendLastName ? 'lastName' : 'firstName';
  const wanted = (sendLastName || sendFirstName).toLowerCase();
  return (res.body.results || [])
    .map(normalizeIndividual)
    .filter((r) => {
      const got = (r[field] || '').toLowerCase();
      if (!got) return false;
      // Tolerate hyphenated / married-name variants in either direction.
      return got === wanted || got.startsWith(wanted) || wanted.startsWith(got);
    });
}

/** Exact lookup by NPI. Returns one normalized provider, or null. */
async function getByNpi(npi) {
  const clean = String(npi || '').replace(/\D/g, '');
  if (clean.length !== 10) return null;

  const url = buildUrl(API, { version: VERSION, number: clean });
  const res = await getJson(url, { label: 'nppes', retryIfEmpty: isEmptyResult });
  if (!res.ok || !res.body || rejectedByApi(res.body, 'nppes')) return null;

  const hit = (res.body.results || [])[0];
  if (!hit) return null;
  return hit.enumeration_type === 'NPI-2' ? normalizeOrganization(hit) : normalizeIndividual(hit);
}

/**
 * Search organisations (NPI-2) — hospitals, group practices, ASCs. Used by the
 * facility-only path when the attendee is a generic mailbox rather than a person.
 *
 * @param {object} q
 * @param {string} q.name   organisation name; a trailing `*` wildcard is allowed
 * @param {string} [q.state]
 */
async function searchOrganizations(q = {}) {
  const name = (q.name || '').trim();
  if (name.length < 3) return [];

  const url = buildUrl(API, {
    version: VERSION,
    enumeration_type: 'NPI-2',
    organization_name: name,
    state: q.state || null,
    city: q.city || null,
    limit: q.limit || 10,
  });

  const res = await getJson(url, { label: 'nppes-org', retryIfEmpty: isEmptyResult });
  if (!res.ok || !res.body || rejectedByApi(res.body, 'nppes-org')) return [];
  return (res.body.results || []).map(normalizeOrganization);
}

module.exports = {
  searchIndividuals,
  searchOrganizations,
  getByNpi,
  providerUrl,
  SOURCE_NAME: 'NPPES NPI Registry',
};
