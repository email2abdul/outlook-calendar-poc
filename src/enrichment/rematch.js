'use strict';

const physicians = require('../physicians');
const states = require('./states');

/**
 * Re-matching — pulling the maximum out of the BIS master before and after
 * going outside.
 *
 * The premise, proved live on 2026-08-18 (docs/external-enrichment-agent.md §3):
 * an email miss is NOT a physician miss.
 *
 *   - The physician may sit in bis_physicians under a different address, and is
 *     found the moment NPPES gives us their NPI.
 *   - Even when the physician is genuinely absent, their FACILITY is often
 *     present — which unlocks the existing facility volumes, colleagues,
 *     territory, health-system and product-fit logic. Nicholas Shaheen is not in
 *     bis_physicians, but "UNC Hospitals Chapel Hill North Carolina"
 *     (HSOP105211) is, with six GI colleagues and CPT volumes attached.
 *
 * Everything here reads the in-memory directory built at boot by
 * src/physicians.js — no network, no Supabase round-trip, no cost.
 */

// ── Facility name matching ──────────────────────────────────────────────────

/**
 * Words that carry no identifying signal in a facility name. Matching on these
 * is exactly how a naive `ilike` matched "UNC HOSPITALS" to "ChristianaCare
 * Hospitals Newark Delaware" during research — the shared word was "hospitals".
 */
const GENERIC_TOKENS = new Set([
  'hospital', 'hospitals', 'medical', 'medicine', 'center', 'centre', 'centers',
  'clinic', 'clinics', 'health', 'healthcare', 'care', 'system', 'systems',
  'regional', 'community', 'memorial', 'general', 'university', 'institute',
  'associates', 'association', 'group', 'practice', 'partners', 'physicians',
  'surgical', 'surgery', 'ambulatory', 'endoscopy', 'specialty', 'specialists',
  'the', 'and', 'for', 'of', 'at', 'saint', 'st', 'inc', 'llc', 'llp', 'pa',
  'pc', 'pllc', 'ltd', 'co', 'corp', 'dba',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Distinctive tokens of a facility name.
 *
 * bis_facilities names embed their own city and state — "UNC Hospitals Chapel
 * Hill North Carolina" — so those tokens must be stripped before comparison, or
 * every facility in a city looks alike.
 */
function distinctiveTokens(name, city, state) {
  const drop = new Set(GENERIC_TOKENS);
  for (const t of tokenize(city)) drop.add(t);
  for (const t of tokenize(state)) drop.add(t);
  for (const t of tokenize(states.toName(state))) drop.add(t);
  return tokenize(name).filter((t) => t.length >= 2 && !drop.has(t));
}

/**
 * Name tokens with only the geography removed — generic words KEPT.
 *
 * Distinctive tokens alone cannot separate "UNC Hospitals" from "UNC Medical
 * Center": both reduce to ["unc"] and tie at 1.0, so the winner came down to
 * iteration order. Keeping "hospitals" / "medical" / "center" as a secondary,
 * lower-weighted signal breaks that tie correctly.
 */
function nameTokens(name, city, state) {
  const drop = new Set();
  for (const t of tokenize(city)) drop.add(t);
  for (const t of tokenize(state)) drop.add(t);
  for (const t of tokenize(states.toName(state))) drop.add(t);
  return tokenize(name).filter((t) => t.length >= 2 && !drop.has(t));
}

/** Sørensen–Dice over token sets: 0..1. */
function diceScore(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const shared = [...new Set(a)].filter((t) => setB.has(t));
  return (2 * shared.length) / (new Set(a).size + new Set(b).size);
}

/**
 * Find the bis_facilities row for an externally-sourced facility.
 *
 * Geography is a GATE, not a score component: a same-name facility in another
 * city is a different facility, and letting name similarity outvote a city
 * mismatch is precisely the failure mode documented in the design doc.
 *
 * @param {object} q
 * @param {string} q.name   facility name from CMS / NPPES / the web
 * @param {string} [q.city]
 * @param {string} [q.state] code or full name
 * @param {number} [q.minScore=0.4]
 * @returns {{facility:object, score:number, reason:string}|null}
 */
function matchFacility(q = {}) {
  const name = (q.name || '').trim();
  if (!name) return null;

  const city = (q.city || '').trim().toLowerCase();
  const stateCode = states.toCode(q.state);
  const minScore = Number.isFinite(q.minScore) ? q.minScore : 0.4;

  const queryTokens = distinctiveTokens(name, city, stateCode);
  if (!queryTokens.length) return null; // nothing but generic words to match on
  const queryFull = nameTokens(name, city, stateCode);

  let best = null;
  for (const f of physicians.getAllFacilities()) {
    // Gate on geography first — cheap, and it removes the false positives.
    if (city) {
      if (!f.city || f.city.toLowerCase() !== city) continue;
    } else if (stateCode) {
      if (!states.sameState(f.state, stateCode)) continue;
    }

    const candidateTokens = distinctiveTokens(f.name, f.city, f.state);
    if (!candidateTokens.length) continue;

    // Distinctive tokens decide; the full name breaks ties between facilities
    // that share a brand but not a type ("UNC Hospitals" vs "UNC Medical Center").
    const score =
      0.7 * diceScore(queryTokens, candidateTokens) +
      0.3 * diceScore(queryFull, nameTokens(f.name, f.city, f.state));

    if (score > (best?.score ?? 0)) {
      best = { facility: f, score };
    }
  }

  if (!best || best.score < minScore) return null;
  return {
    facility: best.facility,
    score: Number(best.score.toFixed(3)),
    reason: city
      ? `name + city match (${best.facility.city})`
      : `name + state match (${best.facility.state})`,
  };
}

// ── Email → facility, via the domain index ──────────────────────────────────

/**
 * Consumer mailbox providers. bis_physicians genuinely contains gmail/hotmail
 * addresses, so without this list the index would map "gmail.com" to whichever
 * facility happened to appear most — a confident, wrong answer.
 */
const CONSUMER_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com',
  'me.com', 'mac.com', 'protonmail.com', 'proton.me', 'gmx.com', 'mail.com',
  'zoho.com', 'yandex.com', 'comcast.net', 'verizon.net', 'att.net', 'cox.net',
  'charter.net', 'sbcglobal.net', 'bellsouth.net', 'earthlink.net', 'juno.com',
]);

