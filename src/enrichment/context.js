'use strict';

const crypto = require('crypto');

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

// ── Names in the title ──────────────────────────────────────────────────────

/**
 * Words that introduce a meeting rather than name anybody, stripped from the
 * front of a title ("Meeting with …", "Lunch with …", "Demo for …").
 */
const LEAD_WORDS = new Set([
  'meeting', 'meet', 'mtg', 'call', 'zoom', 'teams', 'webex', 'sync', 'catchup',
  'catch', 'up', 'visit', 'demo', 'lunch', 'dinner', 'coffee', 'breakfast',
  'intro', 'introduction', 'discussion', 'discuss', 'appointment', 'appt',
  'followup', 'follow', 'checkin', 'check', 'in', 'review', 'touchpoint',
  'touch', 'base', 'quick', 'weekly', 'monthly', 'daily', 'onsite', 'on', 'site',
  'brief', 'briefing', 'training', 'case', 'observation', 'evaluation',
  'chat', 'huddle', 'session', 'standup', 'debrief',
]);

const HONORIFIC = /^(dr|doctor|prof|professor|mr|mrs|ms|miss|sir)[.,]?$/i;
const CREDENTIAL = /^(md|do|dds|mbbs|phd|mph|msc|rn|np|pa-c|pa|facs|facg|fasge|facp|faga|jr|sr|ii|iii|iv)[.,]?$/i;
/** A token that proves the phrase is a place, not a person. */
const PLACE_WORD = new Set([
  'hospital', 'hospitals', 'clinic', 'clinics', 'medical', 'medicine', 'center',
  'centre', 'health', 'healthcare', 'system', 'university', 'college',
  'institute', 'associates', 'group', 'practice', 'partners', 'endoscopy',
  'surgery', 'surgical', 'gastroenterology', 'gi', 'department', 'dept',
  'office', 'team', 'inc', 'llc', 'pllc', 'pc', 'pa',
]);
/** Words that are never part of a person's name in a calendar title. */
const NOT_A_NAME = new Set([
  'agenda', 'notes', 'update', 'updates', 'pipeline', 'forecast', 'product',
  'products', 'demo', 'training', 'onboarding', 'interview', 'standup',
  'retro', 'planning', 'budget', 'q1', 'q2', 'q3', 'q4', 'poc', 'bis', 'lumendi',
]);

/**
 * Lowercase words that are legitimately part of a surname ("Maria de Souza"),
 * so requiring capitalisation does not throw those names away.
 */
const NAME_PARTICLE = new Set([
  'de', 'del', 'della', 'da', 'das', 'dos', 'di', 'du', 'van', 'von', 'der',
  'den', 'ter', 'ten', 'la', 'le', 'bin', 'ibn', 'al',
]);

/**
 * Is this run of words capitalised the way a person's name is?
 *
 * The rule this module documents — "an honorific or two capitalised words in a
 * row" — was never actually enforced: the token test (`/^[A-Za-z].../`) accepts
 * any case, and titleCase() then dressed the result up as a name, so a plain
 * lowercase title ("quick vivek sync") came back looking like a person.
 *
 * An honorific is proof enough on its own ("dr geoffrey aaron" is a name however
 * the rep typed it). Without one we need two words that are capitalised as a
 * name is, ignoring the lowercase particles above.
 */
function looksLikeAName(tokens, hadHonorific) {
  if (hadHonorific) return true;
  let capitals = 0;
  for (const t of tokens) {
    if (/^[A-Z]/.test(t)) {
      capitals++;
      continue;
    }
    if (!NAME_PARTICLE.has(t.toLowerCase())) return false;
  }
  return capitals >= 2;
}

/** "GEOFFREY AARON" / "geoffrey aaron" → "Geoffrey Aaron". */
function titleCase(tokens) {
  return tokens
    .map((t) =>
      t.length <= 2 && t.endsWith('.')
        ? t.toUpperCase() // initials: "a." → "A."
        : t[0].toUpperCase() + t.slice(1).toLowerCase()
    )
    .join(' ');
}

