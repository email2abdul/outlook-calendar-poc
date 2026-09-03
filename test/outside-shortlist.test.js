'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * "Dr. AJJARAPU" — a surname, and five people who hold it.
 *
 * What the rep saw: **"Not a physician — no pre-meeting brief"**, naming a
 * medical student in Sacramento. What NPPES actually holds under AJJARAPU: that
 * student, a pharmacist, and three physicians — an OB/GYN, a family doctor and
 * a hospitalist. One of those three is who the meeting is with.
 *
 * The bug was a confusion between two different questions. A surname alone
 * scores every real match the same 55%, which is below the offer bar, so the
 * shortlist came back empty — and "nothing was offered" was then read as
 * "everybody was refused", i.e. nobody here is a doctor. So the app reported
 * the one person it had refused.
 *
 * The rule this file holds: the bar filters a shortlist, it never empties one,
 * and only a group whose EVERY match is a non-doctor says "not a physician".
 * The rep picks from the options — full name, primary taxonomy, address.
 *
 * The candidate rows are the real registry rows for that surname.
 */

// ── the five AJJARAPUs, as the registry returns them ────────────────────────
const AJJARAPU = [
  {
    npi: '1962253070', name: 'APARNA SAI AJJARAPU', firstName: 'APARNA', lastName: 'AJJARAPU',
    primaryTaxonomy: 'Student in an Organized Health Care Education/Training Program',
    primaryTaxonomyCode: '390200000X',
    facilityAddress: '4860 Y ST STE 2400', city: 'SACRAMENTO', state: 'CA', phone: '916-734-6602',
    externalSource: 'nppes',
  },
  {
    npi: '1184243511', name: 'AVANTHI AJJARAPU', firstName: 'AVANTHI', lastName: 'AJJARAPU',
    primaryTaxonomy: 'Obstetrics & Gynecology', primaryTaxonomyCode: '207V00000X',
    facilityAddress: '801 7TH AVE', city: 'FORT WORTH', state: 'TX', phone: '682-885-4000',
    externalSource: 'nppes',
  },
  {
    npi: '1952630725', name: 'ESTHER AJJARAPU', firstName: 'ESTHER', lastName: 'AJJARAPU',
    primaryTaxonomy: 'Family Medicine', primaryTaxonomyCode: '207Q00000X',
    facilityAddress: '1227 BALTIMORE ST', city: 'HANOVER', state: 'PA', phone: '717-812-5190',
    externalSource: 'nppes',
  },
  {
    npi: '1841501699', name: 'JOSHUA AJJARAPU', firstName: 'JOSHUA', lastName: 'AJJARAPU',
    primaryTaxonomy: 'Hospitalist', primaryTaxonomyCode: '208M00000X',
    facilityAddress: '3 ERIE CT', city: 'OAK PARK', state: 'IL', phone: '708-763-1222',
    externalSource: 'nppes',
  },
  {
    npi: '1528485596', name: 'MATHEW AJJARAPU', firstName: 'MATHEW', lastName: 'AJJARAPU',
    primaryTaxonomy: 'Pharmacist', primaryTaxonomyCode: '1835P1200X',
    facilityAddress: '1740 W TAYLOR ST', city: 'CHICAGO', state: 'IL', phone: '312-996-4275',
    externalSource: 'nppes',
  },
];

stub('src/supabase', null);
stub('src/physicians', {
  ready: Promise.resolve(),
  getByNpi: () => null,
  getByEmail: () => null,
  getAllPhysicians: () => [],
  getAllFacilities: () => [],
  getFacilityById: () => null,
  getByFacility: () => [],
  searchByNameTokens: () => [],
  matchInText: () => [],
});
stub('src/outside-physician-store', {
  enabled: false,
  backendName: () => 'stub',
  latestForEvents: async () => new Map(),
  latestForEvent: async () => null,
  record: async () => null,
  isWorthRecording: () => false,
  mirrorFromPhysician: () => ({}),
});
stub('src/entity-matcher', { analyze: async () => ({ matched_entities: [], extracted_entities: [] }) });
stub('src/outside-sources', {
  list: () => [{ id: 'nppes', name: 'NPPES NPI Registry', url: 'https://npiregistry.cms.hhs.gov' }],
  async searchByName(attempt) {
    // Only the surname search returns anything, exactly as the registry does.
    const wanted = String(attempt.lastName || '').toUpperCase();
    return { candidates: wanted === 'AJJARAPU' ? AJJARAPU.map((c) => ({ ...c })) : [], failures: [] };
  },
});
stub('src/outside-sources/profile', async () => null);

const score = require('../src/outside-sources/score');
const resolveOutside = require('../src/outside-sources/resolve');