let domainIndex = null; // Map<domain, { facilityId, count, total, share }>

/**
 * Build domain → facility from the emails already in bis_physicians.
 *
 * Free and surprisingly strong: all six @unch.unc.edu physicians map to the
 * single facility HSOP105211. Built once, lazily, from the in-memory directory.
 */
function buildDomainIndex() {
  const byDomain = new Map(); // domain → Map<facilityId, count>

  for (const p of physicians.getAllPhysicians()) {
    if (!p.email || !p.facility?.id) continue;
    const domain = String(p.email).toLowerCase().split('@')[1];
    if (!domain || CONSUMER_DOMAINS.has(domain)) continue;

    if (!byDomain.has(domain)) byDomain.set(domain, new Map());
    const counts = byDomain.get(domain);
    counts.set(p.facility.id, (counts.get(p.facility.id) || 0) + 1);
  }

  domainIndex = new Map();
  for (const [domain, counts] of byDomain) {
    let top = null;
    let total = 0;
    for (const [facilityId, count] of counts) {
      total += count;
      if (!top || count > top.count) top = { facilityId, count };
    }
    // Only index a domain when one facility clearly dominates it.
    const share = top.count / total;
    if (share >= 0.6) {
      domainIndex.set(domain, { ...top, total, share: Number(share.toFixed(2)) });
    }
  }
  return domainIndex;
}

/**
 * Facility implied by an email domain.
 * @returns {{facility:object, count:number, share:number, confidence:number}|null}
 */
