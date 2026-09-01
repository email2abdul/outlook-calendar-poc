'use strict';

const states = require('../enrichment/states');

/**
 * How sure are we that THIS candidate is the physician on the meeting?
 *
 * Two registries can hand back six people who share a surname. The rep needs a
 * number they can act on, not a list: one candidate clearing the bar gets their
 * notes rendered, everyone else waits behind a click. So every candidate is
 * scored against what the MEETING actually said — the name the rep typed, the
 * city or state the title/description mentions — and the reasons are kept, so
 * "82%" can be shown as "82% — first name, last name and state match" rather
 * than as an unexplained number.
 *
 * The bar is 70. Below it a candidate is a suggestion the rep opens on purpose;
 * at or above it the data is put in front of them. That threshold is the rep's
 * own rule and the reason a wrong physician's volumes are not shown as fact.
 *
 * Deliberately NOT the enrichment cascade's scorer (enrichment/index.js
 * pickBestProvider): that one ranks NPPES hits while resolving an opaque email
 * address, with a paid web identity in the mix. This one ranks candidates from
 * any registered source against a name and a place, and its output is shown to
 * a person.
 */

/** At or above this, a candidate's data is shown rather than offered. */
const CONFIDENCE_SHOW = 70;

/** A second candidate this close to the best means we cannot tell them apart. */
const AMBIGUOUS_MARGIN = 10;

const norm = (v) =>
  String(v || '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, '')
    .trim();

/** "John R Abernathy" → { first: 'john', last: 'abernathy' } */
function splitFullName(name) {
  const parts = norm(name).split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  if (parts.length === 1) return { first: '', last: parts[0] };
  return { first: parts[0], last: parts[parts.length - 1] };
}

/**
 * Score one candidate.
 *
 * @param {object} candidate  a source candidate (name/firstName/lastName/city/state)
 * @param {object} wanted     what the meeting said: { firstName, lastName, city, state }
 * @param {object} [opts]
 * @param {number} [opts.total=1]      how many candidates came back at all
 * @param {boolean} [opts.confirmed]   a second source agrees on this NPI's identity
 * @returns {{confidence: number, reasons: string[]}}
 */
function scoreCandidate(candidate, wanted = {}, opts = {}) {
  const reasons = [];
  let score = 30; // a registry listed them at all

  const got = {
    first: norm(candidate.firstName) || splitFullName(candidate.name).first,
    last: norm(candidate.lastName) || splitFullName(candidate.name).last,
  };
  const want = {
    first: norm(wanted.firstName),
    last: norm(wanted.lastName),
    // Kept as given: sameState() understands both "TX" and "Texas", and
    // norm() would not help it.
    city: wanted.city || null,
    state: wanted.state || null,
  };

  if (want.last && got.last) {
    if (want.last === got.last) {
      score += 25;
      reasons.push('last name matches');
    } else {
      // The search was by surname, so this should not happen — when it does,
      // the candidate is not who was asked for.
      score -= 30;
      reasons.push('last name differs');
    }
  }

  if (want.first && got.first) {
    if (want.first === got.first) {
      score += 30;
      reasons.push('first name matches');
    } else if (want.first.length === 1) {
      // An initial is a prefix, but it is worth much less than a name: dozens of
      // physicians share a surname and an initial. Checked before the prefix
      // branch so the reason says which one it actually was.
      if (got.first[0] === want.first) {
        score += 10;
        reasons.push('first initial matches');
      } else {
        score -= 25;
        reasons.push('first initial differs');
      }
    } else if (got.first.startsWith(want.first) || want.first.startsWith(got.first)) {
      score += 15;
      reasons.push('first name is a partial match');
    } else {
      score -= 25;
      reasons.push('first name differs');
    }
  } else if (!want.first) {
    // The meeting never gave a first name, so nothing here can separate two
    // people who share the surname. Say so — it is why the tag asking for the
    // full name exists.
    reasons.push('no first name on the meeting to check against');
  }

  if (want.state && candidate.state && states.sameState(want.state, candidate.state)) {
    score += 15;
    reasons.push('state matches the meeting');
  }
  if (want.city && candidate.city && norm(want.city) === norm(candidate.city)) {
    score += 15;
    reasons.push('city matches the meeting');
  }

  if (opts.total === 1) {
    score += 10;
    reasons.push('the only candidate any source returned');
  }
  if (opts.confirmed) {
    score += 10;
    reasons.push('a second source confirms this identity');
  }

  return { confidence: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

/**
 * Score a list and decide what to show.
 *
 * `primary` is the candidate whose data is rendered: the best one, at or above
 * the bar, and clearly ahead of the runner-up. Two candidates neck and neck
 * means we cannot tell them apart, and showing one of them as the answer would
 * be a guess dressed as a fact — so nothing is auto-shown and both are options.
 *
 * @returns {{ranked: object[], primary: object|null, ambiguous: boolean, cleared: number}}
 */
function rankCandidates(candidates, wanted = {}, opts = {}) {
  const total = candidates.length;
  const ranked = candidates
    .map((c) => {
      const { confidence, reasons } = scoreCandidate(c, wanted, { ...opts, total });
      return { ...c, confidence, matchReasons: reasons };
    })
    .sort((a, b) => b.confidence - a.confidence);

  const best = ranked[0] || null;
  const runnerUp = ranked[1] || null;
  const ambiguous = Boolean(
    best && runnerUp && best.confidence - runnerUp.confidence < AMBIGUOUS_MARGIN
  );

  const primary = best && best.confidence >= CONFIDENCE_SHOW && !ambiguous ? best : null;
  return {
    ranked,
    primary,
    ambiguous,
    cleared: ranked.filter((c) => c.confidence >= CONFIDENCE_SHOW).length,
  };
}

module.exports = { scoreCandidate, rankCandidates, splitFullName, CONFIDENCE_SHOW, AMBIGUOUS_MARGIN };
