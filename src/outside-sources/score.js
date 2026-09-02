'use strict';

const states = require('../enrichment/states');
const taxonomy = require('./taxonomy');

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

/**
 * Below this a candidate is not even offered.
 *
 * Nine people share a surname; listing all nine at 55% teaches a rep to click
 * through noise. So only the ones a meeting's own details actually support are
 * shown, and when nothing clears this bar the answer is the ASK — add the first
 * name, the taxonomy, the city — not a longer list.
 */
const CONFIDENCE_OFFER = 60;

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
 * @param {object} candidate  a source candidate (name/firstName/lastName/city/state/
 *                            primaryTaxonomy/facilityAddress/zip/phone)
 * @param {object} wanted     what the meeting said: { firstName, lastName, city,
 *                            state, taxonomy, address, zip, phone }
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

  // The meeting's own words, searched for the CANDIDATE's values rather than the
  // other way round. Extracting "the taxonomy" or "the city" from a free-text
  // description is a guessing game; asking "does this meeting mention
  // 'Internal Medicine'? does it mention 'CHICAGO'?" is not, and it is exactly
  // how a rep disambiguates by hand.
  const text = norm(wanted.text);
  const mentions = (value, minWordLength = 5) => {
    const v = norm(value);
    if (!text || !v) return false;
    if (text.includes(v)) return true;
    const head = v.split(/[\s,]+/)[0];
    return head.length >= minWordLength && new RegExp(`\\b${head}\\b`).test(text);
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

  // ── The details that actually separate same-named providers ───────────────
  // A surname alone cannot clear the bar; a surname plus "Dentist", or plus a
  // street, can — because only one of nine Aagaards is a dentist. These are the
  // fields NPPES prints next to the name, so they are the ones a rep can copy
  // into the meeting to get an exact answer.

  // A place the meeting NAMES, credited the same way a taxonomy is. "Internal
  // Medicine from CHICAGO" in a description is a rep telling us which of two
  // same-named physicians they mean, and it was going unread: the city only
  // scored when the entity matcher had already turned it into a hint.
  if (!want.city && candidate.city && mentions(candidate.city, 4)) {
    score += 15;
    reasons.push('the meeting mentions this city');
  }
  if (!want.state && candidate.state && new RegExp(`\\b${norm(candidate.state)}\\b`).test(text)) {
    score += 10;
    reasons.push('the meeting mentions this state');
  }

  const wantTax = norm(wanted.taxonomy);
  const gotTax = norm(candidate.primaryTaxonomy || candidate.specialty);
  if (!wantTax && gotTax && mentions(gotTax)) {
    score += 20;
    reasons.push('the meeting mentions this taxonomy');
  }
  if (wantTax && gotTax) {
    if (wantTax === gotTax) {
      score += 25;
      reasons.push('primary taxonomy matches exactly');
    } else if (gotTax.includes(wantTax) || wantTax.includes(gotTax)) {
      // "Counselor" against "Counselor, Mental Health" — the registry qualifies
      // a taxonomy that a rep would write plainly.
      score += 20;
      reasons.push('primary taxonomy matches');
    } else {
      score -= 15;
      reasons.push('primary taxonomy differs');
    }
  }

  const zip5 = (v) => String(v || '').replace(/\D/g, '').slice(0, 5);
  if (zip5(wanted.zip) && zip5(candidate.zip) && zip5(wanted.zip) === zip5(candidate.zip)) {
    score += 20;
    reasons.push('ZIP matches');
  } else if (!wanted.zip && zip5(candidate.zip) && String(wanted.text || '').includes(zip5(candidate.zip))) {
    score += 20;
    reasons.push('the meeting mentions this ZIP');
  }

  // Street, not the whole line: the registry writes "200 CASENTINI ST" where a
  // rep may have typed the city and state after it.
  const street = (v) => norm(String(v || '').split(',')[0]);
  if (street(wanted.address) && street(candidate.facilityAddress)) {
    const a = street(wanted.address);
    const b = street(candidate.facilityAddress);
    if (a === b || b.startsWith(a) || a.startsWith(b)) {
      score += 20;
      reasons.push('practice address matches');
    }
  } else if (!wanted.address && street(candidate.facilityAddress) && mentions(street(candidate.facilityAddress), 99)) {
    // The whole street line has to appear — a lone house number would match
    // half the registry.
    score += 20;
    reasons.push('the meeting mentions this practice address');
  }

  const digits = (v) => String(v || '').replace(/\D/g, '').slice(-10);
  if (digits(wanted.phone).length === 10 && digits(wanted.phone) === digits(candidate.phone)) {
    score += 20;
    reasons.push('phone matches');
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
      // Classified, never scored down: whether someone is a doctor has nothing
      // to do with whether they are the RIGHT person, and mixing the two would
      // make a social worker look like a weak identity match rather than a
      // confident identification of somebody a rep does not brief.
      const kind = c.providerKind || taxonomy.classifyCandidate(c);
      return { ...c, confidence, matchReasons: reasons, providerKind: kind };
    })
    .sort((a, b) => b.confidence - a.confidence);

  // A registry name search returns whoever holds an NPI. When it has produced
  // even one doctor, the rest are not who the rep is meeting, so they are not
  // offered — but they are counted, and the caller says what they were.
  const doctors = ranked.filter((c) => c.providerKind.kind !== 'not_doctor');
  const refused = ranked.filter((c) => c.providerKind.kind === 'not_doctor');
  const eligible = doctors.length ? doctors : [];

  const best = eligible[0] || null;
  const runnerUp = eligible[1] || null;
  const ambiguous = Boolean(
    best && runnerUp && best.confidence - runnerUp.confidence < AMBIGUOUS_MARGIN
  );

  const primary = best && best.confidence >= CONFIDENCE_SHOW && !ambiguous ? best : null;
  const offered = eligible.filter((c) => c.confidence >= CONFIDENCE_OFFER);
  return {
    // Everything, scored — callers that need the full picture (diagnostics) can
    // still see it.
    ranked,
    // Whoever the registry returned who is not a doctor: not offered, but named
    // so the panel can say "3 further matches are a social worker, a case
    // manager and a behaviour technician" instead of going quiet.
    refused,
    // Set when the ONLY thing the registry found is somebody a rep does not
    // brief — the caller shows a plain statement of what they are instead.
    notDoctor: !doctors.length && refused.length ? refused[0] : null,
    // What a rep should be shown: nothing under the offer bar, at most a
    // handful, best first.
    offered: offered.slice(0, opts.max || 5),
    // Only the ELIGIBLE ones the confidence bar held back. Counting the
    // non-doctors here too would report the same person twice — once as "under
    // the bar" and once as "not a physician" — and the two numbers would not
    // add up to what the registry returned.
    dropped: eligible.length - offered.length,
    primary,
    ambiguous,
    cleared: ranked.filter((c) => c.confidence >= CONFIDENCE_SHOW).length,
  };
}

module.exports = {
  scoreCandidate,
  rankCandidates,
  splitFullName,
  CONFIDENCE_SHOW,
  CONFIDENCE_OFFER,
  AMBIGUOUS_MARGIN,
};
