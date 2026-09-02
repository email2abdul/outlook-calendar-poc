'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * The decision ladder in src/meeting-match.js — the rep's own rule set:
 *
 *   attendee email in the master  →  "Dr"/"Doctor" in the title  →  that name
 *   in the master  →  one hit (brief) / several (rep picks) / none (registries).
 *
 * The directory is a hand-made fake, so these tests are offline and exact: the
 * point is the ORDER and the GATE, not Supabase.
 */

// A tiny master: two Aarons (so a name is genuinely ambiguous), one unique name.
const DIRECTORY = [
  {
    npi: '1000000001',
    name: 'Geoffrey A Aaron',
    specialty: 'Gastroenterology',
    email: 'gaaron@bis-example.org',
    phone: '555-0100',
    facility: { id: 'F1', name: 'UNC Hospitals', city: 'Chapel Hill', state: 'NC' },
  },
  {
    npi: '1000000002',
    name: 'Geoffrey Aaron',
    specialty: 'Internal Medicine',
    email: null,
    phone: null,
    facility: { id: 'F2', name: 'Duke Health', city: 'Durham', state: 'NC' },
  },
  {
    // A real, checksum-valid NPI: rung 0 refuses to look up a number that
    // cannot be one, so the fixture needs a genuine value.
    npi: '1508935800',
    name: 'Nicholas J Shaheen',
    specialty: 'Gastroenterology',
    email: null,
    phone: null,
    facility: { id: 'F1', name: 'UNC Hospitals', city: 'Chapel Hill', state: 'NC' },
  },
];

const tokens = (s) =>
  String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9'’-]+/)
    .filter((t) => t.length >= 2);

stub('src/physicians', {
  getByEmail: (email) =>
    DIRECTORY.find((p) => p.email && p.email.toLowerCase() === String(email || '').toLowerCase()) || null,
  getByNpi: (npi) => DIRECTORY.find((p) => p.npi === String(npi)) || null,
  searchByNameTokens: (query, limit) => {
    const want = tokens(query);
    if (want.length < 2) return [];
    return DIRECTORY.filter((p) => want.every((t) => p.name.toLowerCase().includes(t))).slice(0, limit);
  },
  getFacilityById: () => null,
  matchInText: () => [],
});

const {
  matchMeeting,
  titleGate,
  cleanPersonName,
  isValidNpi,
  nameSearchKey,
  nameSearchKeys,
} = require('../src/meeting-match');

const REP = 'rep@lumendi-example.com';
const event = (over = {}) => ({
  id: 'EV1',
  title: '',
  start: '2026-09-02T14:00:00',
  timeZone: 'UTC',
  organizer: { name: 'Sales Rep', email: REP },
  attendees: [],
  ...over,
});

// ── The gate ────────────────────────────────────────────────────────────────

test('the gate reads "Dr" as a word, not as three letters inside one', () => {
  assert.strictEqual(titleGate('Meeting with Dr Geoffrey Aaron').pass, true);
  assert.strictEqual(titleGate('Call with Doctor Aaron').pass, true);
  assert.strictEqual(titleGate('Drs Aaron & Shaheen').pass, true);
  assert.strictEqual(titleGate('dr. geoffrey aaron').pass, true);

  assert.strictEqual(titleGate('Drainage review').pass, false, '"Drainage" is not a doctor');
  assert.strictEqual(titleGate('1:1 with Andrew').pass, false, '"Andrew" contains "dr"');
  assert.strictEqual(titleGate('Pipeline review').pass, false);
  assert.strictEqual(titleGate('').pass, false);
});

test('an honorific and credentials are not part of the name', () => {
  assert.strictEqual(cleanPersonName('Dr Geoffrey Aaron, MD'), 'Geoffrey Aaron');
  assert.strictEqual(cleanPersonName('Nicholas Shaheen MD, MPH'), 'Nicholas Shaheen');
  assert.strictEqual(cleanPersonName('Michael (Brian) Fennerty'), 'Michael Fennerty');
});

// ── Rung 1: the email always wins ───────────────────────────────────────────

