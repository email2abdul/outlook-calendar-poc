'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * The enrichment cascade needs a name it was GIVEN.
 *
 * It used to manufacture one from the address when nobody supplied it, which is
 * how `email2@gmail.com` reached NPPES as surname "MAIL". Now an address alone
 * buys the master lookup and the domain index, and then stops: no registry
 * search, no identity, no brief. The paid web tier — the only thing that can
 * turn an address into a person — waits for the rep to ask (`useWeb=always`).
 *
 * Every source is stubbed, so nothing here touches the network.
 */

const searched = [];

stub('src/physicians', {
  getByEmail: () => null,
  getByNpi: () => null,
  getByFacility: () => [],
  getFacilityById: () => null,
  getAllPhysicians: () => [],
  getAllFacilities: () => [],
});
stub('src/enrichment/cache', { get: async () => null, put: async () => null });
stub('src/enrichment/sources/nppes', {
  async searchIndividuals(q) {
    searched.push(q);
    return [];
  },
  async searchOrganizations() {
    return [];
  },
  async getByNpi() {
    return null;
  },
  providerUrl: (npi) => `https://npiregistry.cms.hhs.gov/provider-view/${npi}`,
  SOURCE_NAME: 'NPPES NPI Registry',
});
stub('src/enrichment/sources/web-identity', {
  enabled: true, // available, and still must not run on its own
  async identify() {
    searched.push({ web: true });
    return null;
  },
  SOURCE_NAME: 'Web (AI-researched)',
});
stub('src/enrichment/sources/cms-provider', {
  getAffiliations: async () => [],
  getHospitalByCcn: async () => null,
  getAffiliatedHospitals: async () => [],
  searchHospitalsByName: async () => [],
  SOURCE_AFFILIATION: 'CMS Facility Affiliation Data',
  SOURCE_HOSPITAL: 'CMS Hospital General Information',
});
stub('src/enrichment/sources/open-payments', {
  getPayments: async () => null,
  summarize: () => null,
  SOURCE_NAME: 'CMS Open Payments',
});
stub('src/enrichment/sources/literature', {
  getPublications: async () => null,
  getTrials: async () => null,
  authorTerm: () => '',
  SOURCE_PUBMED: 'NIH PubMed',
  SOURCE_TRIALS: 'ClinicalTrials.gov',
});

const enrichment = require('../src/enrichment');

test('an address alone searches no registry and names nobody', async () => {
  searched.length = 0;
  const result = await enrichment.enrich({ email: 'email2@gmail.com' });

  assert.deepStrictEqual(searched, [], 'no name was given, so there was nothing to search for');
  assert.strictEqual(result.npi, null);
  assert.strictEqual(result.status, 'unresolved');
  assert.strictEqual(result.profile.fields.name, undefined, 'nobody was named');
});

test('the same address with the rep asking (useWeb=always) may still be researched', async () => {
  searched.length = 0;
  await enrichment.enrich({ email: 'email2@gmail.com', useWeb: 'always' });

  assert.deepStrictEqual(searched, [{ web: true }], 'the paid tier runs only when asked');
});

test('a NAME is what the registry is asked about', async () => {
  searched.length = 0;
  await enrichment.enrich({ email: 'email2@gmail.com', name: 'Geoffrey Aaron' });

  assert.strictEqual(searched.length, 1);
  assert.strictEqual(searched[0].lastName, 'Aaron');
  assert.strictEqual(searched[0].firstName, 'Geoffrey');
});

test('a shared mailbox is not researched even when asked', async () => {
  searched.length = 0;
  const result = await enrichment.enrich({ email: 'scheduling@unch.unc.edu', useWeb: 'always' });

  assert.deepStrictEqual(searched, []);
  assert.ok(
    result.profile.notes.some((n) => /shared\/organisational mailbox/.test(n)),
    'and the profile says why'
  );
});
