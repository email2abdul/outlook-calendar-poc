'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * graph.stripInjectedBrief — reading a meeting's text without reading our own.
 *
 * The brief is written INTO the meeting body, and the meeting body is then read
 * back for the hints that identify the physician. Left alone that is a feedback
 * loop: once a brief had been injected, Outlook's 255-character preview was
 * entirely our own text, the rep's "Primary Taxonomy - Internal Medicine from
 * CHICAGO" was past the cut, and the panel fell from one candidate at 100% to
 * "2 possible matches, none over 70%" (2026-09-02).
 */
stub('src/supabase', null);
stub('src/enrichment/verify', { verifyPhysician: async () => null, emailTrust: () => null });

const graph = require('../src/graph');

const REP_LINE = 'Primary Taxonomy - Internal Medicine from CHICAGO';
const INJECTED =
  '<!-- bis-pre-meeting-brief --><div style="border:1px solid #0f6cbd">' +
  '<div style="font-weight:700">🩺 BIS pre-meeting brief</div>' +
  '<p>ABESELOM GELETU is <b>not in the BIS directory</b>. The notes below…</p>' +
  '</div><hr>' +
  `<p><b>Primary Taxonomy</b> - Internal Medicine from CHICAGO</p>`;
const POLLUTED_PREVIEW =
  '🩺 BIS pre-meeting brief ABESELOM GELETU is not in the BIS directory. The notes below were assembled from public sources, and anything those sources could not…';

test("the rep's own line is recovered from a body we have written into", () => {
  assert.strictEqual(graph.stripInjectedBrief({ html: INJECTED, preview: POLLUTED_PREVIEW }), REP_LINE);
});

test('a body we have never touched comes back as it is', () => {
  assert.strictEqual(graph.stripInjectedBrief({ html: `<p>${REP_LINE}</p>` }), REP_LINE);
  assert.strictEqual(graph.stripInjectedBrief({ preview: REP_LINE }), REP_LINE);
});

test('with only a polluted preview, nothing is claimed', () => {
  // The rep's words are past the 255 characters Outlook returns, so there is
  // nothing to recover — and inventing hints from our own brief is what caused
  // the bug. Null is the honest answer; the callers that decide anything read
  // the full body instead.
  assert.strictEqual(graph.stripInjectedBrief({ preview: POLLUTED_PREVIEW }), null);
});

test('an empty meeting stays empty', () => {
  assert.strictEqual(graph.stripInjectedBrief({}), null);
  assert.strictEqual(graph.stripInjectedBrief({ html: '', preview: '' }), null);
});

test('the brief block is removed wherever it sits in the body', () => {
  const after = `<p>${REP_LINE}</p><!-- bis-pre-meeting-brief --><div><div>🩺 BIS pre-meeting brief</div><p>x</p></div><hr>`;
  assert.strictEqual(graph.stripInjectedBrief({ html: after }), REP_LINE);
});