test('an exact attendee email resolves the meeting without touching the gate', () => {
  const r = matchMeeting(
    event({
      title: 'Pipeline review', // no "Dr" anywhere — must not matter
      attendees: [{ name: 'G Aaron', email: 'gaaron@bis-example.org', type: 'required' }],
    }),
    { selfEmail: REP }
  );

  assert.strictEqual(r.status, 'matched');
  assert.strictEqual(r.via, 'attendee-email');
  assert.deepStrictEqual(
    r.physicians.map((p) => p.npi),
    ['1000000001']
  );
});

test('the organizer is never matched, however the meeting is titled', () => {
  const r = matchMeeting(
    event({
      title: 'Meeting with Dr Geoffrey Aaron',
      // The rep's own address is in the directory in this fixture; it must
      // still be excluded, because the organizer is never the subject.
      organizer: { name: 'G Aaron', email: 'gaaron@bis-example.org' },
      attendees: [{ name: 'G Aaron', email: 'gaaron@bis-example.org', type: 'required' }],
    }),
    { selfEmail: 'gaaron@bis-example.org' }
  );

  assert.notStrictEqual(r.via, 'attendee-email', 'the organizer must not resolve the meeting');
});

// ── Rung 2: the gate stops everything else ──────────────────────────────────

test('no email match and no "Dr" in the title = normal meeting, no lookup', () => {
  const r = matchMeeting(event({ title: 'Coffee with Geoffrey Aaron' }), { selfEmail: REP });

  assert.strictEqual(r.status, 'gate_blocked');
  assert.deepStrictEqual(r.physicians, []);
  assert.deepStrictEqual(r.names, [], 'nothing was even read as a name');
});

// ── Rung 3: the name, against the master ────────────────────────────────────

test('a gated title whose name matches exactly one physician is resolved', () => {
  const r = matchMeeting(event({ title: 'Case obs with Dr Nicholas Shaheen' }), { selfEmail: REP });

  assert.strictEqual(r.status, 'matched');
  assert.strictEqual(r.via, 'bis-name');
  assert.deepStrictEqual(
    r.physicians.map((p) => p.npi),
    ['1508935800']
  );
});

test('a name matching several physicians is handed back for the rep to pick', () => {
  const r = matchMeeting(event({ title: 'Meeting with Dr Geoffrey Aaron' }), { selfEmail: REP });

  assert.strictEqual(r.status, 'choose');
  assert.strictEqual(r.groups.length, 1);
  assert.strictEqual(r.groups[0].total, 2);
  assert.deepStrictEqual(
    r.groups[0].candidates.map((p) => p.npi),
    ['1000000001', '1000000002']
  );
  // Each card carries what a rep needs to tell two same-named doctors apart.
  assert.strictEqual(r.groups[0].candidates[0].facility.city, 'Chapel Hill');
  assert.strictEqual(r.groups[0].candidates[1].facility.city, 'Durham');
});

test('an attendee display name is used when their address is not in the master', () => {
  const r = matchMeeting(
    event({
      title: 'Dr visit — endoscopy unit',
      attendees: [
        // The name is right; the address is simply not the one BIS holds.
        { name: 'Dr Nicholas Shaheen, MD', email: 'nshaheen@med.unc.edu', type: 'required' },
      ],
    }),
    { selfEmail: REP }
  );

  assert.strictEqual(r.status, 'matched');
  assert.strictEqual(r.via, 'bis-name');
  assert.strictEqual(r.names[0].source, 'attendee');
  assert.deepStrictEqual(
    r.physicians.map((p) => p.npi),
    ['1508935800']
  );
});

test('a gated name in nobody\'s master is handed to the registries, not dropped', () => {
  const r = matchMeeting(event({ title: 'Meeting with Dr John Abernathy' }), { selfEmail: REP });

  assert.strictEqual(r.status, 'needs_external');
  assert.deepStrictEqual(r.unresolvedNames, ['John Abernathy']);
  assert.match(r.reason, /NPPES/);
});

test('"Dr" with no readable full name asks for nothing', () => {
  const r = matchMeeting(event({ title: 'Dr rounds' }), { selfEmail: REP });

  assert.strictEqual(r.status, 'no_name');
  assert.deepStrictEqual(r.physicians, []);
});

// ── Rung 2: a choice the rep already made ───────────────────────────────────

