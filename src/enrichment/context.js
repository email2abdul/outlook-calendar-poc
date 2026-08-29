'use strict';

const physicians = require('../physicians');
const entityMatcher = require('../entity-matcher');

/**
 * Meeting context — who to enrich, and what the meeting itself tells us.
 *
 * Two rules, set by the rep and enforced here rather than at each call site:
 *
 *  1. **Only attendees are matched. The organizer is never matched — ever.**
 *     The organizer is the rep who scheduled the meeting; matching them against
 *     the physician directory (or spending an AI lookup on them) is always
 *     wrong. Meeting rooms and equipment (`type: 'resource'`) are excluded for
 *     the same reason. This replaces the internal-domain skip-list idea from
 *     the design doc — an exclusion by ROLE, not by domain, which needs no
 *     configuration and cannot go stale.
 *
 *  2. **The title and description are used for context only** — the facility,
 *     city and other details the organizer typed in — never to identify the
 *     person. Identity comes from the attendee's email address alone.
 */

/** Normalised address, or null. */
function normEmail(value) {
  const e = String(value || '').trim().toLowerCase();
  return e.includes('@') ? e : null;
}

/**
 * The attendees this meeting should enrich.
 *
 * @param {object} event                normalized event (src/graph.js)
 * @param {object} [opts]
 * @param {string} [opts.selfEmail]     signed-in user, excluded as well
 * @returns {Array<{email:string, name:string|null, type:string, response:string}>}
 */
function attendeesToEnrich(event, opts = {}) {
  const organizer = normEmail(event?.organizer?.email);
  const self = normEmail(opts.selfEmail);

  const excluded = new Set([organizer, self].filter(Boolean));
  const seen = new Set();
  const out = [];

  for (const a of event?.attendees || []) {
    const email = normEmail(a.email);
    if (!email) continue;
    if (excluded.has(email)) continue; // rule 1 — never the organizer or self
    if (a.type === 'resource') continue; // meeting rooms / equipment
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: a.name || null, type: a.type || 'required', response: a.response || 'none' });
  }

  return out;
}

/** True when this address is the meeting's organizer (or the signed-in user). */
function isOrganizer(event, email, selfEmail) {
  const e = normEmail(email);
  if (!e) return false;
  return e === normEmail(event?.organizer?.email) || (selfEmail ? e === normEmail(selfEmail) : false);
}

/** Words from the organizer's name/address — never treated as meeting context. */
function organizerTokens(event, selfEmail) {
  const bits = [
    event?.organizer?.name,
    (normEmail(event?.organizer?.email) || '').split('@')[0],
    (normEmail(selfEmail) || '').split('@')[0],
  ];
  const tokens = new Set();
  for (const b of bits) {
    for (const t of String(b || '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (t.length >= 3) tokens.add(t);
    }
  }
  return tokens;
}

/**
 * Facility / location hints from the meeting title and description.
 *
 * Reuses the existing entity-matcher rather than re-implementing extraction —
 * it already classifies facilities, organisations and locations and matches
 * them against the master data, returning `master_id` for a hit.
 *
 * PERSON entities are deliberately ignored: identity comes from the attendee's
 * email, and a name in the title is as likely to be the organizer's as the
 * physician's.
 *
 * @returns {Promise<{facilityId, facilityName, city, state, mentionedFacilities, text}>}
 */
async function hintsFromEvent(event, opts = {}) {
  const text = [event?.title, event?.description, event?.location]
    .filter(Boolean)
    .join('. ')
    .trim();

  const hints = {
    facilityId: null,
    facilityName: null,
    city: null,
    state: null,
    mentionedFacilities: [],
    text: text || null,
  };
  if (!text) return hints;

  const skip = organizerTokens(event, opts.selfEmail);

  let analysis;
  try {
    analysis = await entityMatcher.analyze(text);
  } catch (err) {
    console.warn('[enrichment:context] entity analysis failed:', err.message);
    return hints;
  }

  const isOrganizerish = (entityText) => {
    const tokens = String(entityText || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
    return tokens.length > 0 && tokens.every((t) => skip.has(t));
  };

  // A confident facility/organisation match gives us a real bis_facilities row,
  // which carries city and state for free.
  for (const m of analysis.matched_entities || []) {
    if (m.entity_type !== 'facility' && m.entity_type !== 'organization') continue;
    if (isOrganizerish(m.entity)) continue;

    const facility = physicians.getFacilityById(m.master_id);
    if (!facility) continue;

    hints.facilityId = facility.id;
    hints.facilityName = facility.name;
    hints.city = hints.city || facility.city || null;
    hints.state = hints.state || facility.state || null;
    break;
  }

  // Everything the text NAMES as a facility, matched or not — the web tier can
  // use an unmatched name ("Lumendi Endoscopy Center") as a search hint even
  // when BIS has never heard of it.
  for (const e of analysis.extracted_entities || []) {
    if (e.type !== 'facility' && e.type !== 'organization') continue;
    if (isOrganizerish(e.text)) continue;
    if (!hints.mentionedFacilities.includes(e.text)) hints.mentionedFacilities.push(e.text);
  }

  // A recognised city from the location/text, when no facility pinned one down.
  if (!hints.city) {
    for (const m of analysis.matched_entities || []) {
      if (m.entity_type === 'location' && !isOrganizerish(m.entity)) {
        hints.city = m.entity;
        break;
      }
    }
  }

  return hints;
}

/**
 * Remove person entities that are really the organizer from an entity-matcher
 * analysis, so "Wajid <> Dr Smith" in a title can never resolve to the rep.
 * Returns a shallow copy; the caller's analysis is untouched.
 */
function stripOrganizerPeople(analysis, event, selfEmail) {
  if (!analysis) return analysis;
  const skip = organizerTokens(event, selfEmail);
  if (!skip.size) return analysis;

  const isOrganizerish = (text) => {
    const tokens = String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3);
    return tokens.length > 0 && tokens.every((t) => skip.has(t));
  };

  return {
    ...analysis,
    matched_entities: (analysis.matched_entities || []).filter(
      (m) => !(m.entity_type === 'person' && isOrganizerish(m.entity))
    ),
    suggestions: (analysis.suggestions || []).filter(
      (s) => !(s.entity_type === 'person' && isOrganizerish(s.entity))
    ),
  };
}

module.exports = {
  attendeesToEnrich,
  isOrganizer,
  hintsFromEvent,
  organizerTokens,
  stripOrganizerPeople,
};
