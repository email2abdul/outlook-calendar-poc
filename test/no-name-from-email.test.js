'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * An address is not a name.
 *
 * The rep's rule, and the case that produced it: a meeting called "Meeting with
 * Best friend" with `email2@gmail.com` on it. The local-part was read as
 * "e" + "mail", NPPES held eight people surnamed MAIL, exactly one had a first
 * name starting with E — and the panel presented a clinical social worker in
 * Indianapolis as the physician for that meeting, at 50% confidence.
 *
 * Two rules come out of it, and this file holds both:
 *   1. a name is NEVER derived from an email address;
 *   2. a meeting that does not say "Dr"/"Doctor" is not looked up at all.
 *
 * Everything external is stubbed, so this runs offline.
 */

const calls = { enrich: [], briefsSent: [], nppes: [] };
const sentLog = new Set();

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
stub('src/outside-physician-store', {
  enabled: false,
  latestForEvents: async () => new Map(),
  latestForEvent: async () => null,
  record: async () => null,
  isWorthRecording: () => false,
  mirrorFromPhysician: () => ({}),
  backendName: () => 'stub',
});
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
    return { status: 'external', confidence: 80, query, profile: { fields: {} } };
  },
});
stub('src/graph', {
  async sendExternalBriefing(token, opts) {
    calls.briefsSent.push(opts.event.title);
    return 'rep@lumendi.com';
  },
  externalBriefHtml: () => '<p>brief</p>',
  async injectBriefIntoEvent() {
    return true;
  },
});

const ingest = require('../src/email-ingest');
const rematch = require('../src/enrichment/rematch');

const USER = { homeAccountId: 'user-1', email: 'rep@lumendi.com' };

function meeting(extra) {
  return {
    id: 'evt-1',
    type: 'singleInstance',
    seriesMasterId: null,
    organizer: { name: 'Wajid Khan', email: 'rep@lumendi.com' },
    attendees: [],
    ...extra,
  };
}

function reset() {
  calls.enrich.length = 0;
  calls.briefsSent.length = 0;
  calls.nppes.length = 0;
  sentLog.clear();
}

// ── 1. the address is never turned into a name ──────────────────────────────

test('the email-to-name guess is gone from the enrichment helpers', () => {
  assert.strictEqual(
    typeof rematch.nameHintsFromEmail,
    'undefined',
    'nameHintsFromEmail must not come back — it is what invented "E. Mail"'
  );
  assert.strictEqual(typeof rematch.isGenericMailbox, 'function');
});

test('a shared mailbox is still recognised, without guessing a name', () => {
  assert.strictEqual(rematch.isGenericMailbox('info@unch.unc.edu'), true);
  assert.strictEqual(rematch.isGenericMailbox('scheduling2@unch.unc.edu'), true);
  assert.strictEqual(rematch.isGenericMailbox('nshaheen@med.unc.edu'), false);
  assert.strictEqual(rematch.isGenericMailbox('email2@gmail.com'), false);
});

// ── 2. no "Dr" on the meeting → nothing happens at all ──────────────────────

test('a normal meeting is not looked up, briefed or written to', async () => {
  reset();
  const handled = await ingest.briefUnknownAttendees(
    'token',
    USER,
    meeting({
      title: 'Meeting with Best friend',
      attendees: [{ name: '', email: 'email2@gmail.com', type: 'required' }],
    })
  );

  assert.deepStrictEqual(handled, []);
  assert.deepStrictEqual(calls.enrich, [], 'the gate refused, so nothing was looked up');
  assert.deepStrictEqual(calls.briefsSent, [], 'and nothing was emailed');
  assert.strictEqual(sentLog.size, 0, 'no dedupe key is burned on a meeting we never looked at');
});

test('"Dr" in the title opens the same meeting up, by NAME', async () => {
  reset();
  await ingest.briefUnknownAttendees(
    'token',
    USER,
    meeting({
      title: 'Meeting with Dr Geoffrey Aaron',
      attendees: [{ name: '', email: 'email2@gmail.com', type: 'required' }],
    })
  );

  assert.strictEqual(calls.enrich.length, 1);
  assert.strictEqual(calls.enrich[0].name, 'Geoffrey Aaron');
  assert.strictEqual(calls.enrich[0].email, undefined, 'the address is not what was looked up');
  assert.strictEqual(calls.briefsSent.length, 1);
});

test('an attendee whose NAME says Dr passes the gate too', async () => {
  reset();
  await ingest.briefUnknownAttendees(
    'token',
    USER,
    meeting({
      title: 'Catch up',
      attendees: [{ name: 'Dr Geoffrey Aaron', email: 'email2@gmail.com', type: 'required' }],
    })
  );

  assert.strictEqual(calls.enrich.length, 1);
  assert.strictEqual(calls.enrich[0].name, 'Geoffrey Aaron');
  assert.strictEqual(calls.enrich[0].email, undefined);
});