/** One title segment → a person's name, or null when it isn't one. */
function nameFromSegment(segment, skipTokens) {
  // Everything after "at"/"@"/"–"/"(" is where, not who.
  const who = String(segment)
    .split(/\s+(?:at|@|re|regarding|about|for|from)\s+/i)[0]
    .split(/[(–—|]/)[0]
    .replace(/\s+-\s+.*$/, '')
    // A connector left at the front ("Demo FOR Adam Smith" once "demo" is gone)
    // would otherwise be read as a first name.
    .replace(/^(?:for|with|w\/|to|the|our|a|an)\s+/i, '')
    .trim();

  const raw = who.split(/\s+/).filter(Boolean);
  const tokens = [];
  let hadHonorific = false;
  for (const t of raw) {
    const word = t.replace(/[,;:]+$/, '');
    const bare = word.toLowerCase().replace(/[.]/g, '');
    if (!word) continue;
    if (HONORIFIC.test(word)) {
      hadHonorific = true;
      continue;
    }
    if (CREDENTIAL.test(word)) continue;
    // A meeting word BEFORE the name is a prefix to drop ("Demo Adam Smith").
    // AFTER one, it is where the name ended: "Vivek Chat" is a chat, not a
    // Mr Chat, and "Adam Smith Sync" is Adam Smith.
    if (LEAD_WORDS.has(bare)) {
      if (!tokens.length) continue;
      break;
    }
    // A place word (or an obvious non-name) ends the name — "Adam Smith
    // Hospital Boston" is Adam Smith, and nothing after it.
    if (PLACE_WORD.has(bare) || NOT_A_NAME.has(bare)) break;
    if (!/^[A-Za-z][A-Za-z'’.-]*$/.test(word)) break;
    tokens.push(word);
    if (tokens.length === 4) break;
  }

  // Two tokens minimum: a bare surname is not enough to look anybody up, and a
  // single first name ("call with Steve") would produce confident nonsense.
  if (tokens.length < 2) return null;
  if (!looksLikeAName(tokens, hadHonorific)) return null;
  if (tokens.every((t) => skipTokens.has(t.toLowerCase()))) return null; // the organizer
  return titleCase(tokens);
}

/**
 * People NAMED in a meeting's title.
 *
 * The attendee list is the reliable way to know who a meeting is with, but reps
 * routinely book "meeting with dr Geoffrey Aaron" with no attendee at all — and
 * until now that produced nothing: enrichment is keyed on an email address, so
 * there was none to enrich, and the rep walked in blind (verified 2026-08-31,
 * three of four meetings on the test calendar).
 *
 * Deliberately conservative — this feeds an automated lookup, so a wrong name
 * is worse than no name: an honorific or two capitalised words in a row, never
 * a lone surname, never the organizer, and anything that reads like a place is
 * cut at the place word.
 *
 * @param {object} event    normalized event (src/graph.js)
 * @param {object} [opts]
 * @param {string} [opts.selfEmail]
 * @param {number} [opts.limit=3]
 * @returns {Array<{name:string, source:'title'}>}
 */
function namesFromEvent(event, opts = {}) {
  const title = String(event?.title || '').trim();
  if (!title) return [];

  const skip = organizerTokens(event, opts.selfEmail);

  // "Meeting with X", "Demo for X" — keep what follows the connector. Without
  // one, drop the leading meeting words and read what's left.
  const afterWith = title.split(/\s+(?:with|w\/)\s+/i);
  let body = afterWith.length > 1 ? afterWith.slice(1).join(' with ') : title;
  if (afterWith.length === 1) {
    const words = body.split(/\s+/);
    while (words.length && LEAD_WORDS.has(words[0].toLowerCase().replace(/[.,:]/g, ''))) {
      words.shift();
    }
    body = words.join(' ');
  }

  const out = [];
  const seen = new Set();
  for (const segment of body.split(/\s*(?:,|&|\+|;|\/|<>| and )\s*/i)) {
    const name = nameFromSegment(segment, skip);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, source: 'title' });
    if (out.length >= (opts.limit || 3)) break;
  }
  return out;
}

// ── Recurring series identity ───────────────────────────────────────────────

/**
 * A short, stable fingerprint of the people a meeting is about.
 *
 * NPI first — a matched BIS physician is the same person whatever address the
 * invite used — then email, then the bare name a title gave us.
 *
 * @param {Array<{npi?:string|number|null, email?:string|null, name?:string|null}>} subjects
 * @returns {string|null}
 */
function subjectFingerprint(subjects) {
  const parts = [
    ...new Set(
      (subjects || [])
        .map((s) => String(s?.npi || s?.email || s?.name || '').trim().toLowerCase())
        .filter(Boolean)
    ),
  ].sort();
  if (!parts.length) return null;
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

/**
 * The dedupe identity of the MEETING an enrichment belongs to.
 *
 * `calendarView` expands a recurring series into one concrete event per
 * occurrence, each with its own event id. Keying per-meeting work on that id
 * means a weekly meeting inside the 30-day sync window is handled ~29 times —
 * 29 paid lookups, 29 briefs — for one logical meeting with one person. Graph
 * stamps every occurrence of a series (and every edited "exception") with the
 * same `seriesMasterId`, and that, not the title, is the series' identity:
 * two different series never share it, and two unrelated meetings that happen
 * to be called the same thing never collide.
 *
 * A single, non-recurring event has no `seriesMasterId` and keeps its own id
 * verbatim — so distinct one-off meetings stay distinct, and dedupe keys
 * already written for past events still match.
 *
 * The subjects are folded in so an occurrence the rep edited to be with someone
 * else (a Graph "exception") is still handled on its own: same series, but not
 * the same person, so not the same answer.
 *
 * @param {object} event                             normalized event (src/graph.js)
 * @param {Array<{npi?, email?, name?}>} [subjects]  who this meeting is about
 * @returns {string} the dedupe key body
 */
function seriesKey(event, subjects = []) {
  const master = String(event?.seriesMasterId || '').trim();
  if (!master) return String(event?.id || '');
  const who = subjectFingerprint(subjects);
  return who ? `series:${master}:${who}` : `series:${master}`;
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
  namesFromEvent,
  seriesKey,
  isOrganizer,
  hintsFromEvent,
  organizerTokens,
  stripOrganizerPeople,
};
