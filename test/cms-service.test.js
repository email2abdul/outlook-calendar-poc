'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * The CMS by-provider-and-service source.
 *
 * The mapping is what these tests pin: which dataset columns become which
 * fields, which years are read, and — the one that matters most — that a
 * dataset which could not be READ is reported as unreachable rather than as a
 * physician who bills nothing.
 *
 * The HTTP layer is stubbed, so this is offline and exact.
 */
const responses = new Map(); // url substring → { ok, body }
const calls = [];

stub('src/enrichment/http', {
  buildUrl(base, params = {}) {
    const url = new URL(base);
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    return url.toString();
  },
  async getJson(url, opts = {}) {
    calls.push({ url, label: opts.label });
    for (const [key, res] of responses) {
      if (url.includes(key)) return { ok: true, status: 200, body: res, error: null, kind: null };
    }
    return { ok: false, status: 0, body: null, error: 'stubbed miss', kind: 'network' };
  },
});

const health = require('../src/enrichment/health');
const cms = require('../src/outside-sources/cms-service');

const CATALOG = {
  dataset: [
    {
      title: 'Medicare Physician & Other Practitioners - by Provider and Service',
      distribution: [
        { title: 'X : 2024-12-01', accessURL: 'https://data.cms.gov/data-api/v1/dataset/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/data' },
        { title: 'X : 2024-12-01', downloadURL: 'https://data.cms.gov/x/PHY_2024.csv' },
        { title: 'X : 2023-12-31', accessURL: 'https://data.cms.gov/data-api/v1/dataset/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/data' },
      ],
    },
  ],
};

const row = (over = {}) => ({
  Rndrng_NPI: '1003000126',
  Rndrng_Prvdr_First_Name: 'Ardalan',
  Rndrng_Prvdr_MI: null,
  Rndrng_Prvdr_Last_Org_Name: 'Enkeshafi',
  Rndrng_Prvdr_Crdntls: 'M.D.',
  Rndrng_Prvdr_Type: 'Internal Medicine',
  Rndrng_Prvdr_St1: '6410 Rockledge Dr',
  Rndrng_Prvdr_St2: 'Ste 304',
  Rndrng_Prvdr_City: 'Bethesda',
  Rndrng_Prvdr_State_Abrvtn: 'MD',
  Rndrng_Prvdr_Zip5: '20817',
  Rndrng_Prvdr_RUCA_Desc: 'Metropolitan area core',
  Rndrng_Prvdr_Mdcr_Prtcptg_Ind: 'Y',
  HCPCS_Cd: '99222',
  HCPCS_Desc: 'Initial hospital care',
  Place_Of_Srvc: 'F',
  Tot_Benes: 150,
  Tot_Srvcs: 150,
  Avg_Sbmtd_Chrg: 400.5,
  Avg_Mdcr_Alowd_Amt: 126.25,
  Avg_Mdcr_Pymt_Amt: 100.1,
  ...over,
});

test('only the configured years are read, newest first', () => {
  const before = process.env.CMS_SERVICE_YEARS;
  delete process.env.CMS_SERVICE_YEARS;
  assert.deepStrictEqual(cms.years(), ['2024', '2023'], 'the agreed default');

  process.env.CMS_SERVICE_YEARS = '2022, 2024,2023';
  assert.deepStrictEqual(cms.years(), ['2024', '2023', '2022'], 'adding a year is config, not code');

  process.env.CMS_SERVICE_YEARS = 'nonsense,2024';
  assert.deepStrictEqual(cms.years(), ['2024']);

  if (before === undefined) delete process.env.CMS_SERVICE_YEARS;
  else process.env.CMS_SERVICE_YEARS = before;
});

