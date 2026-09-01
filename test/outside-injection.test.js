'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * The brief for an outside physician, on the MEETING itself —
 * emailIngest.injectOutsideBrief().
 *
 * The rep will be in Outlook when the meeting starts, not in the app they were
 * in when they identified someone the master has never heard of. Two rules are
 * what these tests hold: the same one-shot key as the BIS injection (a meeting
 * carries one brief, never two), and a source outage must NOT consume it.
 */
const injected = [];
const marked = [];
let profile = null;

stub('src/auth', {});
stub('src/physicians', { getByEmail: () => null, getByNpi: () => null, getFacilityById: () => null, matchInText: () => [] });
stub('src/entity-matcher', { analyze: async () => ({ matched_entities: [], extracted_entities: [] }) });
stub('src/enrichment', { enrich: async () => ({ status: 'unresolved' }) });
stub('src/enrichment/verify', { verifyPhysician: async () => null });
stub('src/analytics', { getLabelledAnalytics: async () => null });
stub('src/contacts-store', { getContact: async () => null });
stub('src/notes', { getNotes: async () => [] });
stub('src/ai-extractor', {});
stub('src/email-intel', {});
stub('src/email-intel-store', {});
stub('src/crm-store', { enabled: false });
stub('src/token-store', {
  wasReminderSent: async (u, key) => marked.includes(key),
  markReminderSent: async (u, key) => marked.push(key),
});
stub('src/graph', {
  outsideBriefHtml: ({ record }) => `<p>brief for ${record.name}</p>`,
  async injectBriefIntoEvent(token, eventId, html) {
    injected.push({ eventId, html });
    return true;
  },
});
stub('src/outside-physician-store', { enabled: false, latestForEvents: async () => new Map() });
stub('src/outside-sources/profile', async () => profile);

const ingest = require('../src/email-ingest');

const USER = { homeAccountId: 'user-1', email: 'rep@lumendi.com' };
const EVENT = { id: 'EV-9', title: 'Endoscopy case obs', start: '2026-09-02T14:00:00', timeZone: 'UTC' };
const DECISION = { npi: '1467521757', name: 'NICHOLAS J SHAHEEN', decidedBy: 'user', confidence: 100, externalSource: 'nppes' };
const PROFILE = {
  record: { npi: '1467521757', name: 'NICHOLAS J SHAHEEN' },
  extra: {}, cms: { years: [] }, agreement: { confirmed: false, on: [], by: [] },
  sourceName: 'NPPES NPI Registry', sourceUrl: 'https://npiregistry.cms.hhs.gov/', failures: [],
};

test('the confirmed physician is written onto the meeting, once', async () => {
  injected.length = 0;
  marked.length = 0;
  profile = PROFILE;

  assert.strictEqual(await ingest.injectOutsideBrief('token', USER, EVENT, DECISION), true);
  assert.strictEqual(injected.length, 1);
  assert.strictEqual(injected[0].eventId, 'EV-9');
  assert.match(injected[0].html, /not in the BIS directory/);
  assert.match(injected[0].html, /You confirmed them for this meeting/);
  assert.match(injected[0].html, /brief for NICHOLAS J SHAHEEN/);
  // The same key the BIS injection uses, so a meeting cannot end up with two.
  assert.deepStrictEqual(marked, ['enriched:EV-9']);

  assert.strictEqual(await ingest.injectOutsideBrief('token', USER, EVENT, DECISION), false);
  assert.strictEqual(injected.length, 1, 'the marker is what stops a second one');
});

test('a source outage leaves the one-shot unspent', async () => {
  injected.length = 0;
  marked.length = 0;
  profile = null;

  assert.strictEqual(await ingest.injectOutsideBrief('token', USER, EVENT, DECISION), false);
  assert.strictEqual(injected.length, 0);
  assert.deepStrictEqual(marked, [], 'the next tick has to be able to try again');
});

test('nothing is injected without a meeting or an NPI', async () => {
  injected.length = 0;
  profile = PROFILE;

  assert.strictEqual(await ingest.injectOutsideBrief('token', USER, { title: 'no id' }, DECISION), false);
  assert.strictEqual(await ingest.injectOutsideBrief('token', USER, EVENT, { decidedBy: 'user' }), false);
  assert.strictEqual(injected.length, 0);
});
