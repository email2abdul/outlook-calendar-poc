'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * "Meeting with Dr JOHN ABERNATHY" — and the CMS billing data answers it.
 *
 * What the rep saw: *"Not in the BIS directory, and the public registries could
 * not be reached — so nothing is known yet about John Abernathy"*, because
 * NPPES's host would not resolve. Meanwhile CMS's
 * medicare-physician-other-practitioners-by-provider-and-service dataset held
 * him all along: **NPI 1265847438, Internal Medicine, DO, St Petersburg FL** —
 * verified by hand against the live API on 2026-09-02.
 *
 * So the ladder now asks CMS first and NPPES second, and this file pins what
 * that means where a rep can see it: one exact match becomes the answer, several
 * become the shortlist, and an NPPES outage cannot report "nothing is known"
 * about somebody CMS has just named.
 */

const CMS_URL =
  'https://data.cms.gov/provider-summary-by-type-of-service/medicare-physician-other-practitioners';

/** A CMS candidate, in the shared record shape its module produces. */
const cmsCandidate = (over = {}) => ({
  npi: '1265847438',
  name: 'John Abernathy',
  firstName: 'John',
  lastName: 'Abernathy',
  specialty: 'Internal Medicine',
  primaryTaxonomy: 'Internal Medicine',
  facilityAddress: '6000 49th St N, St Petersburg, FL, 33709',
  city: 'St Petersburg',
  state: 'FL',
  zip: '33709',
  inBis: false,
  externalSource: 'cms-service',
  externalSourceUrl: CMS_URL,
  extra: { credential: 'DO', medicareYear: '2024' },
  ...over,
});

let answer = { candidates: [], failures: [], answeredBy: null };

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
  list: () => [
    { id: 'cms-service', name: 'CMS Medicare Physician & Other Practitioners', url: CMS_URL },
    { id: 'nppes', name: 'NPPES NPI Registry', url: 'https://npiregistry.cms.hhs.gov/search' },
  ],
  async searchByName() {
    return answer;
  },
});
stub('src/outside-sources/profile', async () => null);

const resolveOutside = require('../src/outside-sources/resolve');

const meeting = (title) => ({
  id: 'EVT-ABE',
  title,
  description: null,
  location: null,
  start: '2026-09-02T18:30:00',
  end: '2026-09-02T19:00:00',
  timeZone: 'UTC',
  type: 'singleInstance',
  seriesMasterId: null,
  organizer: { name: 'Abdul Wajid', email: 'rep@example.com' },
  attendees: [],
});

test('an exact CMS match on a full name IS the answer', async () => {
  answer = { candidates: [cmsCandidate()], failures: [], answeredBy: 'cms-service' };

  const out = await resolveOutside(meeting('Meeting with Dr JOHN ABERNATHY'), {
    selfEmail: 'rep@example.com',
  });

  assert.strictEqual(out.status, 'needs_external');
  assert.strictEqual(out.answeredBy, 'cms-service', 'the panel names the source that answered');
  assert.deepStrictEqual(out.failures, [], 'no outage to report — CMS answered');

  const g = out.groups[0];
  assert.deepStrictEqual(g.candidates.map((c) => c.npi), ['1265847438']);
  assert.strictEqual(g.primaryNpi, '1265847438', 'one exact match needs no picking');
  assert.ok(out.confidence >= out.threshold, `${out.confidence} should clear ${out.threshold}`);
  assert.strictEqual(g.candidates[0].primaryTaxonomy, 'Internal Medicine');
  assert.strictEqual(g.candidates[0].facilityAddress, '6000 49th St N, St Petersburg, FL, 33709');
});

test('several CMS matches become the shortlist, none of them the answer', async () => {
  answer = {
    candidates: [
      cmsCandidate(),
      cmsCandidate({ npi: '1013169481', name: 'Kathleen Abernathy', firstName: 'Kathleen', primaryTaxonomy: 'Psychiatry', city: 'Yarmouth', state: 'ME' }),
      cmsCandidate({ npi: '1063433449', name: 'Robert Abernathy', firstName: 'Robert', primaryTaxonomy: 'Internal Medicine', city: 'Bend', state: 'OR' }),
    ],
    failures: [],
    answeredBy: 'cms-service',
  };

  const out = await resolveOutside(meeting('Meeting with Dr Abernathy'), { selfEmail: 'rep@example.com' });

  assert.strictEqual(out.status, 'partial_name', 'a surname alone is half a name');
  assert.strictEqual(out.groups[0].primaryNpi, null, 'the rep picks');
  assert.strictEqual(out.groups[0].candidates.length, 3);
  for (const c of out.groups[0].candidates) {
    assert.ok(c.primaryTaxonomy, `taxonomy on ${c.npi}`);
    assert.ok(c.facilityAddress, `address on ${c.npi}`);
  }
});

test('an NPPES outage cannot deny a physician CMS has named', async () => {
  // The exact shape of the bug: NPPES's DNS fails, CMS answers first, and the
  // panel must show the person — not "nothing is known about John Abernathy".
  answer = {
    candidates: [cmsCandidate()],
    failures: [],
    answeredBy: 'cms-service',
  };

  const out = await resolveOutside(meeting('Meeting with Dr JOHN ABERNATHY'), {
    selfEmail: 'rep@example.com',
  });

  assert.strictEqual(out.searched, true);
  assert.ok(out.groups[0].candidates.length, 'somebody is on screen');
  assert.deepStrictEqual(out.failures, []);
});

test('both sources down is reported as an outage, and names nobody', async () => {
  answer = {
    candidates: [],
    failures: [
      { source: 'cms-service', name: 'CMS Medicare Physician & Other Practitioners', error: 'could not be read for 2024 (timeout)' },
      { source: 'nppes', name: 'NPPES NPI Registry', error: 'was unreachable — DNS lookup failed' },
    ],
    answeredBy: null,
  };

  const out = await resolveOutside(meeting('Meeting with Dr JOHN ABERNATHY'), {
    selfEmail: 'rep@example.com',
  });

  assert.strictEqual(out.answeredBy, null);
  assert.deepStrictEqual(out.groups[0].candidates, []);
  assert.deepStrictEqual(out.failures.map((f) => f.source), ['cms-service', 'nppes']);
  assert.strictEqual(out.notDoctor, null, 'an outage is not a verdict about the person');
});
