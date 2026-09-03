'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * The guard that lets notes and emailed briefs work for a physician the master
 * does not hold — src/routes/api.routes.js physicianOrOutside().
 *
 * Before it, both 404'd for anyone outside BIS: the rep could look a physician
 * up in the registries, read their Medicare volumes, and then not be able to
 * write one note about them. Notes are keyed by NPI and an outside physician has
 * one, so the only question is whether the id is real — which the NPI check
 * digit answers, and which keeps the note store from filling up with phone
 * numbers and typos.
 */
const DIRECTORY = [{ npi: '1508935800', name: 'Nicholas J Shaheen', specialty: 'Gastroenterology' }];

stub('src/supabase', null);
stub('src/physicians', {
  ready: Promise.resolve(),
  getByNpi: (npi) => DIRECTORY.find((p) => p.npi === String(npi)) || null,
  getByEmail: () => null,
  getAllPhysicians: () => DIRECTORY,
  searchByNameTokens: () => [],
  getFacilityById: () => null,
  matchInText: () => [],
});
stub('src/outside-physician-store', {
  enabled: true,
  backendName: () => 'stub',
  // What the rep already confirmed for a meeting, so a brief can say the name.
  listRecent: async () => [{ npi: '1467521757', name: 'NICHOLAS J SHAHEEN' }],
  latestForEvents: async () => new Map(),
  record: async () => null,
  isWorthRecording: () => false,
  mirrorFromPhysician: () => ({}),
});

const { physicianOrOutside } = require('../src/routes/api.routes');

const req = { session: { account: { homeAccountId: 'user-1', username: 'rep@x.com' } } };

test('a physician in the master is returned as before', async () => {
  const who = await physicianOrOutside(req, '1508935800');
  assert.strictEqual(who.inBis, true);
  assert.strictEqual(who.name, 'Nicholas J Shaheen');
  assert.ok(who.physician);
});

test('a valid NPI outside the master is allowed, and named from what the rep confirmed', async () => {
  const who = await physicianOrOutside(req, '1467521757');
  assert.strictEqual(who.inBis, false);
  assert.strictEqual(who.physician, null);
  assert.strictEqual(who.npi, '1467521757');
  assert.strictEqual(who.name, 'NICHOLAS J SHAHEEN', 'not "NPI 1467521757"');
});

test('a valid NPI nobody has confirmed still works, under its number', async () => {
  const who = await physicianOrOutside(req, '1003000126');
  assert.strictEqual(who.inBis, false);
  assert.strictEqual(who.name, 'NPI 1003000126');
});

test('anything that is not an NPI is refused', async () => {
  // A phone number, a typo, a nine-digit id and an empty string all pass a
  // length check and fail the check digit — which is the point of using it.
  for (const bad of ['7135550100', '1234567890', '150893549', '', 'abcdefghij', null]) {
    assert.strictEqual(await physicianOrOutside(req, bad), null, `${bad} must be refused`);
  }
});
