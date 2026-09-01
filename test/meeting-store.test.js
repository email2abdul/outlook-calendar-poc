'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * meetingStore.isWorthRecording — the rule that keeps app_meeting_physician a
 * history instead of a log spammed by the ingest tick.
 *
 * The tick re-reads the calendar every few minutes. Without this rule, a
 * calendar that has not moved would grow one row per meeting per tick and bury
 * the two rows that actually matter — and an automatic re-derivation would
 * happily record over an answer the rep gave by hand.
 */
stub('src/supabase', null); // pure function; no database needed

const meetingStore = require('../src/meeting-store');
const { isWorthRecording } = meetingStore;

test('the first answer for a meeting is always worth recording', () => {
  assert.strictEqual(isWorthRecording(null, { npi: '1', source: 'email', status: 'briefed' }), true);
});

test('the same answer again is not recorded', () => {
  const latest = { npi: '1', source: 'email', status: 'briefed', decidedBy: 'system' };
  assert.strictEqual(
    isWorthRecording(latest, { npi: '1', source: 'email', status: 'briefed', decidedBy: 'system' }),
    false
  );
});

test('a different physician, source or status is recorded', () => {
  const latest = { npi: '1', source: 'name', status: 'briefed', decidedBy: 'system' };
  assert.strictEqual(
    isWorthRecording(latest, { npi: '2', source: 'name', status: 'briefed', decidedBy: 'system' }),
    true,
    'the person changed'
  );
  assert.strictEqual(
    isWorthRecording(latest, { npi: '1', source: 'email', status: 'briefed', decidedBy: 'system' }),
    true,
    'a stronger source answered'
  );
  assert.strictEqual(
    isWorthRecording(latest, { npi: '1', source: 'name', status: 'needs_confirm', decidedBy: 'system' }),
    true,
    'the meeting now needs confirming'
  );
});

test("an automatic pass never records over the rep's own answer", () => {
  const chosen = { npi: '2', source: 'user', status: 'briefed', decidedBy: 'user' };
  assert.strictEqual(
    isWorthRecording(chosen, { npi: '1', source: 'email', status: 'briefed', decidedBy: 'system' }),
    false,
    'this is what stopped the tick undoing a rep decision'
  );
  // The rep themselves can always change their mind.
  assert.strictEqual(
    isWorthRecording(chosen, { npi: '3', source: 'user', status: 'briefed', decidedBy: 'user' }),
    true
  );
});

test('a gate-blocked meeting is written once, not once per tick', () => {
  const skipped = { npi: null, source: 'gate', status: 'skipped', decidedBy: 'system' };
  assert.strictEqual(isWorthRecording(null, skipped), true);
  assert.strictEqual(isWorthRecording(skipped, skipped), false);
});
