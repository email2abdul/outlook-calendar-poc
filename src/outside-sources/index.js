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

const SOURCES = [nppes];

/** The sources that are usable right now (a key may be missing, a host down). */
function list() {
  return SOURCES.filter((s) => s.enabled !== false);
}

function byId(id) {
  return SOURCES.find((s) => s.id === id) || null;
}

/**
 * Ask every enabled source for one name, in parallel.
 *
 * Sources are independent: one being unreachable must not hide another's
 * answer, so a rejection is reported per source rather than failing the lot.
 *
 * @returns {Promise<{candidates: object[], failures: Array<{source, error}>}>}
 *   candidates carry `externalSource`, newest source order preserved
 */
async function searchByName(query, { limit = 5 } = {}) {
  const sources = list();
  const settled = await Promise.allSettled(
    sources.map((s) => s.searchByName({ ...query, limit }))
  );

  const candidates = [];
  const failures = [];
  settled.forEach((r, i) => {
    const s = sources[i];
    if (r.status === 'fulfilled') {
      for (const c of r.value || []) {
        candidates.push({ externalSource: s.id, externalSourceUrl: s.url, ...c });
      }
    } else {
      // A source that could not be reached is NOT a source that said "no one" —
      // the caller has to be able to tell those apart (see enrichment/health.js).
      failures.push({ source: s.id, name: s.name, error: r.reason?.message || String(r.reason) });
    }
  });

  return { candidates, failures };
}

module.exports = { list, byId, searchByName, SOURCES };
