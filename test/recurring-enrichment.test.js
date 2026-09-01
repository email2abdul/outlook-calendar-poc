'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * The recurring-series bug, end to end.
 *
 * `graph.getUpcomingEvents()` uses calendarView, which expands a recurring
 * series into one concrete event per occurrence — each with its own event id.
 * Enrichment was keyed on that id, so a weekly meeting inside the 30-day
 * activity window bought ~29 identical lookups and ~29 external briefs for one
 * logical meeting with one person.
 *
 * Everything email-ingest touches is stubbed, so this runs offline: no Graph,
 * no Supabase, no SQLite, no Anthropic.
 */

// ── the fakes ───────────────────────────────────────────────────────────────

const calls = { enrich: [], briefsSent: [], injected: [] };
const sentLog = new Set(); // stands in for the SQLite reminders_sent table

stub('src/auth', {});
stub('src/physicians', { getByEmail: () => null, getByNpi: () => null, getFacilityById: () => null });
stub('src/entity-matcher', { analyze: async () => ({ matched_entities: [], extracted_entities: [] }) });
stub('src/enrichment/verify', { verifyPhysician: async () => null });
stub('src/crm-store', {});
stub('src/notes', {});
stub('src/analytics', {});
stub('src/contacts-store', {});
stub('src/ai-extractor', {});
stub('src/email-intel', {});
stub('src/email-intel-store', {});

stub('src/token-store', {
  async wasReminderSent(userId, key) {
    return sentLog.has(`${userId}|${key}`);
  },
  async markReminderSent(userId, key) {
    sentLog.add(`${userId}|${key}`);
  },
});

stub('src/enrichment', {
  async enrich(query) {
    calls.enrich.push(query);
    // "Outside BIS" — the branch that emails a brief and injects one.
    return {
      status: 'external',
      confidence: 70,
      query,
      profile: { fields: { name: { value: query.name || query.email } } },
    };
  },
});

stub('src/graph', {
  async sendExternalBriefing(token, opts) {
    calls.briefsSent.push(opts.event.title);
    return 'rep@lumendi.com';
  },
  externalBriefHtml: () => '<p>brief</p>',
  async injectBriefIntoEvent(token, eventId) {
    calls.injected.push(eventId);
    return true;
  },
});

const ingest = require('../src/email-ingest');

// ── fixtures ────────────────────────────────────────────────────────────────

const USER = { homeAccountId: 'user-1', email: 'rep@lumendi.com' };