test('a dataset row becomes a CPT line', () => {
  const l = cms.toLine(row());
  assert.strictEqual(l.hcpcs, '99222');
  assert.strictEqual(l.description, 'Initial hospital care');
  assert.strictEqual(l.placeOfService, 'facility');
  assert.strictEqual(l.services, 150);
  assert.strictEqual(l.beneficiaries, 150);
  assert.strictEqual(l.avgAllowed, 126.25);
  // A missing number must be null, not 0 — "$0 allowed" would be a claim.
  assert.strictEqual(cms.toLine({}).avgAllowed, null);
  assert.strictEqual(cms.toLine({}).services, null);
});

test("the provider's own details come from the same row", () => {
  const p = cms.toProvider(row(), '2024');
  assert.strictEqual(p.npi, '1003000126');
  assert.strictEqual(p.name, 'Ardalan Enkeshafi');
  assert.strictEqual(p.specialty, 'Internal Medicine');
  assert.strictEqual(p.facilityAddress, '6410 Rockledge Dr Ste 304, Bethesda, MD, 20817');
  assert.strictEqual(p.city, 'Bethesda');
  assert.strictEqual(p.state, 'MD');
  assert.strictEqual(p.zip, '20817');
  assert.strictEqual(p.latestYear, '2024');
});

test('years are aggregated, biggest code first, and totals add up', async () => {
  responses.clear();
  calls.length = 0;
  responses.set('data.json', CATALOG);
  responses.set('aaaaaaaa', [row({ Tot_Srvcs: 10, Avg_Mdcr_Alowd_Amt: 100 }), row({ HCPCS_Cd: '99232', Tot_Srvcs: 40, Tot_Benes: 20, Avg_Mdcr_Alowd_Amt: 50 })]);
  responses.set('bbbbbbbb', [row({ Tot_Srvcs: 5, Avg_Mdcr_Alowd_Amt: 200 })]);

  const r = await cms.getByNpi('1003000126');

  assert.strictEqual(r.name, 'Ardalan Enkeshafi');
  assert.deepStrictEqual(r.years.map((y) => y.year), ['2024', '2023']);
  assert.deepStrictEqual(r.years[0].lines.map((l) => l.hcpcs), ['99232', '99222'], 'by volume');
  assert.strictEqual(r.years[0].services, 50);
  assert.strictEqual(r.years[0].allowed, 10 * 100 + 40 * 50);
  assert.deepStrictEqual(r.unreachableYears, []);
  // The NPI is a filter, not a search term.
  assert.ok(calls.some((c) => c.url.includes('filter%5BRndrng_NPI%5D=1003000126')));
});

test('a year that could not be read is reported, never shown as no billing', async () => {
  responses.clear();
  responses.set('data.json', CATALOG);
  responses.set('aaaaaaaa', [row()]);
  // 2023's dataset answers with a transport failure (the stub's default).

  const r = await cms.getByNpi('1003000126');

  assert.deepStrictEqual(r.years.map((y) => y.year), ['2024']);
  assert.deepStrictEqual(r.unreachableYears, ['2023'], 'the rep must see which year is missing');
});

test('a malformed NPI is not looked up at all', async () => {
  assert.strictEqual(await cms.getByNpi('123'), null);
  assert.strictEqual(await cms.getByNpi(null), null);
});

// ── Name search: the first rung of the ladder now ───────────────────────────

/**
 * A row as the name query asks for it (the provider columns only), plus the
 * entity code that separates a person from a hospital.
 */
const nameRow = (over = {}) => ({
  Rndrng_NPI: '1265847438',
  Rndrng_Prvdr_First_Name: 'John',
  Rndrng_Prvdr_MI: '',
  Rndrng_Prvdr_Last_Org_Name: 'Abernathy',
  Rndrng_Prvdr_Crdntls: 'DO',
  Rndrng_Prvdr_Ent_Cd: 'I',
  Rndrng_Prvdr_Type: 'Internal Medicine',
  Rndrng_Prvdr_St1: '6000 49th St N',
  Rndrng_Prvdr_St2: '',
  Rndrng_Prvdr_City: 'St Petersburg',
  Rndrng_Prvdr_State_Abrvtn: 'FL',
  Rndrng_Prvdr_Zip5: '33709',
  ...over,
});

