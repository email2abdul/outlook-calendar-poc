'use strict';

const physicians = require('./physicians');
const context = require('./enrichment/context');

/**
 * Who is this meeting with? — the rep's decision ladder, in one place.
 *
 * The order is deliberate and gets more expensive with every rung, so the
 * cheapest answer always wins:
 *
 *   1. an ATTENDEE's exact email in the BIS master        free, 0 ms
 *   2. the title says "Dr"/"Doctor" — the gate            free, 0 ms
 *   3. that name in the BIS master (in-memory directory)  free, 0 ms
 *      · exactly one  → resolved
 *      · several      → the rep picks (status `choose`)
 *   4. nothing in BIS → `needs_external`, which is where the enrichment agent
 *      (NPPES + CMS) takes over — that step is NOT run here.
 *
 * Two rules this module inherits from enrichment/context.js and never breaks:
 * the ORGANIZER (the rep who booked the meeting) is never matched, and the
 * title is only ever read for a NAME — never to invent an identity that the
 * name lookups themselves could not confirm.
 *
 * Nothing here is async: every rung is either an in-memory index lookup or a
 * string test, which is exactly why this can run on every meeting, every tick,
 * before anything paid is considered.
 */

/** Most a rep should ever be asked to choose between. */
const MAX_CANDIDATES = 5;

/**
 * How far down the directory we look before reporting a count. The rep only
 * sees MAX_CANDIDATES of them; this is just so "there are 12 of them" can be
 * said honestly instead of "there are 5".
 */
const COUNT_LIMIT = 50;

/**
 * The gate: the title must call the person a doctor.
 *
 * This is the rep's own rule, and it is what keeps a name lookup (and later a
 * paid external lookup) off "Pipeline review" and "1:1 with Sam". It matches
 * "Dr", "Dr.", "Drs" and "Doctor" as whole words, so "Drainage", "Andrew" and
 * "Dr" inside another word never open the gate.
 */
const GATE_RE = /\b(dr|doctor)s?\b\.?/i;

/** Words that are a qualification, not part of a person's name. */
const CREDENTIAL = /^(md|do|dds|dmd|mbbs|phd|mph|msc|ms|rn|np|pa|pa-c|facs|facg|fasge|facp|faga|jr|sr|ii|iii|iv)$/i;
const HONORIFIC = /^(dr|doctor|prof|professor|mr|mrs|ms|miss|sir)$/i;

/**
 * Does the title open the name path?
 * @returns {{pass: boolean, matched: string|null}}
 */
function titleGate(title) {
  const m = GATE_RE.exec(String(title || ''));
  return { pass: Boolean(m), matched: m ? m[0].trim() : null };
}

/**
 * "Dr Geoffrey Aaron, MD" → "Geoffrey Aaron".
 *
 * The honorific and the credentials have to go before the name reaches the
 * directory: nameTokens() would otherwise make "md" a word the stored name is
 * required to carry, and no BIS row carries it.
 */
function cleanPersonName(raw) {
  const words = String(raw || '')
    .replace(/\(.*?\)/g, ' ') // "Michael (Brian) Fennerty" → the nickname is not a required word
    .split(/[\s,]+/)
    .map((w) => w.replace(/[.]+$/, ''))
    .filter(Boolean)
    .filter((w) => !HONORIFIC.test(w) && !CREDENTIAL.test(w));
  return words.join(' ').trim();
}

/**
 * The names worth looking up, in the order we trust them.
 *
 * 1. the names the TITLE carries — namesFromEvent() is the conservative reader
 *    (never a lone surname, never the organizer, cut at a place word);
 * 2. the DISPLAY NAME of an attendee whose address matched nothing. An invite
 *    routinely reads "Dr Geoffrey Aaron <gaaron@practice.com>" where the
 *    address is simply not the one the master holds — the name still is.
 *
 * @returns {Array<{name: string, source: 'title'|'attendee', email: string|null}>}
 */
function namesToLookUp(ev, selfEmail) {
  const out = [];
  const seen = new Set();

  const push = (raw, source, email = null) => {
    const name = cleanPersonName(raw);
    if (name.split(/\s+/).filter(Boolean).length < 2) return; // a surname alone identifies nobody
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, source, email });
  };

  for (const n of context.namesFromEvent(ev, { selfEmail })) push(n.name, 'title');

  for (const a of context.attendeesToEnrich(ev, { selfEmail })) {
    if (!a.name) continue;
    if (physicians.getByEmail(a.email)) continue; // already resolved by email
    push(a.name, 'attendee', a.email);
  }

  return out;
}

/** The lean physician shape the UI and the briefs need. */
function toCard(p) {
  return {
    npi: p.npi,
    name: p.name,
    specialty: p.specialty || null,
    email: p.email || null,
    phone: p.phone || null,
    facility: p.facility
      ? { id: p.facility.id, name: p.facility.name, city: p.facility.city, state: p.facility.state }
      : null,
  };
}