const EVENT = {
  id: 'EVT-AJJ',
  title: 'Meeting with Dr. AJJARAPU',
  description: null,
  location: null,
  start: '2026-09-02T16:30:00',
  end: '2026-09-02T17:00:00',
  timeZone: 'UTC',
  type: 'singleInstance',
  seriesMasterId: null,
  organizer: { name: 'Abdul Wajid', email: 'rep@example.com' },
  attendees: [],
};

// ── the scorer ──────────────────────────────────────────────────────────────

test('a surname alone still offers the physicians it found', () => {
  const ranked = score.rankCandidates(AJJARAPU, { lastName: 'AJJARAPU' }, { max: 5 });

  assert.strictEqual(ranked.offered.length, 3, 'the three doctors are the shortlist');
  assert.deepStrictEqual(
    ranked.offered.map((c) => c.name).sort(),
    ['AVANTHI AJJARAPU', 'ESTHER AJJARAPU', 'JOSHUA AJJARAPU']
  );
  assert.ok(
    ranked.offered.every((c) => c.confidence < score.CONFIDENCE_OFFER),
    'none of them clears the offer bar — and they are offered anyway'
  );
  assert.strictEqual(ranked.primary, null, 'nothing is auto-shown; the rep picks');
  assert.strictEqual(ranked.notDoctor, null, 'doctors were found, so this is not a non-doctor answer');
  assert.deepStrictEqual(
    ranked.refused.map((c) => c.name).sort(),
    ['APARNA SAI AJJARAPU', 'MATHEW AJJARAPU'],
    'the student and the pharmacist are named, not offered'
  );
  assert.strictEqual(ranked.dropped, 0, 'nobody eligible is hidden');
});

test('the bar still filters when somebody better exists', () => {
  // Same five people, and now the meeting says FORT WORTH: one match rises
  // above the bar, so the 55% guesses go back to being noise.
  const ranked = score.rankCandidates(
    AJJARAPU,
    { lastName: 'AJJARAPU', city: 'FORT WORTH', state: 'TX', text: 'meeting in fort worth' },
    { max: 5 }
  );

  assert.deepStrictEqual(ranked.offered.map((c) => c.name), ['AVANTHI AJJARAPU']);
  assert.strictEqual(ranked.dropped, 2, 'the other two doctors are counted, not shown');
});

test('the shortlist is capped, and the rest are counted', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    ...AJJARAPU[1],
    npi: `19622530${70 + i}`,
    firstName: `DOC${i}`,
    name: `DOC${i} AJJARAPU`,
  }));
  const ranked = score.rankCandidates(many, { lastName: 'AJJARAPU' }, { max: 5 });

  assert.strictEqual(ranked.offered.length, 5);
  assert.strictEqual(ranked.dropped, 4);
});

// ── the whole answer ────────────────────────────────────────────────────────

test('the meeting resolves to a shortlist, not to "not a physician"', async () => {
  const answer = await resolveOutside(EVENT, { selfEmail: 'rep@example.com' });

  assert.strictEqual(answer.status, 'partial_name');
  assert.strictEqual(answer.notDoctor, null, 'the student must not be reported as the answer');
  assert.strictEqual(answer.brief, null, 'nothing is briefed until the rep picks');

  const g = answer.groups[0];
  assert.strictEqual(g.name, 'Ajjarapu');
  assert.strictEqual(g.candidates.length, 3);
  assert.strictEqual(g.primaryNpi, null);

  // What the rep needs on every row to be able to choose: the full name, what
  // kind of doctor, and where they practise.
  for (const c of g.candidates) {
    assert.ok(c.name && c.name.split(/\s+/).length >= 2, `full name on ${c.npi}`);
    assert.ok(c.primaryTaxonomy, `primary taxonomy on ${c.npi}`);
    assert.ok(c.facilityAddress && c.city && c.state, `practice address on ${c.npi}`);
  }

  assert.deepStrictEqual(
    g.refused.map((r) => r.taxonomy).sort(),
    ['Pharmacist', 'Student in an Organized Health Care Education/Training Program']
  );
});

test('when every match really is a non-doctor, that is still the answer', async () => {
  const sources = require('../src/outside-sources');
  const original = sources.searchByName;
  sources.searchByName = async () => ({
    candidates: [AJJARAPU[0], AJJARAPU[4]].map((c) => ({ ...c })), // student + pharmacist
    failures: [],
  });
  try {
    const answer = await resolveOutside(EVENT, { selfEmail: 'rep@example.com' });
    assert.strictEqual(answer.status, 'not_doctor');
    assert.strictEqual(answer.notDoctor.npi, '1962253070');
    assert.match(answer.notDoctor.taxonomy, /Student in an Organized Health Care/);
    assert.ok(answer.notDoctor.html.includes('1962253070'));
  } finally {
    sources.searchByName = original;
  }
});