test('a surname is filtered on, and a first name goes as a KEYWORD', async () => {
  // Two filter[…] params hang this API (measured 2026-09-02), so the first
  // name must never become a second filter. This is that rule, pinned.
  responses.clear();
  calls.length = 0;
  responses.set('data.json', CATALOG);
  responses.set('aaaaaaaa', [nameRow()]);

  const found = await cms.searchByName({ firstName: 'John', lastName: 'Abernathy' });

  const url = new URL(calls.find((c) => c.url.includes('aaaaaaaa')).url);
  assert.strictEqual(url.searchParams.get('filter[Rndrng_Prvdr_Last_Org_Name]'), 'Abernathy');
  assert.strictEqual(url.searchParams.get('keyword'), 'John');
  assert.strictEqual(url.searchParams.get('filter[Rndrng_Prvdr_First_Name]'), null, 'never a second filter');
  assert.ok(url.searchParams.get('column').includes('Rndrng_NPI'), 'provider columns only');

  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].npi, '1265847438');
  assert.strictEqual(found[0].name, 'John Abernathy');
  assert.strictEqual(found[0].primaryTaxonomy, 'Internal Medicine');
  assert.strictEqual(found[0].facilityAddress, '6000 49th St N, St Petersburg, FL, 33709');
  assert.strictEqual(found[0].externalSource, 'cms-service');
  assert.strictEqual(found[0].providerKind.kind, 'doctor', 'CMS states its own words, and they are read');
});

test('one row per code becomes one candidate per PERSON', async () => {
  responses.clear();
  responses.set('data.json', CATALOG);
  responses.set('aaaaaaaa', [
    nameRow({ HCPCS_Cd: '99213' }),
    nameRow({ HCPCS_Cd: '99214' }), // same person, another code
    nameRow({ Rndrng_NPI: '1013169481', Rndrng_Prvdr_First_Name: 'Kathleen', Rndrng_Prvdr_Type: 'Psychiatry', Rndrng_Prvdr_City: 'Yarmouth', Rndrng_Prvdr_State_Abrvtn: 'ME' }),
    nameRow({ Rndrng_NPI: '1999999999', Rndrng_Prvdr_Ent_Cd: 'O', Rndrng_Prvdr_First_Name: '', Rndrng_Prvdr_Last_Org_Name: 'ABERNATHY CLINIC LLC' }),
  ]);

  const found = await cms.searchByName({ lastName: 'Abernathy', limit: 5 });

  assert.deepStrictEqual(found.map((c) => c.npi), ['1265847438', '1013169481'], 'deduped, and no organisation');
  assert.deepStrictEqual(found.map((c) => c.city), ['St Petersburg', 'Yarmouth']);
});

test('a first name that matches nobody costs ranking, not the answer', async () => {
  responses.clear();
  responses.set('data.json', CATALOG);
  responses.set('aaaaaaaa', [nameRow({ Rndrng_Prvdr_First_Name: 'Robert' })]);

  const found = await cms.searchByName({ firstName: 'John', lastName: 'Abernathy' });

  assert.strictEqual(found.length, 1, 'the Abernathy the dataset does hold is still offered');
  assert.strictEqual(found[0].firstName, 'Robert');
});

test('a first name alone has nothing to filter on, so nothing is asked', async () => {
  responses.clear();
  calls.length = 0;
  responses.set('data.json', CATALOG);

  assert.deepStrictEqual(await cms.searchByName({ firstName: 'John' }), []);
  assert.deepStrictEqual(calls, [], 'not even the catalogue is fetched');
});

test('a dataset that could not be read throws, and never reads as "nobody"', async () => {
  responses.clear();
  responses.set('data.json', CATALOG);
  // No dataset response registered → the stub reports a network miss.
  await assert.rejects(
    () => cms.searchByName({ lastName: 'Abernathy' }),
    (err) => err.unreachable === true && /could not be read|unreachable|timed out/i.test(err.message)
  );
});