test('a physician the rep picked resolves the meeting with no lookup at all', () => {
  const r = matchMeeting(
    // Ambiguous by name, and the gate is open — but the question was already
    // answered, so it must not be asked again.
    event({ title: 'Meeting with Dr Geoffrey Aaron' }),
    { selfEmail: REP, chosenNpi: '1000000002' }
  );

  assert.strictEqual(r.status, 'matched');
  assert.strictEqual(r.via, 'rep-choice');
  assert.deepStrictEqual(
    r.physicians.map((p) => p.npi),
    ['1000000002']
  );
  assert.deepStrictEqual(r.groups, [], 'no shortlist is rebuilt');
});

test('a choice sticks even on a title the gate would have blocked', () => {
  const r = matchMeeting(event({ title: 'Coffee catch-up' }), {
    selfEmail: REP,
    chosenNpi: '1508935800',
  });

  assert.strictEqual(r.status, 'matched');
  assert.strictEqual(r.via, 'rep-choice');
});

test('an exact attendee email still outranks a stored choice', () => {
  const r = matchMeeting(
    event({
      title: 'Meeting with Dr Geoffrey Aaron',
      attendees: [{ name: 'G Aaron', email: 'gaaron@bis-example.org', type: 'required' }],
    }),
    { selfEmail: REP, chosenNpi: '1508935800' }
  );

  assert.strictEqual(r.via, 'attendee-email');
  assert.deepStrictEqual(
    r.physicians.map((p) => p.npi),
    ['1000000001']
  );
});

test('a stored choice that has left the directory falls back, and says so', () => {
  const r = matchMeeting(event({ title: 'Case obs with Dr Nicholas Shaheen' }), {
    selfEmail: REP,
    chosenNpi: '9999999999', // no longer in the master
  });

  assert.strictEqual(r.status, 'matched');
  assert.strictEqual(r.via, 'bis-name', 'the ladder carries on rather than showing nothing');
  assert.match(r.reason, /Nicholas/);
});

// ── Rung 0: an NPI written on the meeting ────────────────────────────────────

test('an NPI on the meeting outranks everything else, including the email match', () => {
  const r = matchMeeting(
    event({
      title: 'Case review — NPI 1508935800',
      // A different physician's address, matched exactly. The NPI still wins:
      // the rep wrote it down, and it cannot mean two people.
      attendees: [{ name: 'G Aaron', email: 'gaaron@bis-example.org', type: 'required' }],
    }),
    { selfEmail: REP }
  );

  assert.strictEqual(r.status, 'matched');
  assert.strictEqual(r.via, 'meeting-npi');
  assert.strictEqual(r.npi, '1508935800');
  assert.deepStrictEqual(r.physicians.map((p) => p.npi), ['1508935800']);
});

test('an NPI needs no "Dr" in the title — it is not a name to guess at', () => {
  const r = matchMeeting(event({ title: 'Quarterly sync 1508935800' }), { selfEmail: REP });
  assert.strictEqual(r.via, 'meeting-npi');
});

test('an NPI in the body or location counts too', () => {
  const body = matchMeeting(event({ title: 'Case review', description: 'npi: 1508935800' }), {
    selfEmail: REP,
  });
  assert.strictEqual(body.via, 'meeting-npi');

  const loc = matchMeeting(event({ title: 'Case review', location: 'Endoscopy — NPI 1508935800' }), {
    selfEmail: REP,
  });
  assert.strictEqual(loc.via, 'meeting-npi');
});

test('an NPI the master does not have is still an answer, handed to the sources', () => {
  const r = matchMeeting(event({ title: 'Case review NPI 1467521757' }), { selfEmail: REP });

  assert.strictEqual(r.status, 'needs_external');
  assert.strictEqual(r.npi, '1467521757', 'the sources are asked by NPI, not by name');
  assert.deepStrictEqual(r.physicians, []);
  assert.match(r.reason, /not in the BIS master/);
});

test('a ten-digit number that is not an NPI is ignored', () => {
  // The checksum is the whole point: meeting bodies are full of phone numbers,
  // order numbers and conference ids, and briefing a stranger with total
  // confidence is the worst failure this app has.
  assert.strictEqual(isValidNpi('7135550100'), false);
  assert.strictEqual(isValidNpi('1234567890'), false);
  assert.strictEqual(isValidNpi('150893549'), false, 'nine digits');

  const r = matchMeeting(event({ title: 'Call 7135550100 before the demo' }), { selfEmail: REP });
  assert.strictEqual(r.npi, null);
  assert.strictEqual(r.via, null);
});