/** How calendarView returns a recurring series: N occurrences, one master id. */
function occurrences(count, { title, seriesMasterId, attendee }) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${seriesMasterId}_occ${i}`, // Graph gives every occurrence its own id
    type: 'occurrence',
    seriesMasterId,
    title,
    start: `2026-09-${String(i + 1).padStart(2, '0')}T15:00:00`,
    attendees: attendee ? [{ name: attendee.name, email: attendee.email, type: 'required' }] : [],
    organizer: { name: 'Wajid Khan', email: 'rep@lumendi.com' },
  }));
}

function reset() {
  calls.enrich.length = 0;
  calls.briefsSent.length = 0;
  calls.injected.length = 0;
  sentLog.clear();
}

// ── the tests ───────────────────────────────────────────────────────────────

test('29 occurrences of one series enrich once', async () => {
  reset();
  const series = occurrences(29, {
    title: 'Meeting with Dr Geoffrey Aaron',
    seriesMasterId: 'AAMkAG-series-A',
    attendee: { name: 'Geoffrey Aaron', email: 'geoffrey.aaron@unchealth.org' },
  });
  assert.strictEqual(series.length, 29);

  for (const ev of series) await ingest.briefUnknownAttendees('token', USER, ev);

  assert.strictEqual(calls.enrich.length, 1, 'one lookup for the whole series');
  assert.strictEqual(calls.briefsSent.length, 1, 'one external brief for the whole series');
});

test('distinct series stay separate', async () => {
  reset();
  const a = occurrences(5, {
    title: 'Meeting with Dr Geoffrey Aaron',
    seriesMasterId: 'AAMkAG-series-A',
    attendee: { name: 'Geoffrey Aaron', email: 'geoffrey.aaron@unchealth.org' },
  });
  // Same TITLE, different series and different person — must not collide.
  const b = occurrences(5, {
    title: 'Meeting with Dr Geoffrey Aaron',
    seriesMasterId: 'AAMkAG-series-B',
    attendee: { name: 'Nicholas Shaheen', email: 'nshaheen@med.unc.edu' },
  });

  for (const ev of [...a, ...b]) await ingest.briefUnknownAttendees('token', USER, ev);

  assert.strictEqual(calls.enrich.length, 2);
  assert.deepStrictEqual(
    calls.enrich.map((q) => q.email).sort(),
    ['geoffrey.aaron@unchealth.org', 'nshaheen@med.unc.edu']
  );
});

test('an edited occurrence (Graph "exception") with a different person is enriched too', async () => {
  reset();
  const series = occurrences(4, {
    title: 'Meeting with Dr Geoffrey Aaron',
    seriesMasterId: 'AAMkAG-series-A',
    attendee: { name: 'Geoffrey Aaron', email: 'geoffrey.aaron@unchealth.org' },
  });
  series[2] = {
    ...series[2],
    type: 'exception',
    attendees: [{ name: 'Nicholas Shaheen', email: 'nshaheen@med.unc.edu', type: 'required' }],
  };

  for (const ev of series) await ingest.briefUnknownAttendees('token', USER, ev);

  assert.strictEqual(calls.enrich.length, 2, 'the series once, the edited occurrence once');
});

test('non-recurring meetings each enrich once, and keep their per-event key', async () => {
  reset();
  const one = {
    id: 'AAMkAG-single-1',
    type: 'singleInstance',
    seriesMasterId: null,
    title: 'Coffee with Dr Geoffrey Aaron',
    attendees: [{ name: 'Geoffrey Aaron', email: 'geoffrey.aaron@unchealth.org', type: 'required' }],
    organizer: { name: 'Wajid Khan', email: 'rep@lumendi.com' },
  };
  const two = { ...one, id: 'AAMkAG-single-2', title: 'Dinner with Dr Nicholas Shaheen',
    attendees: [{ name: 'Nicholas Shaheen', email: 'nshaheen@med.unc.edu', type: 'required' }] };

  await ingest.briefUnknownAttendees('token', USER, one);
  await ingest.briefUnknownAttendees('token', USER, one); // second poll — deduped
  await ingest.briefUnknownAttendees('token', USER, two);

  assert.strictEqual(calls.enrich.length, 2, 'two distinct one-off meetings, one lookup each');
  // Historical dedupe rows were written as `enrich:<eventId>`; they must still hit.
  assert.ok(sentLog.has('user-1|enrich:AAMkAG-single-1'));
  assert.ok(sentLog.has('user-1|enrich:AAMkAG-single-2'));
});

test('a pre-existing enrich:<eventId> row still suppresses a one-off meeting', async () => {
  reset();
  sentLog.add('user-1|enrich:AAMkAG-single-9'); // written before this change shipped
  await ingest.briefUnknownAttendees('token', USER, {
    id: 'AAMkAG-single-9',
    type: 'singleInstance',
    seriesMasterId: null,
    title: 'Coffee with Dr Geoffrey Aaron',
    attendees: [{ name: 'Geoffrey Aaron', email: 'geoffrey.aaron@unchealth.org', type: 'required' }],
    organizer: { name: 'Wajid Khan', email: 'rep@lumendi.com' },
  });
  assert.strictEqual(calls.enrich.length, 0);
});

test('a recurring "Vivek Chat" with no attendee is not enriched at all', async () => {
  reset();
  // Layer 1: the title names no person, so there is nothing to look up — this
  // series never reaches the enrichment agent, at any count.
  const series = occurrences(29, { title: 'Vivek Chat', seriesMasterId: 'AAMkAG-series-C' });
  for (const ev of series) await ingest.briefUnknownAttendees('token', USER, ev);
  assert.strictEqual(calls.enrich.length, 0);
});
