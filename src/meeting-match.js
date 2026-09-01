'use strict';

const physicians = require('./physicians');
const context = require('./enrichment/context');

/**
 * Who is this meeting with? — the rep's decision ladder, in one place.
 *
 * The order is deliberate and gets more expensive with every rung, so the
 * cheapest answer always wins:
 *
 *   0. an NPI written on the MEETING itself               free, 0 ms
 *      — the strongest identifier there is, so it is asked first
 *   1. an ATTENDEE's exact email in the BIS master        free, 0 ms
 *   2. the physician the REP already picked for this       free, 0 ms
 *      meeting (the stored decision)
 *   3. the title says "Dr"/"Doctor" — the gate            free, 0 ms
 *   4. that name in the BIS master (in-memory directory)  free, 0 ms
 *      · exactly one  → resolved
 *      · several      → the rep picks (status `choose`)
 *   5. nothing in BIS → `needs_external`, which is where the public sources
 *      (NPPES by name, then CMS by the NPI it produces) take over — those are
 *      NOT run here.
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
 * An NPI is ten digits with a Luhn check digit, computed over the number
 * prefixed by 80840 (the NPPES issuer prefix). Checking it matters: a meeting
 * body is full of ten-digit numbers — phone numbers, order numbers, Teams
 * conference ids — and treating one of those as a physician id would brief a
 * stranger with total confidence.
 */
