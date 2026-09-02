'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * The ingest tick resolving a meeting outside the master —
 * emailIngest.briefOutsideMatch().
 *
 * The bug it exists to close: the panel and the tick asked the question in two
 * different places, so the browser showed "ABESELOM GELETU · 95%" while the
 * meeting body in Outlook stayed empty. They now call the same resolver, and
 * this pins what the tick DOES with each answer.
 */
const injected = [];
const marked = [];
const recorded = [];
let answer = null;

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
let reread = null; // what the tick gets when it re-reads the meeting
stub('src/graph', {
  outsideBriefHtml: ({ record }) => `<p>brief for ${record.name}</p>`,
  notDoctorHtml: () => '<p>not a doctor</p>',
  async getEventById() {
    return reread;
  },
  async injectBriefIntoEvent(token, eventId, html) {
    injected.push({ eventId, html });
    return true;
  },
});
stub('src/outside-physician-store', {
  enabled: true,
  backendName: () => 'stub',
  latestForEvents: async () => new Map(),
  latestForEvent: async () => null,
  mirrorFromPhysician: () => ({}),
  isWorthRecording: () => false,
  async record(row) {
    recorded.push(row);
    return { id: recorded.length, ...row };
  },
});
const resolvedOn = [];
stub('src/outside-sources/resolve', async (event) => {
  resolvedOn.push(event);
  return answer;
});
stub('src/outside-sources/profile', async () => null);

const ingest = require('../src/email-ingest');

const USER = { homeAccountId: 'user-1', email: 'rep@lumendi.com' };
const EVENT = {
  id: 'EV-42',
  title: 'Meeting with Dr ABESELOM',
  description: 'Primary Taxonomy - Internal Medicine from CHICAGO',
  start: '2026-09-02T14:30:00',
  timeZone: 'UTC',
  seriesMasterId: null,
};

const CONFIDENT = {
  status: 'partial_name',
  searched: true,
  confidence: 95,
  failures: [],
  primary: {
    npi: '1033798905',
    name: 'ABESELOM GELETU',
    externalSource: 'nppes',
    matchReasons: ['first name matches', 'the meeting mentions this city'],
  },
  profile: {
    record: { npi: '1033798905', name: 'ABESELOM GELETU', specialty: 'Internal Medicine, Hematology & Oncology' },
    extra: {},
    cms: { years: [] },
    agreement: { confirmed: false, on: [], by: [] },
    sourceName: 'NPPES NPI Registry',
    sourceUrl: 'https://npiregistry.cms.hhs.gov/provider-view/1033798905',
  },
};

const reset = () => {
  injected.length = 0;
  marked.length = 0;
  recorded.length = 0;
  resolvedOn.length = 0;
  reread = EVENT;
};

test('a confident answer is written onto the meeting and recorded', async () => {
  reset();
  answer = CONFIDENT;

  assert.strictEqual(await ingest.briefOutsideMatch('token', USER, EVENT), true);

  assert.strictEqual(injected.length, 1);
  assert.strictEqual(injected[0].eventId, 'EV-42');
  assert.match(injected[0].html, /brief for ABESELOM GELETU/);

  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].npi, '1033798905');
  assert.strictEqual(recorded[0].status, 'briefed');
  assert.strictEqual(recorded[0].decidedBy, 'system');
  assert.strictEqual(recorded[0].source, 'outside');
  assert.strictEqual(recorded[0].confidence, 95);
  // …which is what lets the reminder engine send the same brief later.
});

test('the lookup runs once per meeting, and once more when the text changes', async () => {
  reset();
  answer = CONFIDENT;

  await ingest.briefOutsideMatch('token', USER, EVENT);
  assert.strictEqual(injected.length, 1);

  // Same meeting, same words → nothing again (two registries per tick is not
  // free, and the answer cannot have changed).
  assert.strictEqual(await ingest.briefOutsideMatch('token', USER, EVENT), false);
  assert.strictEqual(recorded.length, 1);

  // The rep edits the description in Outlook — so it is what GRAPH returns that
  // changes, and that edit IS the answer, so it must be picked up. (The brief
  // itself is still one per meeting: the injection has its own marker.)
  reread = { ...EVENT, description: 'Primary Taxonomy - Gastroenterology from CHICAGO' };
  assert.strictEqual(await ingest.briefOutsideMatch('token', USER, EVENT), true);
  assert.strictEqual(recorded.length, 2);
});

