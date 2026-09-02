'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * The source registry — src/outside-sources/index.js.
 *
 * What matters here is not NPPES: it is that adding a website changes nothing
 * else, that the sources are asked IN ORDER and the first real answer wins,
 * and above all that a source which could not be REACHED is reported as a
 * failure rather than folded in as "nobody found". The two are different
 * answers and a rep acts differently on each — retry vs. this person is not in
 * the registry.
 */
let behaviour = { candidates: [], throws: null };
let cmsBehaviour = { candidates: [], throws: null };
const asked = [];

stub('src/outside-sources/nppes', {
  id: 'nppes',
  name: 'NPPES NPI Registry',
  url: 'https://npiregistry.cms.hhs.gov/search',
  async searchByName() {
    asked.push('nppes');
    if (behaviour.throws) throw behaviour.throws;
    return behaviour.candidates;
  },
  async getByNpi() {
    return null;
  },
});

stub('src/outside-sources/cms-service', {
  id: 'cms-service',
  name: 'CMS Medicare Physician & Other Practitioners',
  url: 'https://data.cms.gov/provider-summary-by-type-of-service/medicare-physician-other-practitioners',
  async searchByName() {
    asked.push('cms-service');
    if (cmsBehaviour.throws) throw cmsBehaviour.throws;
    return cmsBehaviour.candidates;
  },
  async getByNpi() {
    return null;
  },
});

/** Every test starts with both sources quiet and nothing asked. */
function reset() {
  behaviour = { candidates: [], throws: null };
  cmsBehaviour = { candidates: [], throws: null };
  asked.length = 0;
}

const sources = require('../src/outside-sources');

test('a registered source is listed with the page a rep can open', () => {
  const list = sources.list();
  assert.ok(list.some((s) => s.id === 'nppes'));
  for (const s of list) assert.match(s.url, /^https:\/\//, `${s.id} needs a human page`);
  assert.strictEqual(sources.byId('nppes').name, 'NPPES NPI Registry');
  assert.strictEqual(sources.byId('nope'), null);
});

test('a name is asked of CMS first, and NPPES only if it has nobody', () => {
  // The rep's rule: a hit in the billing data means the physician actually
  // bills Medicare, so that dataset leads. NPPES is the fallback, not the
  // front door.
  assert.deepStrictEqual(sources.nameSearchable().map((s) => s.id), ['cms-service', 'nppes']);
});

test('the first source that answers is the answer — the next is never asked', async () => {
  reset();
  cmsBehaviour = { candidates: [{ npi: '1265847438', name: 'John Abernathy' }], throws: null };
  behaviour = { candidates: [{ npi: '9999999999', name: 'Someone Else' }], throws: null };

  const { candidates, failures, answeredBy } = await sources.searchByName({ lastName: 'Abernathy' });

  assert.deepStrictEqual(asked, ['cms-service'], 'NPPES was not asked at all');
  assert.strictEqual(answeredBy, 'cms-service');
  assert.deepStrictEqual(candidates.map((c) => c.npi), ['1265847438']);
  assert.deepStrictEqual(failures, []);
});

test('CMS having nobody hands the name to NPPES', async () => {
  reset();
  behaviour = { candidates: [{ npi: '1', name: 'A B' }], throws: null };

  const { candidates, failures, answeredBy } = await sources.searchByName({ lastName: 'B' });

  assert.deepStrictEqual(asked, ['cms-service', 'nppes']);
  assert.strictEqual(answeredBy, 'nppes');
  assert.deepStrictEqual(failures, []);
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].externalSource, 'nppes');
  assert.match(candidates[0].externalSourceUrl, /npiregistry/);
});

test('CMS being unreachable is a failure, and NPPES still gets asked', async () => {
  reset();
  const err = new Error('CMS Medicare … could not be read for 2024 (timeout)');
  err.unreachable = true;
  cmsBehaviour = { candidates: [], throws: err };
  behaviour = { candidates: [{ npi: '1', name: 'A B' }], throws: null };

  const { candidates, failures, answeredBy } = await sources.searchByName({ lastName: 'B' });

  assert.deepStrictEqual(asked, ['cms-service', 'nppes'], 'one outage costs a rung, not the answer');
  assert.strictEqual(answeredBy, 'nppes');
  assert.strictEqual(candidates.length, 1);
  assert.deepStrictEqual(failures.map((f) => f.source), ['cms-service']);
});

test('every source unreachable is two failures, and still nobody invented', async () => {
  reset();
  const dns = new Error('NPPES NPI Registry was unreachable — DNS lookup failed');
  dns.unreachable = true;
  const cms = new Error('CMS Medicare … could not be read for 2024 (timeout)');
  cms.unreachable = true;
  behaviour = { candidates: [], throws: dns };
  cmsBehaviour = { candidates: [], throws: cms };

  const { candidates, failures, answeredBy } = await sources.searchByName({ lastName: 'B' });

  assert.deepStrictEqual(candidates, [], 'nothing is invented');
  assert.strictEqual(answeredBy, null);
  assert.deepStrictEqual(failures.map((f) => f.source), ['cms-service', 'nppes']);
  assert.match(failures[1].error, /unreachable/);
});

test('sources that genuinely found nobody report no failure', async () => {
  reset();

  const { candidates, failures } = await sources.searchByName({ lastName: 'Nobody' });

  assert.deepStrictEqual(asked, ['cms-service', 'nppes'], 'both were asked');
  assert.deepStrictEqual(candidates, []);
  assert.deepStrictEqual(failures, [], 'an empty registry is an answer');
});
