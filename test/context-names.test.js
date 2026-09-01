'use strict';

const test = require('node:test');
const assert = require('node:assert');

// context.js pulls in the physician directory and entity matcher at require
// time; neither is used by the title-name path, so stub them out and keep the
// test offline.
const stub = require('./helpers/stub');
stub('src/physicians', {});
stub('src/entity-matcher', {});

const context = require('../src/enrichment/context');

const ev = (title, extra = {}) => ({
  id: 'evt-1',
  title,
  organizer: { name: 'Wajid Khan', email: 'wajid@lumendi.com' },
  attendees: [],
  ...extra,
});

const names = (title, extra) =>
  context.namesFromEvent(ev(title, extra), { selfEmail: 'wajid@lumendi.com' }).map((p) => p.name);

test('a meeting/chat title is not a person', () => {
  // The reported bug: "Vivek Chat" was read as a person called Vivek Chat and
  // sent through a full external lookup.
  assert.deepStrictEqual(names('Vivek Chat'), []);
  assert.deepStrictEqual(names('vivek chat'), []);
  assert.deepStrictEqual(names('Vivek Sync'), []);
  assert.deepStrictEqual(names('Sarah Catchup'), []);
  assert.deepStrictEqual(names('Product Huddle'), []);
  assert.deepStrictEqual(names('Pipeline Review'), []);
});

test('lowercase words are not a name without an honorific', () => {
  assert.deepStrictEqual(names('quick vivek discussion'), []);
  assert.deepStrictEqual(names('budget planning'), []);
});

test('real person names still resolve', () => {
  assert.deepStrictEqual(names('Meeting with dr Geoffrey Aaron'), ['Geoffrey Aaron']);
  assert.deepStrictEqual(names('meeting with dr geoffrey aaron'), ['Geoffrey Aaron']);
  assert.deepStrictEqual(names('Lunch with Adam Smith'), ['Adam Smith']);
  assert.deepStrictEqual(names('GEOFFREY AARON'), ['Geoffrey Aaron']);
  assert.deepStrictEqual(names('Demo for Adam Smith'), ['Adam Smith']);
  assert.deepStrictEqual(names('Dr. Nicholas Shaheen, MD'), ['Nicholas Shaheen']);
  // Lowercase particles survive the capitalisation check (titleCase's existing
  // rendering of them is unchanged by this fix).
  assert.deepStrictEqual(names('Meeting with Maria de Souza'), ['Maria De Souza']);
});

test('a name followed by a meeting word keeps the name', () => {
  assert.deepStrictEqual(names('Adam Smith catch up'), ['Adam Smith']);
  assert.deepStrictEqual(names('Geoffrey Aaron weekly'), ['Geoffrey Aaron']);
});

test('places, organizers and multi-name titles behave as before', () => {
  assert.deepStrictEqual(names('Adam Smith Hospital Boston'), ['Adam Smith']);
  assert.deepStrictEqual(names('Meeting with Wajid Khan'), []); // the organizer
  assert.deepStrictEqual(names('Meeting with Adam Smith and Nicholas Shaheen'), [
    'Adam Smith',
    'Nicholas Shaheen',
  ]);
});
