'use strict';

/**
 * The public sources that answer when Supabase cannot.
 *
 * ADDING A WEBSITE — the whole job:
 *   1. write src/outside-sources/<id>.js exporting the contract below;
 *   2. add it to SOURCES here.
 * Nothing else changes: the ladder, the store, the brief and the UI all work
 * off the shared record shape, so a new source shows up wherever the existing
 * ones do, with its own name and proof link.
 *
 * THE CONTRACT each source module exports:
 *
 *   id            'nppes'                              stable, used in the store
 *   name          'NPPES NPI Registry'                 what a rep sees
 *   url           'https://npiregistry.cms.hhs.gov/…'  the human page
 *   enabled       boolean (optional, default true)     e.g. needs an API key
 *   searchByName({ firstName, lastName, state, city, limit })
 *                 → Promise<Candidate[]>               may be []
 *   getByNpi(npi) → Promise<Candidate|null>            optional
 *
 * A Candidate is the store's own shape (src/outside-physician-store.js FIELDS)
 * so it can be recorded as-is, plus two things:
 *
 *   externalSource / externalSourceUrl   which source, and the page that proves it
 *   extra: { label: value }              intelligence BIS has NO column for —
 *                                        CPT volumes by year, payments,
 *                                        publications. Rendered in the
 *                                        pre-meeting notes tagged as EXTRA and
 *                                        deliberately NOT stored (a separate
 *                                        decision to plan).
 *
 * Every field a source could not establish must be null, never a guess: null is
 * what makes the brief print "Data not available" in that field's own place.
 */

const nppes = require('./nppes');
const cmsService = require('./cms-service');
const score = require('./score');
const taxonomy = require('./taxonomy');

/**
 * ORDER MATTERS: a name is asked of these in this order, and the first one that
 * answers is the answer. CMS's billing data leads because a hit there means the
 * physician actually bills Medicare — the practice, not just the registration —
 * and because NPPES going down must not be able to hide a person CMS holds.
 */
const SOURCES = [cmsService, nppes];

/** The sources that are usable right now (a key may be missing, a host down). */
function list() {
  return SOURCES.filter((s) => s.enabled !== false);
}

/**
 * The sources that can turn a NAME into a person, in the order they are asked.
 *
 * A source opts out with `nameSearchable: false` — nothing does today: CMS's
 * one-row-per-code table is grouped by NPI inside its own module, so it
 * answers a name like any other source.
 */
function nameSearchable() {
  return list().filter((s) => s.nameSearchable !== false && typeof s.searchByName === 'function');
}

function byId(id) {
  return SOURCES.find((s) => s.id === id) || null;
}

const norm = (v) => String(v || '').trim().toLowerCase();

/**
 * Is this candidate the person the meeting named — first name AND last name?
 *
 * Half a name can never be an exact match: "Dr Abernathy" is 46 people in the
 * billing data alone, and calling the first of them exact is how a rep ends up
 * reading somebody else's numbers.
 */
function isExactMatch(candidate, query) {
  const wantFirst = norm(query.firstName);
  const wantLast = norm(query.lastName);
  if (!wantFirst || !wantLast || wantFirst.length < 2) return false;

  const split = score.splitFullName(candidate.name);
  const gotFirst = norm(candidate.firstName) || split.first;
  const gotLast = norm(candidate.lastName) || split.last;
  return gotFirst === wantFirst && gotLast === wantLast;
}

/**
 * One person, however many sources named them.
 *
 * The source that found them FIRST owns the record (CMS, by the order above),
 * and a later source only fills the fields it left null — the same rule
 * profile.js uses when it assembles a brief. The one exception is
 * `taxonomyCode`: CMS states a provider type in words, NPPES states the NUCC
 * code, and the code is what decides whether a brief is produced at all — so a
 * code is always adopted, and the verdict recomputed with it.
 */
function mergeCandidate(first, second) {
  const merged = { ...first };
  for (const [k, v] of Object.entries(second)) {
    if (v === null || v === undefined) continue;
    if (merged[k] === null || merged[k] === undefined) merged[k] = v;
  }
  merged.extra = { ...(second.extra || {}), ...(first.extra || {}) };
  merged.sources = [...new Set([...(first.sources || [first.externalSource]), second.externalSource])];

  if (!first.taxonomyCode && second.taxonomyCode) {
    merged.taxonomyCode = second.taxonomyCode;
    merged.providerKind = taxonomy.classifyCandidate(merged);
  }
  return merged;
}

/**
 * Ask the sources for one name, in order, and stop as soon as one of them has
 * the actual person.
 *
 * Deliberately sequential, and deliberately CMS first — the rep's rule, twice
 * over:
 *
 *   · CMS's billing data is asked first, because a hit there means the
 *     physician actually bills Medicare;
 *   · but CMS only holds Medicare billers, so its answer can be NARROWER than
 *     the registry's — "Ajjarapu" is 2 people in CMS and 3 physicians in
 *     NPPES. So CMS ends the search only when it produced an EXACT match on
 *     the name the meeting gave. Anything less — a shortlist, a surname, a
 *     different first name — and NPPES is asked as well and the two lists are
 *     merged, deduped by NPI.
 *
 * Asking both in parallel (the previous behaviour) is not the same thing: it
 * spent the second lookup even when the first had the answer, and made every
 * NPPES outage a visible failure under a list CMS had already filled.
 *
 * A source that could not be REACHED is not a source that said "nobody": it is
 * recorded as a failure AND the next source is still asked, so an outage costs
 * a rung on the ladder rather than the answer. (See enrichment/health.js.)
 *
 * @returns {Promise<{
 *   candidates: object[], failures: Array<{source, error}>,
 *   answeredBy: string|null, answeredByAll: string[], exact: boolean
 * }>}
 */
async function searchByName(query, { limit = 5 } = {}) {
  const byNpi = new Map(); // NPI (or a synthetic key) → candidate
  const order = []; // keys, in the order they were first seen
  const failures = [];
  const answeredByAll = [];
  let exact = false;

  for (const s of nameSearchable()) {
    let found;
    try {
      found = await s.searchByName({ ...query, limit });
    } catch (err) {
      failures.push({ source: s.id, name: s.name, error: err?.message || String(err) });
      continue;
    }
    if (!found || !found.length) continue;

    answeredByAll.push(s.id);
    for (const raw of found) {
      const c = { externalSource: s.id, externalSourceUrl: s.url, ...raw };
      const key = c.npi || `${s.id}:${norm(c.name)}`;
      if (byNpi.has(key)) {
        byNpi.set(key, mergeCandidate(byNpi.get(key), c));
      } else {
        byNpi.set(key, c);
        order.push(key);
      }
      if (isExactMatch(c, query)) exact = true;
    }

    // The person the meeting named is here — there is nothing left to ask.
    if (exact) break;
  }

  return {
    candidates: order.map((k) => byNpi.get(k)),
    failures,
    answeredBy: answeredByAll[0] || null,
    answeredByAll,
    exact,
  };
}

module.exports = { list, nameSearchable, byId, searchByName, SOURCES, isExactMatch, mergeCandidate };
