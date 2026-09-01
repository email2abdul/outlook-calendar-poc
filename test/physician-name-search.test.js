'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stub = require('./helpers/stub');

/**
 * The multi-word name rule behind the physician search fix.
 *
 * `bis_search_physicians` matches the query as one string, so "Barry Pronold"
 * missed the stored "Barry J Pronold" — and 72% of the directory (15,350 of
 * 21,274) carries a middle name or initial. First-Last is exactly how a rep
 * types a name, so most of the master was unreachable from the search box and
 * the UI showed a blank list.
 *
 * Supabase and the territory helper are stubbed so this stays offline; the
 * directory itself is not needed to exercise the rule.
 */
stub('src/supabase', null);
stub('src/territory', { forState: () => null, forPhysician: () => null });

const physicians = require('../src/physicians');
const { nameTokens, nameHasAllTokens } = physicians;

test('a typed middle initial is not a required word', () => {
  // "J" must not become a token the master row has to carry, or "Barry J
  // Pronold" would stop matching the moment the rep types the initial.
  assert.deepStrictEqual(nameTokens('Barry J Pronold'), ['barry', 'pronold']);
  assert.deepStrictEqual(nameTokens('BARRY PRONOLD'), ['barry', 'pronold']);
  assert.deepStrictEqual(nameTokens('  Katherine   M.  Hoda '), ['katherine', 'hoda']);
});

test('punctuation and case do not change the words', () => {
  assert.deepStrictEqual(nameTokens("Michael (Brian) B Fennerty"), ['michael', 'brian', 'fennerty']);
  assert.deepStrictEqual(nameTokens("O'Brien, Sean"), ["o'brien", 'sean']);
  assert.deepStrictEqual(nameTokens('smith'), ['smith']);
  assert.deepStrictEqual(nameTokens(''), []);
});

test('a stored middle initial no longer blocks a First-Last match', () => {
  const typed = nameTokens('Barry Pronold');
  assert.ok(nameHasAllTokens('Barry J Pronold', typed), 'the bug: this used to miss');
  assert.ok(nameHasAllTokens('Barry Pronold', typed));
  assert.ok(!nameHasAllTokens('Barry S Obadiah', typed), 'wrong surname');
  assert.ok(!nameHasAllTokens('Jane Pronold', typed), 'wrong first name');
});

test('every typed word must be present — order does not matter', () => {
  const typed = nameTokens('Katherine Hoda');
  assert.ok(nameHasAllTokens('Katherine M Hoda', typed));
  assert.ok(nameHasAllTokens('Hoda, Katherine M', typed));
  assert.ok(!nameHasAllTokens('Katherine M Smith', typed), 'surname missing');
  assert.ok(!nameHasAllTokens('Lawrence K Hoda', typed), 'first name missing');
});

test('near-miss surnames stay distinct', () => {
  // Both are real BIS rows. "Fennerty" contains "Fenner", so a substring
  // search hid "Michael N Fenner" behind it — both must be offered.
  const typed = nameTokens('Michael Fenner');
  assert.ok(nameHasAllTokens('Michael N Fenner', typed));
  assert.ok(nameHasAllTokens('Michael (Brian) B Fennerty', typed));
  // …and the reverse is not true, so typing the longer name is still precise.
  const typedLong = nameTokens('Michael Fennerty');
  assert.ok(!nameHasAllTokens('Michael N Fenner', typedLong));
});

test('a single word is left to the ranked directory search', () => {
  // One token is not a name match — "smith" should keep going through the
  // RPC's own ranking rather than returning every Smith in the master.
  assert.strictEqual(nameTokens('smith').length, 1);
  assert.strictEqual(nameTokens('gastroenterology').length, 1);
});

test('a non-name query is unaffected', () => {
  assert.deepStrictEqual(nameTokens('1144420837'), ['1144420837']);
  assert.deepStrictEqual(nameTokens('barry.pronold@upstate.com'), ['barry', 'pronold', 'upstate', 'com']);
});