function facilityFromDomain(email) {
  const domain = String(email || '').toLowerCase().split('@')[1];
  if (!domain || CONSUMER_DOMAINS.has(domain)) return null;

  if (!domainIndex) buildDomainIndex();
  const hit = domainIndex.get(domain);
  if (!hit) return null;

  const facility = physicians.getFacilityById(hit.facilityId);
  if (!facility) return null;

  return {
    facility,
    count: hit.count,
    share: hit.share,
    // One colleague on the same domain is a hint; several is close to proof.
    confidence: hit.count >= 3 ? 90 : hit.count === 2 ? 75 : 55,
  };
}

// ── Email → name hints ──────────────────────────────────────────────────────

/** Mailboxes that belong to an organisation, not a person. */
const GENERIC_MAILBOXES = new Set([
  'info', 'admin', 'office', 'contact', 'hello', 'help', 'support', 'billing',
  'scheduling', 'schedule', 'appointments', 'frontdesk', 'reception', 'referrals',
  'noreply', 'no-reply', 'donotreply', 'mail', 'team', 'sales', 'marketing',
  'hr', 'careers', 'practice', 'clinic', 'reply', 'notifications',
]);

/**
 * Guess a person's name from an email local-part.
 *
 * Returns ranked interpretations rather than one answer — "nshaheen" could be
 * N. Shaheen or someone called Nshaheen, and the caller (index.js) simply tries
 * each against NPPES until one resolves.
 *
 * @returns {{generic:boolean, candidates:Array<{firstName:string,lastName:string,confidence:number,rule:string}>}}
 */
function nameHintsFromEmail(email) {
  const local = String(email || '').toLowerCase().split('@')[0] || '';
  const clean = local.replace(/\d+$/, ''); // drop trailing digits: jsmith2 → jsmith

  if (!clean || GENERIC_MAILBOXES.has(clean)) {
    return { generic: true, candidates: [] };
  }

  const parts = clean.split(/[._\-+]/).filter(Boolean);
  const candidates = [];

  if (parts.length >= 2) {
    // first.last / first.m.last — the unambiguous, common case.
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (first.length >= 2 && last.length >= 2) {
      candidates.push({ firstName: first, lastName: last, confidence: 85, rule: 'first.last' });
    }
    // Some organisations invert it (last.first).
    if (last.length >= 2 && first.length >= 2) {
      candidates.push({ firstName: last, lastName: first, confidence: 45, rule: 'last.first' });
    }
  } else if (parts.length === 1) {
    const one = parts[0];
    // "nshaheen" → N. Shaheen. The dominant institutional convention.
    if (one.length >= 4) {
      candidates.push({
        firstName: one[0],
        lastName: one.slice(1),
        confidence: 60,
        rule: 'initial+last',
      });
    }
    // "shaheenn" → Shaheen N.
    if (one.length >= 4) {
      candidates.push({
        firstName: one[one.length - 1],
        lastName: one.slice(0, -1),
        confidence: 35,
        rule: 'last+initial',
      });
    }
    // The whole thing may just be a surname.
    if (one.length >= 3) {
      candidates.push({ firstName: '', lastName: one, confidence: 40, rule: 'surname-only' });
    }
  }

  return { generic: false, candidates: candidates.sort((a, b) => b.confidence - a.confidence) };
}

// ── BIS lookups ─────────────────────────────────────────────────────────────

/** The BIS physician for an NPI resolved externally — the "recovery" step. */
function physicianByNpi(npi) {
  return npi ? physicians.getByNpi(npi) : null;
}

/** Other BIS physicians at a facility — useful even when the attendee is absent. */
function colleaguesAt(facilityId, limit = 6) {
  return facilityId ? physicians.getByFacility(facilityId, limit) : [];
}

module.exports = {
  matchFacility,
  nameTokens,
  facilityFromDomain,
  buildDomainIndex,
  nameHintsFromEmail,
  physicianByNpi,
  colleaguesAt,
  // exported for tests / tuning
  distinctiveTokens,
  diceScore,
  CONSUMER_DOMAINS,
};
