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

/**
 * Ask the sources for one name, in order, and stop at the first real answer.
 *
 * Deliberately sequential, and deliberately CMS first — the rep's rule. Asking
 * both in parallel and pooling the results mixed two different registries'
 * people into one shortlist, and made every NPPES outage a visible failure even
 * when CMS had already answered the question.
 *
 * A source that could not be REACHED is not a source that said "nobody": it is
 * recorded as a failure AND the next source is still asked, so an outage costs
 * a rung on the ladder rather than the answer. (See enrichment/health.js.)
 *
 * @returns {Promise<{candidates: object[], failures: Array<{source, error}>, answeredBy: string|null}>}
 */
async function searchByName(query, { limit = 5 } = {}) {
  const candidates = [];
  const failures = [];
  let answeredBy = null;

  for (const s of nameSearchable()) {
    try {
      const found = await s.searchByName({ ...query, limit });
      if (!found || !found.length) continue;
      for (const c of found) {
        candidates.push({ externalSource: s.id, externalSourceUrl: s.url, ...c });
      }
      answeredBy = s.id;
      break;
    } catch (err) {
      failures.push({ source: s.id, name: s.name, error: err?.message || String(err) });
    }
  }

  return { candidates, failures, answeredBy };
}

module.exports = { list, nameSearchable, byId, searchByName, SOURCES };
