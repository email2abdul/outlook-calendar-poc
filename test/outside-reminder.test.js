'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * The reminder for a physician the master does not hold — reminders.tick().
 *
 * Before this, identifying someone outside BIS bought a brief you had to
 * remember to open: the reminder engine only knew attendee-email matches and the
 * scheduled physician, so the half of the calendar bis_physicians has never
 * heard of got no reminder at all.
 *
 * Everything is stubbed, so what these tests pin is the POLICY: only a decision
 * the rep made is mailed unattended, a source outage does not consume the
 * one-shot, and it is deduped like every other reminder.
 */
const sent = [];
const marked = [];
let decision = null;
let profile = null;

const soon = () => new Date(Date.now() + 10 * 60000).toISOString().replace(/\.\d+Z$/, '');
const EVENT = { id: 'EV-1', title: 'Endoscopy case obs', start: soon(), timeZone: 'UTC', isAllDay: false, attendees: [], organizer: { email: 'rep@lumendi.com' } };

stub('src/auth', { getAccessTokenForUser: async () => 'token' });
stub('src/physicians', { getByEmail: () => null, getByNpi: () => null, getFacilityById: () => null, matchInText: () => [] });
stub('src/entity-matcher', { analyze: async () => ({ matched_entities: [], extracted_entities: [] }) });
stub('src/enrichment/verify', { verifyPhysician: async () => null });
stub('src/analytics', { getLabelledAnalytics: async () => null });
stub('src/contacts-store', { getContact: async () => null });
stub('src/crm-store', { enabled: false, findActivityByEventId: async () => null });
stub('src/notes', { getNotes: async () => [{ id: 1, notes: 'Talked about EZ1', createdAt: '2026-08-01T00:00:00Z' }] });
stub('src/token-store', {
  listUsers: async () => [{ homeAccountId: 'user-1', email: 'rep@lumendi.com' }],
  wasReminderSent: async (u, key) => marked.includes(key),
  markReminderSent: async (u, key) => marked.push(key),
});
stub('src/graph', {
  getUpcomingEvents: async () => [EVENT],
  outsideBriefHtml: ({ record }) => `<p>brief for ${record.name}</p>`,
  async sendOutsideBriefing(token, opts) {
    sent.push(opts);
    return opts.toEmail;
  },
  sendPhysiciansBriefing: async () => 'rep@lumendi.com',
});
stub('src/outside-physician-store', { latestForEvent: async () => decision });
stub('src/outside-sources/profile', async () => profile);

const reminders = require('../src/reminders');

const CONFIRMED = {
  npi: '1467521757', name: 'NICHOLAS J SHAHEEN', decidedBy: 'user', confidence: 100,
  externalSource: 'nppes',
};
const PROFILE = {
  record: { npi: '1467521757', name: 'NICHOLAS J SHAHEEN', specialty: 'Gastroenterology' },
  extra: {}, cms: { years: [] }, agreement: { confirmed: false, on: [], by: ['NPPES NPI Registry'] },
  sourceName: 'NPPES NPI Registry', sourceUrl: 'https://npiregistry.cms.hhs.gov/', failures: [],
};

test('a physician the rep confirmed from the registries gets the reminder', async () => {
  sent.length = 0;
  marked.length = 0;
  decision = CONFIRMED;
  profile = PROFILE;

  await reminders.tick();

  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].subject, /^⏰ In \d+ min: Endoscopy case obs — NICHOLAS J SHAHEEN \(outside BIS\)$/);
  assert.match(sent[0].intro, /not in the BIS directory/);
  assert.match(sent[0].intro, /Data not available/, 'the email says up front where the gaps are');
  assert.strictEqual(sent[0].toEmail, 'rep@lumendi.com');
  assert.strictEqual(sent[0].notes.length, 1, "the rep's own notes ride along");
  assert.ok(marked.includes('EV-1'), 'deduped like every other reminder');
});

test('the same meeting is not reminded twice', async () => {
  sent.length = 0;
  decision = CONFIRMED;
  profile = PROFILE;

  await reminders.tick(); // marked already holds EV-1 from the test above

  assert.strictEqual(sent.length, 0);
});

test("an automatic guess is never mailed unattended", async () => {
  sent.length = 0;
  marked.length = 0;
  decision = { ...CONFIRMED, decidedBy: 'system' };
  profile = PROFILE;

  await reminders.tick();

  assert.strictEqual(sent.length, 0, 'only a decision the rep made is mailed');
  assert.deepStrictEqual(marked, []);
});

test('a source outage does not consume the one reminder', async () => {
  sent.length = 0;
  marked.length = 0;
  decision = CONFIRMED;
  profile = null; // no source could describe the NPI

  await reminders.tick();

  assert.strictEqual(sent.length, 0);
  assert.deepStrictEqual(marked, [], 'the next tick has to be able to try again');
});

test('a non-physician the rep recorded is never mailed a brief', async () => {
  sent.length = 0;
  marked.length = 0;
  // The rep picked the social worker from the shortlist — their choice stands as
  // the meeting's contact, but no brief was ever produced for them, and one must
  // not appear in the inbox half an hour before the meeting.
  decision = { ...CONFIRMED, name: 'TAYLOR M AAGAARD', status: 'not_doctor' };
  profile = PROFILE;

  await reminders.tick();

  assert.strictEqual(sent.length, 0);
  assert.deepStrictEqual(marked, []);
});
