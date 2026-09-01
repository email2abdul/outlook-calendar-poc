'use strict';

const test = require('node:test');
const assert = require('node:assert');

/**
 * The candidate scorer — src/outside-sources/score.js.
 *
 * Its whole job is to keep a guess from being shown as an answer. Two rules are
 * worth more than the arithmetic:
 *  · a half name can never clear the bar on its own, because nothing in it
 *    separates two people who share a surname;
 *  · two candidates neck and neck means we cannot tell them apart, so NOTHING
 *    is auto-shown, however high they score.
 */
const { scoreCandidate, rankCandidates, splitFullName, CONFIDENCE_SHOW } = require('../src/outside-sources/score');

const cand = (over = {}) => ({
  npi: '1234567890',
  name: 'John Abernathy',
  firstName: 'John',
  lastName: 'Abernathy',
  city: 'Houston',
  state: 'TX',
  primaryTaxonomy: 'Gastroenterology',
  ...over,
});

test('a full name plus a place clears the bar', () => {
  const { confidence, reasons } = scoreCandidate(cand(), {
    firstName: 'John',
    lastName: 'Abernathy',
    city: 'Houston',
    state: 'TX',
  });
  assert.ok(confidence >= CONFIDENCE_SHOW, `${confidence} should clear ${CONFIDENCE_SHOW}`);
  assert.ok(reasons.includes('first name matches'));
  assert.ok(reasons.includes('city matches the meeting'));
});

test('half a name cannot clear the bar on its own', () => {
  // "Dr Abernathy" — nothing here distinguishes this John from any other
  // Abernathy, and the number has to say so.
  const { confidence, reasons } = scoreCandidate(cand(), { lastName: 'Abernathy' }, { total: 6 });
  assert.ok(confidence < CONFIDENCE_SHOW, `${confidence} must stay under ${CONFIDENCE_SHOW}`);
  assert.ok(reasons.includes('no first name on the meeting to check against'));
});

test('a different first name is penalised, not ignored', () => {
  const wrong = scoreCandidate(cand({ firstName: 'Robert', name: 'Robert Abernathy' }), {
    firstName: 'John',
    lastName: 'Abernathy',
  });
  const right = scoreCandidate(cand(), { firstName: 'John', lastName: 'Abernathy' });
  assert.ok(wrong.confidence < right.confidence - 40);
  assert.ok(wrong.reasons.includes('first name differs'));
});

test('an initial, a prefix and a second source each count for something', () => {
  const initial = scoreCandidate(cand(), { firstName: 'j', lastName: 'Abernathy' });
  assert.ok(initial.reasons.includes('first initial matches'));

  const prefix = scoreCandidate(cand({ firstName: 'Johnathan', name: 'Johnathan Abernathy' }), {
    firstName: 'John',
    lastName: 'Abernathy',
  });
  assert.ok(prefix.reasons.includes('first name is a partial match'));

  const alone = scoreCandidate(cand(), { firstName: 'John', lastName: 'Abernathy' }, { total: 1 });
  const confirmed = scoreCandidate(
    cand(),
    { firstName: 'John', lastName: 'Abernathy' },
    { total: 1, confirmed: true }
  );
  assert.ok(confirmed.confidence > alone.confidence);
  assert.ok(confirmed.reasons.includes('a second source confirms this identity'));
});

test('the best candidate is shown only when it is clearly the best', () => {
  const wanted = { firstName: 'John', lastName: 'Abernathy', state: 'TX' };

  // Two Johns in Texas: the scores tie, so neither is put in front of the rep.
  const tie = rankCandidates(
    [cand({ npi: '1111111111' }), cand({ npi: '2222222222', city: 'Dallas' })],
    wanted
  );
  assert.strictEqual(tie.ambiguous, true);
  assert.strictEqual(tie.primary, null, 'a coin toss must not be rendered as an answer');

  // One John, one Robert: the John wins outright.
  const clear = rankCandidates(
    [cand({ npi: '1111111111' }), cand({ npi: '2222222222', firstName: 'Robert', name: 'Robert Abernathy' })],
    wanted
  );
  assert.strictEqual(clear.ambiguous, false);
  assert.strictEqual(clear.primary.npi, '1111111111');
  assert.ok(clear.ranked[0].confidence > clear.ranked[1].confidence);
  assert.strictEqual(clear.cleared, 1);
});

test('a lone candidate under the bar is still not shown as the answer', () => {
  const only = rankCandidates([cand()], { lastName: 'Abernathy' });
  assert.strictEqual(only.ranked.length, 1);
  assert.ok(only.ranked[0].confidence < CONFIDENCE_SHOW);
  assert.strictEqual(only.primary, null);
});

test('a full name splits into first and last however it is written', () => {
  assert.deepStrictEqual(splitFullName('John R Abernathy'), { first: 'john', last: 'abernathy' });
  assert.deepStrictEqual(splitFullName('  ABERNATHY '), { first: '', last: 'abernathy' });
  assert.deepStrictEqual(splitFullName(''), { first: '', last: '' });
});