/**
 * Resolve one meeting.
 *
 * @param {object} ev                normalized event (src/graph.js)
 * @param {object} [opts]
 * @param {string} [opts.selfEmail]  the signed-in rep, excluded like the organizer
 * @returns {{
 *   status: 'matched'|'choose'|'needs_external'|'gate_blocked'|'no_name',
 *   via: 'attendee-email'|'bis-name'|null,
 *   physicians: object[],
 *   groups: Array<{name: string, source: string, candidates: object[], total: number}>,
 *   names: object[],
 *   gate: {pass: boolean, matched: string|null},
 *   unresolvedNames: string[],
 *   reason: string
 * }}
 */
function matchMeeting(ev, opts = {}) {
  const selfEmail = opts.selfEmail || null;
  const gate = titleGate(ev?.title);

  const base = {
    status: 'no_name',
    via: null,
    physicians: [],
    groups: [],
    names: [],
    gate,
    unresolvedNames: [],
    reason: '',
  };

  // ── Rung 1: an attendee's exact email in the master ──────────────────────
  const byEmail = new Map();
  for (const a of context.attendeesToEnrich(ev, { selfEmail })) {
    const p = physicians.getByEmail(a.email);
    if (p) byEmail.set(p.npi, p);
  }
  if (byEmail.size) {
    const found = [...byEmail.values()];
    return {
      ...base,
      status: 'matched',
      via: 'attendee-email',
      physicians: found.map(toCard),
      reason:
        `${found.length} attendee email(s) matched the BIS master exactly` +
        ` (${found.map((p) => p.name || p.npi).join(', ')}).`,
    };
  }

  // ── Rung 2: the gate ─────────────────────────────────────────────────────
  if (!gate.pass) {
    return {
      ...base,
      status: 'gate_blocked',
      reason:
        'No attendee email is in the master and the title does not say "Dr" or ' +
        '"Doctor", so this is treated as a normal meeting — no name lookup was run.',
    };
  }

  // ── Rung 3: the name(s), against the master ──────────────────────────────
  const names = namesToLookUp(ev, selfEmail);
  if (!names.length) {
    return {
      ...base,
      names,
      reason:
        'The title says "Dr" but carries no readable full name, and no attendee ' +
        'display name could be used — nothing to look up.',
    };
  }

  const groups = [];
  const resolved = new Map();
  const unresolved = [];

  for (const n of names) {
    const hits = physicians.searchByNameTokens(n.name, COUNT_LIMIT);
    if (hits.length === 1) {
      resolved.set(hits[0].npi, hits[0]);
      groups.push({ name: n.name, source: n.source, candidates: [toCard(hits[0])], total: 1 });
    } else if (hits.length > 1) {
      groups.push({
        name: n.name,
        source: n.source,
        candidates: hits.slice(0, MAX_CANDIDATES).map(toCard),
        total: hits.length,
      });
    } else {
      unresolved.push(n.name);
      groups.push({ name: n.name, source: n.source, candidates: [], total: 0 });
    }
  }

  const ambiguous = groups.filter((g) => g.total > 1);

  // A name the rep must choose between outranks one that resolved cleanly: the
  // meeting is not settled until every name is.
  if (ambiguous.length) {
    const g = ambiguous[0];
    return {
      ...base,
      status: 'choose',
      names,
      groups,
      unresolvedNames: unresolved,
      physicians: [...resolved.values()].map(toCard),
      reason:
        `"${g.name}" matches ${g.total} physician(s) in the master` +
        (g.total > MAX_CANDIDATES ? ` — showing the first ${MAX_CANDIDATES}.` : '.') +
        ' The rep picks who the meeting is with.',
    };
  }

  if (resolved.size) {
    return {
      ...base,
      status: 'matched',
      via: 'bis-name',
      names,
      groups,
      unresolvedNames: unresolved,
      physicians: [...resolved.values()].map(toCard),
      reason:
        `${resolved.size} name(s) from the meeting resolved to exactly one BIS ` +
        `physician each (${[...resolved.values()].map((p) => p.name).join(', ')})` +
        (unresolved.length ? `; ${unresolved.join(', ')} not in the master.` : '.'),
    };
  }

  return {
    ...base,
    status: 'needs_external',
    names,
    groups,
    unresolvedNames: unresolved,
    reason:
      `${unresolved.join(', ')} — not in the BIS master by email or by name. ` +
      'The public registries (NPPES / CMS) are the next step.',
  };
}

module.exports = {
  matchMeeting,
  titleGate,
  cleanPersonName,
  namesToLookUp,
  MAX_CANDIDATES,
};
