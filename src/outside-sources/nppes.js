'use strict';

const registry = require('../enrichment/sources/nppes');
const states = require('../enrichment/states');
const territory = require('../territory');

/**
 * NPPES NPI Registry — the first outside source, and the one that can turn a
 * name into an NPI. Free, no key, authoritative for practice location.
 *
 * A thin adapter, on purpose: the HTTP client, retry and wildcard rules already
 * live in src/enrichment/sources/nppes.js (including "a one-character wildcard
 * is rejected by the API"). This file only maps that module's output into the
 * shared record shape, so the store, the brief and the UI need to know nothing
 * about NPPES.
 *
 * What it CANNOT give is an email — the registry has no such field — so
 * `email` stays null and the brief says "Data not available" rather than
 * inventing one.
 */

const ID = 'nppes';
const NAME = registry.SOURCE_NAME; // 'NPPES NPI Registry'
const URL = 'https://npiregistry.cms.hhs.gov/search';

/** One NPPES provider → the store's shape (+ the extras BIS has no column for). */
function toCandidate(p) {
  if (!p) return null;
  return {
    // ── mirror of what Supabase would hold ──────────────────────────────────
    npi: p.npi || null,
    name: p.name || null,
    specialty: p.specialty || null,
    email: null, // NPPES has no email field at all
    phone: p.phone || null,
    esdProcedure: null, // unknown, NOT false
    photoUrl: null,
    linkedinUrl: null,

    facilityId: null, // no BIS facility unless a re-match finds one
    facilityName: null,
    facilityType: null,
    facilityAddress: p.address || null,
    city: p.city || null,
    state: p.state || null,
    zip: p.zip || null,
    healthSystem: null,
    territory: territory.resolveTerritory(states.toName(p.state)) || null,

    inBis: false,
    externalSource: ID,
    externalSourceUrl: p.sourceUrl || URL,

    // ── EXTRA: no BIS column exists for these. Shown in the pre-meeting notes
    //    tagged as extra; not stored (see outside-sources/index.js).
    extra: {
      credential: p.credential || null,
      licenseNumber: p.license || null,
      licenseState: p.licenseState || null,
      npiEnumerated: p.enumerationDate || null,
      npiStatus: p.status || null,
      taxonomies: (p.taxonomies || []).map((t) => t.desc).filter(Boolean),
    },
  };
}

/**
 * Providers matching a name, best-effort narrowed by state/city.
 *
 * The registry matches on last name (+ first name when it is more than an
 * initial), so the city filter is applied here rather than sent — NPPES has no
 * city parameter that behaves usefully on a partial.
 */
async function searchByName({ firstName, lastName, state, city, limit = 5 } = {}) {
  if (!lastName) return [];

  const hits = await registry.searchIndividuals({
    lastName,
    // A single initial is rejected by the API, so only send a real first name.
    firstName: firstName && firstName.replace(/[.]/g, '').length > 1 ? firstName : undefined,
    state: states.toCode(state),
    limit: 20,
  });

  const wanted = String(city || '').trim().toLowerCase();
  const narrowed = wanted ? hits.filter((h) => (h.city || '').toLowerCase() === wanted) : hits;

  // Fall back to the unnarrowed list rather than returning nothing: a wrong
  // city hint should cost ranking, not the whole answer.
  return (narrowed.length ? narrowed : hits).slice(0, limit).map(toCandidate).filter(Boolean);
}

/** One provider by NPI, or null. */
async function getByNpi(npi) {
  return toCandidate(await registry.getByNpi(npi));
}

module.exports = { id: ID, name: NAME, url: URL, searchByName, getByNpi, toCandidate };
