'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * The email a rep gets for a physician the master does not hold —
 * graph.sendOutsideBriefing().
 *
 * Actually sending needs a Microsoft sign-in, so the Graph client is stubbed
 * and the MESSAGE is asserted instead: what the subject promises, that the
 * brief travels intact (including the "Data not available" rows — a brief that
 * silently drops them reads as though the data was checked and was fine), and
 * that the rep's own notes ride along exactly as they do in a BIS brief.
 */
const sent = [];

stub('node_modules/@microsoft/microsoft-graph-client', {
  Client: {
    init() {
      return {
        api(path) {
          return {
            async post(body) {
              sent.push({ path, body });
              return {};
            },
          };
        },
      };
    },
  },
});

const graph = require('../src/graph');

const BRIEF =
  '<p class="brief-h"><b>Physician details</b></p>' +
  '<table><tr><td><b>Name</b></td><td>NICHOLAS J SHAHEEN</td></tr>' +
  '<tr><td><b>Email</b></td><td><span style="color:#8a8f98">Data not available</span></td></tr></table>';

test('the subject says plainly that this is not your data', async () => {
  sent.length = 0;
  const to = await graph.sendOutsideBriefing('token', {
    toEmail: 'rep@lumendi.com',
    name: 'NICHOLAS J SHAHEEN',
    html: BRIEF,
    notes: [],
    event: { title: 'Endoscopy case obs', start: '2026-09-02T14:00:00', timeZone: 'UTC' },
  });

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].path, '/me/sendMail');
  const msg = sent[0].body.message;
  assert.match(msg.subject, /Outside BIS/);
  assert.match(msg.subject, /NICHOLAS J SHAHEEN/);
  assert.match(msg.subject, /Endoscopy case obs/);
  assert.strictEqual(msg.toRecipients[0].emailAddress.address, 'rep@lumendi.com');
  assert.strictEqual(to, 'rep@lumendi.com');
  assert.strictEqual(sent[0].body.saveToSentItems, true);
});

test('the brief travels intact, gaps included, with the meeting and the notes', async () => {
  sent.length = 0;
  await graph.sendOutsideBriefing('token', {
    toEmail: 'rep@lumendi.com',
    name: 'NICHOLAS J SHAHEEN',
    html: BRIEF,
    notes: [
      { id: 1, notes: 'Discussed DiLumen EZ1 for EMR cases', meetingDate: '2026-08-20', createdAt: '2026-08-20T10:00:00Z' },
    ],
    event: { title: 'Endoscopy case obs', start: '2026-09-02T14:00:00', timeZone: 'UTC' },
  });

  const html = sent[0].body.message.body.content;
  assert.match(html, /not in the BIS directory/i, 'the first line has to say whose data this is');
  assert.match(html, /Anything BIS would normally supply|Data not available/);
  assert.ok(html.includes('NICHOLAS J SHAHEEN'));
  assert.ok(html.includes('Data not available'), 'a gap must not be quietly dropped');
  assert.match(html, /<b>Meeting:<\/b> Endoscopy case obs/);
  assert.match(html, /Meeting notes/);
  assert.ok(html.includes('Discussed DiLumen EZ1 for EMR cases'), "the rep's own history rides along");
});

test('nothing is sent without a recipient or a brief', async () => {
  sent.length = 0;
  assert.strictEqual(await graph.sendOutsideBriefing('t', { toEmail: '', html: BRIEF }), null);
  assert.strictEqual(await graph.sendOutsideBriefing('t', { toEmail: 'rep@x.com', html: '' }), null);
  assert.strictEqual(sent.length, 0);
});
