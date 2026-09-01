'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * The source registry — src/outside-sources/index.js.
 *
 * What matters here is not NPPES: it is that adding a website changes nothing
 * else, that sources are asked in parallel, and above all that a source which
 * could not be REACHED is reported as a failure rather than folded in as
 * "nobody found". The two are different answers and a rep acts differently on
 * each — retry vs. this person is not in the registry.
 */
let behaviour = { candidates: [], throws: null };

stub('src/outside-sources/nppes', {
  id: 'nppes',
  name: 'NPPES NPI Registry',
  url: 'https://npiregistry.cms.hhs.gov/search',
  async searchByName() {
    if (behaviour.throws) throw behaviour.throws;
    return behaviour.candidates;
  },
  async getByNpi() {
    return null;
  },
});

const sources = require('../src/outside-sources');

test('a registered source is listed with the page a rep can open', () => {
  const list = sources.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, 'nppes');
  assert.match(list[0].url, /^https:\/\//);
  assert.strictEqual(sources.byId('nppes').name, 'NPPES NPI Registry');
  assert.strictEqual(sources.byId('nope'), null);
});

test("each candidate carries which source answered, and where to verify it", async () => {
  behaviour = { candidates: [{ npi: '1', name: 'A B' }], throws: null };

  const { candidates, failures } = await sources.searchByName({ lastName: 'B' });

  assert.deepStrictEqual(failures, []);
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].externalSource, 'nppes');
  assert.match(candidates[0].externalSourceUrl, /npiregistry/);
});

test('a source that could not be reached is a failure, not an empty answer', async () => {
  const err = new Error('NPPES NPI Registry was unreachable — DNS lookup failed');
  err.unreachable = true;
  behaviour = { candidates: [], throws: err };

  const { candidates, failures } = await sources.searchByName({ lastName: 'B' });

  assert.deepStrictEqual(candidates, [], 'nothing is invented');
  assert.strictEqual(failures.length, 1);
  assert.strictEqual(failures[0].source, 'nppes');
  assert.match(failures[0].error, /unreachable/);
});

test('a source that genuinely found nobody reports no failure', async () => {
  behaviour = { candidates: [], throws: null };

  const { candidates, failures } = await sources.searchByName({ lastName: 'Nobody' });

  assert.deepStrictEqual(candidates, []);
  assert.deepStrictEqual(failures, [], 'an empty registry is an answer');
});