function isValidNpi(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length !== 10) return false;

  const body = `80840${digits.slice(0, 9)}`;
  let sum = 0;
  // Double every second digit from the right of the (prefix + first 9) string.
  for (let i = body.length - 1, alt = true; i >= 0; i--, alt = !alt) {
    let n = Number(body[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits[9]);
}

/**
 * An NPI written on the meeting — in the title, the body, or the location.
 *
 * A rep who pastes "NPI 1467521757" into an invite has named the physician
 * exactly, with no ambiguity to resolve and nothing to guess. That is why this
 * runs before the email match and before the "Dr" gate: it is the one identifier
 * that cannot mean two people.
 *
 * "NPI 1234567890" is preferred over a bare ten-digit run, so a labelled id
 * beats a phone number that happens to pass the checksum.
 */
function npiFromEvent(ev) {
  const text = [ev?.title, ev?.description, ev?.location].filter(Boolean).join(' \n ');
  if (!text) return null;

  const labelled = /\bNPIs?\b[^0-9]{0,12}(\d[\d\s-]{8,}\d)/gi;
  for (const m of text.matchAll(labelled)) {
    const digits = m[1].replace(/\D/g, '');
    if (isValidNpi(digits)) return digits;
  }
  for (const m of text.matchAll(/\b(\d{10})\b/g)) {
    if (isValidNpi(m[1])) return m[1];
  }
  return null;
}

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

/**
 * The half-names a meeting gave — "Dr Khan", "Dr Geoffrey" — and which part is
 * missing.
 *
 * A single word cannot identify a physician: "Khan" is 30 people in the master
 * and hundreds in the registry. The old rule dropped these on the floor, which
 * left the rep with an empty panel and no idea why. They are kept now, so the
 * notes can carry a tag asking for the part that is missing and the shortlist
 * can still be offered — with honest, low confidence.
 *
 * @returns {Array<{name: string, source: string, missing: 'first'|'last'|'unknown'}>}
 */
function partialNamesFrom(ev, selfEmail) {
  const out = [];
  const seen = new Set();
  const skip = context.organizerTokens(ev, selfEmail);

  const consider = (raw, source) => {
    const words = cleanPersonName(raw).split(/\s+/).filter(Boolean);
    if (words.length !== 1) return; // two words is a whole name; zero is nothing
    const word = words[0];
    if (word.length < 3) return; // "Dr A" identifies nobody at all
    if (skip.has(word.toLowerCase())) return; // the organizer
    if (!/^[A-Za-z][A-Za-z'’-]*$/.test(word)) return;
    const key = word.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: word, source, missing: missingPartOf(word) });
  };

  // Read the title through the SAME reader as a full name, asking it to accept
  // one word. Re-implementing the parse here is how "Dr rounds" became a
  // physician called Rounds: the meeting words, place words and the organizer
  // rule all live in namesFromEvent, and they all still apply.
  for (const p of context.namesFromEvent(ev, { selfEmail, minWords: 1 })) {
    consider(p.name, 'title');
  }

  for (const a of context.attendeesToEnrich(ev, { selfEmail })) {
    if (a.name && !physicians.getByEmail(a.email)) consider(a.name, 'attendee');
  }

  return out;
}

/**
 * Is this single word a surname or a given name — and therefore which half of
 * the name is missing?
 *
 * Answered from the master itself rather than from a name list: "Khan" ends
 * 30-odd physician names and starts almost none, so it is a surname and the
 * FIRST name is what the rep needs to add. Ambiguous either way → say "full
 * name" instead of guessing wrong and asking for the part they already gave.
 */
function missingPartOf(word) {
  if (typeof physicians.getAllPhysicians !== 'function') return 'unknown';
  const w = word.toLowerCase();
  let asFirst = 0;
  let asLast = 0;
  for (const p of physicians.getAllPhysicians()) {
    const parts = String(p.name || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    if (parts[0] === w) asFirst++;
    if (parts[parts.length - 1] === w) asLast++;
  }
  if (asLast > asFirst * 2 && asLast > 0) return 'first';
  if (asFirst > asLast * 2 && asFirst > 0) return 'last';
  return 'unknown';
}

/**
 * Physicians in the master whose SURNAME is this word.
 *
 * searchByNameTokens needs two words (a lone token would match half the
 * directory as a substring), so a half-name needs its own, stricter lookup:
 * the word has to be the last word of the stored name.
 */
function bisBySurname(word) {
  if (typeof physicians.getAllPhysicians !== 'function') return [];
  const w = word.toLowerCase();
  const hits = [];
  for (const p of physicians.getAllPhysicians()) {
    const parts = String(p.name || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length && parts[parts.length - 1] === w) hits.push(p);
  }
  // Every hit is counted and only the shown ones are sliced: "50" when there
  // are 63 of them is a number the rep would act on wrongly.
  return hits;
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
 * @param {string} [opts.chosenNpi]  the physician the rep already confirmed for
 *                                   this meeting (app_activities.chosen_npi)
 * @returns {{
 *   status: 'matched'|'choose'|'needs_external'|'partial_name'|'gate_blocked'|'no_name',
 *   via: 'meeting-npi'|'attendee-email'|'rep-choice'|'bis-name'|null,
 *   npi: string|null,
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
    npi: null, // an NPI the MEETING itself carried, resolved or not
    // Set when the meeting gave only half a name: { name, missing } — the notes
    // show a tag asking for the part that is missing.
    nameIncomplete: null,
    physicians: [],
    groups: [],
    names: [],
    gate,
    unresolvedNames: [],
    reason: '',
  };

  // ── Rung 0: an NPI written on the meeting itself ─────────────────────────
  // Nothing else identifies a physician this precisely, so nothing else goes
  // first. In the master → resolved. Not in the master → still resolved as far
  // as WHO is concerned; the public sources are simply where their details are,
  // and they are asked by NPI (no name, no ambiguity, no gate).
  const meetingNpi = npiFromEvent(ev);
  if (meetingNpi) {
    base.npi = meetingNpi;
    const known = physicians.getByNpi(meetingNpi);
    if (known) {
      return {
        ...base,
        status: 'matched',
        via: 'meeting-npi',
        physicians: [toCard(known)],
        reason: `NPI ${meetingNpi} is on the meeting and is in the BIS master (${known.name || meetingNpi}).`,
      };
    }
    return {
      ...base,
      status: 'needs_external',
      reason:
        `NPI ${meetingNpi} is on the meeting but not in the BIS master — the public ` +
        'sources are asked by that NPI, so there is nothing to disambiguate.',
    };
  }

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

  // ── Rung 2: the physician the rep already picked for this meeting ────────
  // A shortlist is a question, and this is the answer to it. Asking the same
  // question every few minutes is worse than useless: it re-lists candidates
  // the rep has already ruled out, and (before this) it re-spent the lookup.
  // Deliberately below the email rung, per the agreed flow — an address that
  // matches the master exactly is not a guess anyone needs to confirm.
  if (opts.chosenNpi) {
    const picked = physicians.getByNpi(opts.chosenNpi);
    if (picked) {
      return {
        ...base,
        status: 'matched',
        via: 'rep-choice',
        physicians: [toCard(picked)],
        reason: `${picked.name || opts.chosenNpi} was confirmed for this meeting by the rep.`,
      };
    }
    // The NPI is stored but no longer in the directory (the master was
    // reloaded, or the row went away). Fall through to the ladder rather than
    // showing nothing — and say so, so the stale pick is visible.
    base.reason = `Stored choice ${opts.chosenNpi} is no longer in the BIS master.`;
  }

  // ── Rung 3: the gate ─────────────────────────────────────────────────────
  if (!gate.pass) {
    return {
      ...base,
      status: 'gate_blocked',
      reason:
        'No attendee email is in the master and the title does not say "Dr" or ' +
        '"Doctor", so this is treated as a normal meeting — no name lookup was run.',
    };
  }

  // ── Rung 4: the name(s), against the master ──────────────────────────────
  const names = namesToLookUp(ev, selfEmail);

  if (!names.length) {
    // Half a name is still something: offer what the master has under that
    // surname, and say which part the rep needs to add.
    const partials = partialNamesFrom(ev, selfEmail);
    if (partials.length) {
      const first = partials[0];
      const hits = bisBySurname(first.name);

      if (hits.length) {
        return {
          ...base,
          status: 'choose',
          nameIncomplete: first,
          names: partials.map((p) => ({ name: p.name, source: p.source, email: null })),
          groups: [
            {
              name: first.name,
              source: first.source,
              candidates: hits.slice(0, MAX_CANDIDATES).map(toCard),
              total: hits.length,
              partial: true,
            },
          ],
          reason:
            `The meeting only gives “${first.name}”, so ${hits.length} physician(s) in the ` +
            'master could be the one — the rep picks, or completes the name.',
        };
      }

      return {
        ...base,
        status: 'partial_name',
        nameIncomplete: first,
        names: partials.map((p) => ({ name: p.name, source: p.source, email: null })),
        unresolvedNames: partials.map((p) => p.name),
        reason:
          `The meeting only gives “${first.name}” — half a name identifies nobody, and ` +
          'the master has no physician with that surname.',
      };
    }

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
  partialNamesFrom,
  missingPartOf,
  npiFromEvent,
  isValidNpi,
  titleGate,
  cleanPersonName,
  namesToLookUp,
  MAX_CANDIDATES,
};
