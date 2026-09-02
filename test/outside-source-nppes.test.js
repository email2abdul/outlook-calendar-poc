'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * The NPPES adapter — src/outside-sources/nppes.js.
 *
 * The registry module underneath is stubbed, so this checks the MAPPING (and the
 * rules around it) without a network: which fields cross over, which stay null,
 * and what counts as "extra". The live registry is checked separately; the point
 * here is that the shape never drifts from the store's.
 */
const providers = [];
let lastQuery = null;

stub('src/enrichment/sources/nppes', {
  SOURCE_NAME: 'NPPES NPI Registry',
  async searchIndividuals(q) {
    lastQuery = q;
    return providers;
  },
  async getByNpi(npi) {
    return providers.find((p) => p.npi === String(npi)) || null;
  },
});

const nppes = require('../src/outside-sources/nppes');

const provider = (over = {}) => ({
  npi: '1234567890',
  firstName: 'John',
  middleName: null,
  lastName: 'Abernathy',
  name: 'John Abernathy',
  credential: 'MD',
  status: 'A',
  enumerationDate: '2005-06-01',
  specialty: 'Gastroenterology',
  taxonomies: [{ desc: 'Gastroenterology' }, { desc: 'Internal Medicine' }],
  license: 'G12345',
  licenseState: 'TX',
  address: '1 Main St, Houston, TX 77002',
  city: 'Houston',
  state: 'TX',
  zip: '77002',
  phone: '713-555-0100',
  sourceUrl: 'https://npiregistry.cms.hhs.gov/provider-view/1234567890',
  ...over,
});

test('a provider maps onto the store\'s own field names', async () => {
  providers.length = 0;
  providers.push(provider());

  const [c] = await nppes.searchByName({ firstName: 'John', lastName: 'Abernathy' });

  assert.strictEqual(c.npi, '1234567890');
  assert.strictEqual(c.name, 'John Abernathy');
  assert.strictEqual(c.specialty, 'Gastroenterology');
  assert.strictEqual(c.phone, '713-555-0100');
  assert.strictEqual(c.city, 'Houston');
  assert.strictEqual(c.state, 'TX');
  assert.strictEqual(c.facilityAddress, '1 Main St, Houston, TX 77002');
  assert.strictEqual(c.externalSource, 'nppes');
  assert.match(c.externalSourceUrl, /provider-view\/1234567890/);
  assert.strictEqual(c.inBis, false);
});

test('what the registry cannot know stays null, never a guess', async () => {
  providers.length = 0;
  providers.push(provider());

  const [c] = await nppes.searchByName({ lastName: 'Abernathy' });

  // NPPES has no email field at all — inventing one is how a rep ends up
  // mailing the wrong person.
  assert.strictEqual(c.email, null);
  // "Unknown", which is not the same as "No".
  assert.strictEqual(c.esdProcedure, null);
  // No BIS facility unless a re-match finds one.
  assert.strictEqual(c.facilityId, null);
  assert.strictEqual(c.facilityName, null);
  assert.strictEqual(c.healthSystem, null);
  assert.strictEqual(c.linkedinUrl, null);
});

test('licence, taxonomies and NPI status are EXTRA, not mirror fields', async () => {
  providers.length = 0;
  providers.push(provider());

  const [c] = await nppes.searchByName({ lastName: 'Abernathy' });

  assert.strictEqual(c.extra.credential, 'MD');
  assert.strictEqual(c.extra.licenseNumber, 'G12345');
  assert.strictEqual(c.extra.licenseState, 'TX');
  assert.strictEqual(c.extra.npiStatus, 'A');
  assert.deepStrictEqual(c.extra.taxonomies, ['Gastroenterology', 'Internal Medicine']);
  // Extra must not leak into the mirror — nothing here is stored.
  assert.ok(!('credential' in c), 'credential is not a store column');
});

test('a single initial is never sent to the API', async () => {
  providers.length = 0;
  providers.push(provider());

  await nppes.searchByName({ firstName: 'J.', lastName: 'Abernathy', state: 'Texas' });
  assert.strictEqual(lastQuery.firstName, undefined, 'the API rejects a one-character wildcard');
  assert.strictEqual(lastQuery.state, 'TX', 'a state name is sent as its code');

  await nppes.searchByName({ firstName: 'John', lastName: 'Abernathy' });
  assert.strictEqual(lastQuery.firstName, 'John');
});

test('a city hint narrows the list, but never empties it', async () => {
  providers.length = 0;
  providers.push(provider({ npi: '1111111111', city: 'Houston' }));
  providers.push(provider({ npi: '2222222222', city: 'Dallas' }));

  const houston = await nppes.searchByName({ lastName: 'Abernathy', city: 'Houston' });
  assert.deepStrictEqual(houston.map((c) => c.npi), ['1111111111']);

  // A wrong hint should cost ranking, not the whole answer.
  const nowhere = await nppes.searchByName({ lastName: 'Abernathy', city: 'Reykjavik' });
  assert.deepStrictEqual(nowhere.map((c) => c.npi), ['1111111111', '2222222222']);
});

test('either half of the name is searchable; neither is not', async () => {
  providers.length = 0;
  providers.push(provider());

  // Verified against the live API 2026-09-01: first_name alone returns results
  // (`first_name=KATIE&state=CA` → the Salinas counselor), so a meeting that
  // only says "Dr Katie" is not a dead end — it just scores low, and the notes
  // ask for the surname.
  const byFirst = await nppes.searchByName({ firstName: 'John' });
  assert.strictEqual(byFirst.length, 1);
  assert.strictEqual(lastQuery.firstName, 'John');
  assert.strictEqual(lastQuery.lastName, undefined);

  // An initial is not a name, and NPPES rejects a one-character wildcard.
  assert.deepStrictEqual(await nppes.searchByName({ firstName: 'J.' }), []);
  assert.deepStrictEqual(await nppes.searchByName({}), []);
});
