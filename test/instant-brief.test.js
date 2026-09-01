'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * The instant-brief counterpart of the recurring-series bug.
 *
 * `syncActivities()` instant-briefs a physician meeting the first time it sees
 * it — gated on "no activity row for this event id yet". calendarView expands a
 * recurring series into one event per occurrence, so on a first sync EVERY
 * occurrence is unseen and every one had its own `instant:<eventId>` key: one
 * weekly meeting with a BIS-matched physician mailed the rep ~29 identical
 * "🆕 New meeting" briefs.
 *
 * Runs offline — everything email-ingest touches is stubbed.
 */

const calls = { briefs: [], injected: [], upserts: [] };
const sentLog = new Set(); // stands in for the SQLite reminders_sent table
const activities = new Map(); // eventId → row, as app_activities would hold them

const AARON = { npi: '1467521757', name: 'Geoffrey Aaron', email: 'geoffrey.aaron@unchealth.org' };
const SHAHEEN = { npi: '1508935800', name: 'Nicholas Shaheen', email: 'nshaheen@med.unc.edu' };
const DIRECTORY = new Map([[AARON.email, AARON], [SHAHEEN.email, SHAHEEN]]);

let upcoming = [];

stub('src/auth', {});
stub('src/physicians', {
  getByEmail: (e) => DIRECTORY.get(String(e || '').toLowerCase()) || null,
  getByNpi: () => null,
  getFacilityById: () => null,
});
stub('src/entity-matcher', { analyze: async () => ({ matched_entities: [], extracted_entities: [] }) });
stub('src/enrichment', { enrich: async () => ({ status: 'unresolved', confidence: 0 }) });
stub('src/enrichment/verify', { verifyPhysician: async () => null });
stub('src/notes', { getNotes: async () => [] });
stub('src/analytics', { getLabelledAnalytics: async () => null });
stub('src/contacts-store', { getContact: async () => null });
stub('src/ai-extractor', {});
stub('src/email-intel', {});
stub('src/email-intel-store', {});

stub('src/crm-store', {
  enabled: true,
  async findActivityByEventId(userId, eventId) {
    return activities.get(eventId) || null;
  },
  async upsertActivityFromEvent(userId, ev) {
    calls.upserts.push(ev.id);
    const row = { id: `act-${ev.id}`, event_id: ev.id };
    activities.set(ev.id, row);
    return row;
  },
});

stub('src/token-store', {
  async wasReminderSent(userId, key) {
    return sentLog.has(`${userId}|${key}`);
  },
  async markReminderSent(userId, key) {
    sentLog.add(`${userId}|${key}`);
  },
});

stub('src/graph', {
  async getUpcomingEvents() {
    return upcoming;
  },
  async sendPhysiciansBriefing(token, opts) {
    calls.briefs.push({ title: opts.event.title, subject: opts.subject });

  },
  buildBriefingContent: () => '<p>brief</p>',
  externalBriefHtml: () => '<p>brief</p>',
  async injectBriefIntoEvent(token, eventId) {
    calls.injected.push(eventId);
    return true;
  },
});

// The decision store is not what these tests are about, and letting the real one
// run would write test rows into data/outside-physicians.db (the SQLite fallback
// the store uses until the Supabase table exists).
stub('src/outside-physician-store', {
  enabled: false, // recordDecision() and the batched read both no-op
  latestForEvents: async () => new Map(),
  latestForEvent: async () => null,
  record: async () => null,
  isWorthRecording: () => false,
  mirrorFromPhysician: () => ({}),
  backendName: () => 'stub',
});

const ingest = require('../src/email-ingest');

// ── fixtures ────────────────────────────────────────────────────────────────

const USER = { homeAccountId: 'user-1', email: 'rep@lumendi.com' };