test('a non-physician is recorded as such, and nothing is written onto the meeting', async () => {
  reset();
  answer = {
    status: 'not_doctor',
    searched: true,
    reason: 'Social Worker is in NUCC grouping 10 — not a physician, dentist or podiatrist.',
    failures: [],
    notDoctor: { npi: '1487300471', name: 'TAYLOR M AAGAARD', taxonomy: 'Social Worker', html: '<p>x</p>' },
    primary: null,
    profile: null,
  };

  assert.strictEqual(await ingest.briefOutsideMatch('token', USER, EVENT), true);

  assert.deepStrictEqual(injected, [], 'there is no brief to write');
  assert.strictEqual(recorded[0].status, 'not_doctor');
  assert.strictEqual(recorded[0].specialty, 'Social Worker');
});

test('a source outage does not consume the one lookup', async () => {
  reset();
  answer = {
    status: 'partial_name',
    searched: true,
    failures: [{ source: 'nppes', name: 'NPPES NPI Registry', error: 'DNS lookup failed' }],
    primary: null,
    profile: null,
    notDoctor: null,
  };

  assert.strictEqual(await ingest.briefOutsideMatch('token', USER, EVENT), false);
  assert.deepStrictEqual(marked, [], 'the next tick has to be able to try again');
  assert.deepStrictEqual(recorded, []);
});

test('an answer that is not confident enough is left for the rep', async () => {
  reset();
  answer = { status: 'partial_name', searched: true, failures: [], primary: null, profile: null, notDoctor: null };

  // Dealt with (do not fall through to the old agent), but nothing is written or
  // recorded: the panel will offer the candidates and the rep decides.
  assert.strictEqual(await ingest.briefOutsideMatch('token', USER, EVENT), true);
  assert.deepStrictEqual(injected, []);
  assert.deepStrictEqual(recorded, []);
});

test("the tick decides on the meeting re-read in full, not on our own brief", async () => {
  reset();
  answer = CONFIDENT;

  // What the 30-day sync hands the tick once a brief has been injected: the
  // preview is our own text and the rep's line is past Outlook's 255 characters.
  const fromSync = {
    ...EVENT,
    description: '🩺 BIS pre-meeting brief ABESELOM GELETU is not in the BIS directory. The notes below…',
  };
  // What graph.getEventById returns — the body, with our block stripped out.
  reread = { ...EVENT, description: 'Primary Taxonomy - Internal Medicine from CHICAGO' };

  await ingest.briefOutsideMatch('token', USER, fromSync);

  assert.strictEqual(resolvedOn.length, 1);
  assert.strictEqual(
    resolvedOn[0].description,
    'Primary Taxonomy - Internal Medicine from CHICAGO',
    'deciding on our own output is how a 100% match became "none over 70%"'
  );
  // …and the dedupe key follows the re-read text, so a brief already injected
  // does not look like an edit on the next tick. (`marked` also holds the
  // injection's own one-shot key, which is a different guard.)
  const lookupKeys = marked.filter((k) => k.startsWith('outside:'));
  assert.strictEqual(lookupKeys.length, 1);
  assert.ok(marked.some((k) => k.startsWith('enriched:')), 'and the brief was written once');
});

test('the injected brief says how it was decided', async () => {
  reset();
  answer = CONFIDENT;
  // A system match must not claim the rep confirmed it — that changes how much
  // they trust the numbers underneath.
  await ingest.injectOutsideBrief(
    'token',
    USER,
    EVENT,
    { npi: '1', name: 'ABESELOM GELETU', decidedBy: 'system', confidence: 95, matchReasons: ['first name matches'] },
    CONFIDENT.profile
  );
  assert.match(injected[0].html, /Matched outside BIS at 95% confidence/);
  assert.ok(!/You confirmed them/.test(injected[0].html));

  injected.length = 0;
  marked.length = 0;
  await ingest.injectOutsideBrief('token', USER, EVENT, { npi: '1', name: 'X', decidedBy: 'user' }, CONFIDENT.profile);
  assert.match(injected[0].html, /You confirmed them for this meeting/);
});
