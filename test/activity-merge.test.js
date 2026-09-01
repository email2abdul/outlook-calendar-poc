'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * crm.mergeActivityRow — which physician a meeting's row keeps.
 *
 * The bug this exists to stop: the rep picks "Abdul H Khan" from the shortlist,
 * and minutes later the ingest tick — which matches on attendee EMAIL only, and
 * this meeting has none — upserts physician_npi = null straight over it. The
 * choice was gone, the reminder brief had nobody, and nothing said why.
 *
 * The confirmed NPI arrives as the THIRD argument: the decision itself lives in
 * app_meeting_physician (src/meeting-store.js), not on this row.
 */
stub('src/supabase', null); // pure function; no database needed

const { mergeActivityRow } = require('../src/crm-store');

test("a rep's confirmed choice outranks anything the sync derived", () => {
  const merged = mergeActivityRow(
    { physician_npi: '2000000002', facility_id: 'F2' },
    { physician_npi: '1111111111', facility_id: 'F9' },
    '2000000002'
  );
  assert.strictEqual(merged.physician_npi, '2000000002');
});

test('a sync that matched nobody never blanks a confirmed choice', () => {
  const merged = mergeActivityRow(
    { physician_npi: '2000000002', facility_id: 'F2' },
    { physician_npi: null, facility_id: null },
    '2000000002'
  );
  assert.strictEqual(merged.physician_npi, '2000000002', 'the original bug');
  assert.strictEqual(merged.facility_id, 'F2');
});

test('a physician linked earlier survives a sync that cannot re-derive them', () => {
  // No chosen_npi here: this is a link the external agent or the schedule route
  // wrote. A later tick seeing no attendee email must still not erase it.
  const merged = mergeActivityRow(
    { physician_npi: '3000000003', facility_id: 'F3' },
    { physician_npi: null, facility_id: null }
  );
  assert.strictEqual(merged.physician_npi, '3000000003');
  assert.strictEqual(merged.facility_id, 'F3');
});

test('a fresh automatic match still wins when there is no confirmed choice', () => {
  const merged = mergeActivityRow(
    { physician_npi: '3000000003', facility_id: 'F3' },
    { physician_npi: '4000000004', facility_id: 'F4' }
  );
  assert.strictEqual(merged.physician_npi, '4000000004');
  assert.strictEqual(merged.facility_id, 'F4');
});

test('a meeting seen for the first time takes what the sync found', () => {
  assert.deepStrictEqual(mergeActivityRow(null, { physician_npi: '5000000005', facility_id: 'F5' }), {
    physician_npi: '5000000005',
    facility_id: 'F5',
  });
  assert.deepStrictEqual(mergeActivityRow(null, { physician_npi: null, facility_id: null }), {
    physician_npi: null,
    facility_id: null,
  });
});