/** How calendarView returns a recurring series: N occurrences, one master id. */
function occurrences(count, { title, seriesMasterId, physician }) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${seriesMasterId}_occ${i}`, // Graph gives every occurrence its own id
    type: 'occurrence',
    seriesMasterId,
    title,
    start: `2026-09-${String(i + 1).padStart(2, '0')}T15:00:00`,
    isAllDay: false,
    attendees: [{ name: physician.name, email: physician.email, type: 'required' }],
    organizer: { name: 'Wajid Khan', email: 'rep@lumendi.com' },
  }));
}

function single(id, { title, physician }) {
  return {
    id,
    type: 'singleInstance',
    seriesMasterId: null,
    title,
    start: '2026-09-15T15:00:00',
    isAllDay: false,
    attendees: [{ name: physician.name, email: physician.email, type: 'required' }],
    organizer: { name: 'Wajid Khan', email: 'rep@lumendi.com' },
  };
}

function reset(events) {
  calls.briefs.length = 0;
  calls.injected.length = 0;
  calls.upserts.length = 0;
  sentLog.clear();
  activities.clear();
  upcoming = events;
}

// ── the tests ───────────────────────────────────────────────────────────────

test('a recurring physician meeting instant-briefs once, not once per occurrence', async () => {
  const series = occurrences(29, {
    title: 'Weekly with Dr Geoffrey Aaron',
    seriesMasterId: 'AAMkAG-series-A',
    physician: AARON,
  });
  assert.strictEqual(series.length, 29);
  reset(series);

  await ingest.syncActivities('token', USER);

  assert.strictEqual(calls.briefs.length, 1, 'one instant brief for the whole series');
  // Every occurrence is still a real meeting and still gets its activity row.
  assert.strictEqual(calls.upserts.length, 29, 'all 29 occurrences still sync as activities');
});

test('a second poll over the same series sends nothing more', async () => {
  reset(
    occurrences(29, {
      title: 'Weekly with Dr Geoffrey Aaron',
      seriesMasterId: 'AAMkAG-series-A',
      physician: AARON,
    })
  );

  await ingest.syncActivities('token', USER);
  await ingest.syncActivities('token', USER);

  assert.strictEqual(calls.briefs.length, 1);
});

test('distinct series with the same title stay separate', async () => {
  reset([
    ...occurrences(5, { title: 'Weekly sync', seriesMasterId: 'AAMkAG-A', physician: AARON }),
    ...occurrences(5, { title: 'Weekly sync', seriesMasterId: 'AAMkAG-B', physician: SHAHEEN }),
  ]);

  await ingest.syncActivities('token', USER);

  assert.strictEqual(calls.briefs.length, 2);
});

test('an occurrence edited to be with a different physician is briefed too', async () => {
  const series = occurrences(4, {
    title: 'Weekly with Dr Geoffrey Aaron',
    seriesMasterId: 'AAMkAG-A',
    physician: AARON,
  });
  series[2] = {
    ...series[2],
    type: 'exception',
    attendees: [{ name: SHAHEEN.name, email: SHAHEEN.email, type: 'required' }],
  };
  reset(series);

  await ingest.syncActivities('token', USER);

  assert.strictEqual(calls.briefs.length, 2, 'the series once, the edited occurrence once');
});

test('non-recurring meetings keep their per-event instant key', async () => {
  reset([
    single('AAMkAG-single-1', { title: 'Coffee with Dr Geoffrey Aaron', physician: AARON }),
    single('AAMkAG-single-2', { title: 'Dinner with Dr Nicholas Shaheen', physician: SHAHEEN }),
  ]);

  await ingest.syncActivities('token', USER);

  assert.strictEqual(calls.briefs.length, 2, 'two distinct one-off meetings, one brief each');
  assert.ok(sentLog.has('user-1|instant:AAMkAG-single-1'));
  assert.ok(sentLog.has('user-1|instant:AAMkAG-single-2'));
});

test('a pre-existing instant:<eventId> row still suppresses a one-off meeting', async () => {
  reset([single('AAMkAG-single-9', { title: 'Coffee with Dr Geoffrey Aaron', physician: AARON })]);
  sentLog.add('user-1|instant:AAMkAG-single-9'); // written before this change shipped

  await ingest.syncActivities('token', USER);

  assert.strictEqual(calls.briefs.length, 0);
});
