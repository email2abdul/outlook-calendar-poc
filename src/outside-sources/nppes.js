'use strict';

const registry = require('../enrichment/sources/nppes');
const health = require('../enrichment/health');
const taxonomy = require('./taxonomy');
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
 *
 * And it throws when the registry could not be REACHED, instead of returning an
 * empty list. Those two are different answers — "no provider by that name" vs
 * "this host cannot resolve npiregistry.cms.hhs.gov right now" — and the flat
 * list the underlying module returns cannot tell them apart, so the health
 * ledger is read here and the caller is told which one happened.
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
    // Not store columns — they are what the scorer compares against, and what
    // lets the UI ask for "the missing first name" by name.
    firstName: p.firstName || null,
    lastName: p.lastName || null,
    specialty: p.specialty || null,
    // The registry's PRIMARY taxonomy, promoted to its own field: with five
    // same-named candidates on screen it is the line that tells a rep which one
    // is the gastroenterologist they are meeting.
    primaryTaxonomy: p.specialty || null,
    // …and its NUCC code, which is what decides whether a brief is produced at
    // all. The code is structured and stable; the words are neither ("Physician
    // Assistant" is not a physician). See ./taxonomy.js.
    taxonomyCode: (p.taxonomies || []).find((t) => t.primary)?.code || (p.taxonomies || [])[0]?.code || null,
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
    providerKind: taxonomy.classify({
      code: (p.taxonomies || []).find((t) => t.primary)?.code || null,
      desc: p.specialty || null,
    }),

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
/** Throw if the registry never answered during this ledger run. */
function assertReached(what) {
  const blind = health.blindFor('nppes', 'nppes-org');
  if (!blind.length) return;
  const err = new Error(health.describe(blind[0], NAME));
  err.unreachable = true;
  err.kind = blind[0].kind; // dns | network | timeout | tls | upstream
  err.what = what;
  throw err;
}

async function searchByName({ firstName, lastName, state, city, limit = 5 } = {}) {
  // Either half is searchable, though a first name alone returns strangers who
  // merely share it — which is why the scorer scores it low and the notes ask
  // for the rest of the name.
  if (!lastName && !(firstName && firstName.replace(/[.]/g, '').length > 1)) return [];

  return health.run(async () => {
    // A single initial is rejected by the API, so only send a real first name.
    const sendFirst = firstName && firstName.replace(/[.]/g, '').length > 1 ? firstName : undefined;
    const query = { lastName, firstName: sendFirst, limit: 20 };

    let hits = await registry.searchIndividuals({ ...query, state: states.toCode(state) });

    // A STATE hint is a guess about where the meeting is, and a guess must not
    // be able to delete the answer: a description reading "Internal Medicine
    // from CHICAGO" was mis-read as a facility in California, whose state then
    // filtered every real candidate out of the registry (found 2026-09-02). So
    // a filtered search that finds nobody is retried unfiltered, and the hint
    // goes back to doing what it should — ranking, in score.js.
    if (!hits.length && states.toCode(state)) {
      hits = await registry.searchIndividuals(query);
    }

    // An empty list from an unreachable host is not an empty registry.
    if (!hits.length) assertReached('search');

    const wanted = String(city || '').trim().toLowerCase();
    const narrowed = wanted ? hits.filter((h) => (h.city || '').toLowerCase() === wanted) : hits;

    // Fall back to the unnarrowed list rather than returning nothing: a wrong
    // city hint should cost ranking, not the whole answer.
    return (narrowed.length ? narrowed : hits).slice(0, limit).map(toCandidate).filter(Boolean);
  });
}

/** One provider by NPI, or null. Throws when the registry was unreachable. */
async function getByNpi(npi) {
  return health.run(async () => {
    const p = await registry.getByNpi(npi);
    if (!p) assertReached('lookup');
    return toCandidate(p);
  });
}

module.exports = { id: ID, name: NAME, url: URL, searchByName, getByNpi, toCandidate };