test('a labelled NPI is preferred over a bare ten-digit run', () => {
  // Both pass the checksum; the labelled one is the one the rep meant.
  assert.strictEqual(isValidNpi('1467521757'), true);
  const r = matchMeeting(
    event({ title: 'Ref 1467521757 · NPI 1508935800', description: '' }),
    { selfEmail: REP }
  );
  assert.strictEqual(r.npi, '1508935800');
});

// ── The gate reads the attendee's name too ───────────────────────────────────

test('an attendee called "Dr …" opens the gate even when the title does not', () => {
  // The case this exists for: the address is not in the master (so the email
  // path is dead) and the title is "Endoscopy sync" — but the invite says
  // "Dr Nicholas Shaheen" in as many words, and that is the only name there is.
  const r = matchMeeting(
    event({
      title: 'Endoscopy sync',
      attendees: [{ name: 'Dr Nicholas Shaheen', email: 'nshaheen@med.unc.edu', type: 'required' }],
    }),
    { selfEmail: REP }
  );

  assert.notStrictEqual(r.status, 'gate_blocked');
  assert.strictEqual(r.gate.pass, true);
  assert.strictEqual(r.gate.where, 'attendee name');
  assert.strictEqual(r.status, 'matched', 'and the name resolves in the master');
});

test('an attendee with no honorific still does not open the gate', () => {
  const r = matchMeeting(
    event({
      title: 'Quarterly review',
      attendees: [{ name: 'Nicholas Shaheen', email: 'nshaheen@med.unc.edu', type: 'required' }],
    }),
    { selfEmail: REP }
  );
  assert.strictEqual(r.status, 'gate_blocked');
});

// ── Which field a half name is searched on ───────────────────────────────────

test('a half name is searched on the field it actually belongs to', () => {
  // "Dr Katie" — the master says the LAST name is missing, so "Katie" is a
  // first name and must be sent as first_name. Sent as last_name (the old
  // behaviour) NPPES returns nobody at all.
  assert.deepStrictEqual(nameSearchKey('Katie', { name: 'Katie', missing: 'last' }), {
    firstName: 'Katie',
    lastName: '',
  });

  // "Dr Khan" — the first name is missing, so this is a surname.
  assert.deepStrictEqual(nameSearchKey('Khan', { name: 'Khan', missing: 'first' }), {
    firstName: '',
    lastName: 'Khan',
  });

  // Cannot tell → the surname, which is the field the registry indexes.
  assert.deepStrictEqual(nameSearchKey('Aagaard', { name: 'Aagaard', missing: 'unknown' }), {
    firstName: '',
    lastName: 'Aagaard',
  });

  // A whole name splits the obvious way, whatever the ladder said.
  assert.deepStrictEqual(nameSearchKey('John R Abernathy', null), {
    firstName: 'John',
    lastName: 'Abernathy',
  });
});

test('a name nobody can place is tried as BOTH halves, surname first', () => {
  // "Dr ABESELOM" — the master has never seen it in either position, and it is
  // in fact a given name. Searching only the surname field returned nobody, and
  // the panel then said the registries had nobody by that name.
  assert.deepStrictEqual(nameSearchKeys('Abeselom', { name: 'Abeselom', missing: 'unknown' }), [
    { firstName: '', lastName: 'Abeselom' },
    { firstName: 'Abeselom', lastName: '' },
  ]);

  // When the master DID place it, there is only one sensible attempt.
  assert.deepStrictEqual(nameSearchKeys('Katie', { name: 'Katie', missing: 'last' }), [
    { firstName: 'Katie', lastName: '' },
  ]);
  assert.deepStrictEqual(nameSearchKeys('Khan', { name: 'Khan', missing: 'first' }), [
    { firstName: '', lastName: 'Khan' },
  ]);

  // A whole name is one attempt, and nameSearchKey still returns the first.
  assert.deepStrictEqual(nameSearchKeys('John R Abernathy'), [
    { firstName: 'John', lastName: 'Abernathy' },
  ]);
  assert.deepStrictEqual(nameSearchKey('Abeselom', { name: 'Abeselom', missing: 'unknown' }), {
    firstName: '',
    lastName: 'Abeselom',
  });
});
