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
const {
  scoreCandidate,
  rankCandidates,
  splitFullName,
  CONFIDENCE_SHOW,
  CONFIDENCE_OFFER,
} = require('../src/outside-sources/score');

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

// ── The details that separate same-named providers ───────────────────────────

test('what the MEETING mentions is what separates nine people with one surname', () => {
  // Real NPPES data: nine AAGAARDs, one of each kind. A rep who writes the
  // taxonomy or the practice address into the invite has told us which one.
  const charlotte = {
    name: 'CHARLOTTE SUE AAGAARD', firstName: 'CHARLOTTE', lastName: 'AAGAARD',
    primaryTaxonomy: 'Behavior Technician', city: 'SEATTLE', state: 'WA', zip: '98105',
    facilityAddress: '4800 SAND POINT WAY NE, SEATTLE, WA, 98105',
  };
  const jeffrey = {
    name: 'JEFFREY LYNN AAGAARD', firstName: 'JEFFREY', lastName: 'AAGAARD',
    primaryTaxonomy: 'Dentist', city: 'WEST DES MOINES', state: 'IA', zip: '50266',
    facilityAddress: '1601 22ND ST, WEST DES MOINES, IA, 50266',
  };

  const surnameOnly = { lastName: 'Aagaard', text: 'Meeting with Dr Aagaard' };
  assert.ok(scoreCandidate(charlotte, surnameOnly).confidence < CONFIDENCE_OFFER);
  assert.ok(scoreCandidate(jeffrey, surnameOnly).confidence < CONFIDENCE_OFFER,
    'a surname alone must not offer anybody');

  const saysDentist = { lastName: 'Aagaard', text: 'Meeting with Dr Aagaard (Dentist)' };
  assert.ok(scoreCandidate(jeffrey, saysDentist).confidence >= CONFIDENCE_SHOW);
  assert.ok(scoreCandidate(charlotte, saysDentist).confidence < CONFIDENCE_OFFER);
  assert.ok(
    scoreCandidate(jeffrey, saysDentist).reasons.includes('the meeting mentions this taxonomy')
  );

  const saysAddress = { lastName: 'Aagaard', text: 'Dr Aagaard at 4800 Sand Point Way NE Seattle' };
  assert.ok(scoreCandidate(charlotte, saysAddress).confidence >= CONFIDENCE_SHOW);
  assert.ok(scoreCandidate(jeffrey, saysAddress).confidence < CONFIDENCE_OFFER);

  const saysZip = { lastName: 'Aagaard', text: 'Dr Aagaard · 98105' };
  assert.ok(scoreCandidate(charlotte, saysZip).reasons.includes('the meeting mentions this ZIP'));
});

test('an explicit taxonomy hint is used, and a wrong one counts against', () => {
  const c = { name: 'KATIE DIBLIN AAGAARD', firstName: 'KATIE', lastName: 'AAGAARD',
    primaryTaxonomy: 'Counselor, Mental Health', city: 'CONCORD', state: 'NC' };

  // "Counselor" against "Counselor, Mental Health": the registry qualifies what
  // a rep writes plainly, so a containment match still counts.
  const right = scoreCandidate(c, { lastName: 'Aagaard', taxonomy: 'Counselor' });
  assert.ok(right.reasons.includes('primary taxonomy matches'));
  assert.ok(right.confidence >= CONFIDENCE_SHOW);

  const wrong = scoreCandidate(c, { lastName: 'Aagaard', taxonomy: 'Dentist' });
  assert.ok(wrong.reasons.includes('primary taxonomy differs'));
  assert.ok(wrong.confidence < CONFIDENCE_OFFER);
});

test('nothing under the offer bar is handed to the rep, but it is counted', () => {
  // Physicians on purpose: this test is about the CONFIDENCE bar, and a
  // non-doctor would be held back by the eligibility rule instead (see below),
  // which is a different number.
  const nine = Array.from({ length: 9 }, (_, i) => ({
    npi: `${1000000000 + i}`, name: `X${i} AAGAARD`, firstName: `X${i}`, lastName: 'AAGAARD',
    taxonomyCode: '207Q00000X', primaryTaxonomy: 'Family Medicine', city: 'JANESVILLE', state: 'WI',
  }));
  const r = rankCandidates(nine, { lastName: 'Aagaard', text: 'Dr Aagaard' }, { max: 5 });

  assert.deepStrictEqual(r.offered, [], 'a list of 55% guesses teaches clicking through noise');
  assert.strictEqual(r.dropped, 9, 'the silence still has to be explained');
  assert.strictEqual(r.primary, null);
});

// ── Who is even eligible ─────────────────────────────────────────────────────

test('a registry name search returns whoever holds an NPI — only doctors are offered', () => {
  // Real NPPES codes. A brief is produced for physicians, dentists and
  // podiatrists; everyone else is named rather than briefed.
  const list = [
    { npi: '1', name: 'JON AAGAARD', firstName: 'JON', lastName: 'AAGAARD', taxonomyCode: '207Q00000X', primaryTaxonomy: 'Family Medicine' },
    { npi: '2', name: 'TAYLOR AAGAARD', firstName: 'TAYLOR', lastName: 'AAGAARD', taxonomyCode: '104100000X', primaryTaxonomy: 'Social Worker' },
    { npi: '3', name: 'KATIE AAGAARD', firstName: 'KATIE', lastName: 'AAGAARD', taxonomyCode: '101YM0800X', primaryTaxonomy: 'Counselor, Mental Health' },
  ];
  const r = rankCandidates(list, { firstName: 'Jon', lastName: 'Aagaard' }, { max: 5 });

  assert.deepStrictEqual(r.offered.map((c) => c.npi), ['1'], 'only the family physician');
  assert.deepStrictEqual(r.refused.map((c) => c.npi), ['2', '3']);
  assert.strictEqual(r.notDoctor, null, 'a doctor was found, so this is not the answer');
  // The two counts must not overlap: 1 offered + 0 under the bar + 2 refused = 3.
  assert.strictEqual(r.dropped, 0);
});

test('when the registry has nobody but non-doctors, that IS the answer', () => {
  const list = [
    { npi: '2', name: 'TAYLOR AAGAARD', lastName: 'AAGAARD', taxonomyCode: '104100000X', primaryTaxonomy: 'Social Worker' },
    { npi: '4', name: 'CASEY C', lastName: 'AAGAARD', taxonomyCode: '171M00000X', primaryTaxonomy: 'Case Manager/Care Coordinator' },
  ];
  const r = rankCandidates(list, { lastName: 'Aagaard' }, { max: 5 });

  assert.deepStrictEqual(r.offered, []);
  assert.strictEqual(r.primary, null, 'nothing is briefed');
  assert.ok(r.notDoctor, 'the caller states what they are instead');
  assert.strictEqual(r.notDoctor.providerKind.kind, 'not_doctor');
  assert.match(r.notDoctor.providerKind.reason, /not a physician, dentist or podiatrist/);
});

test('a candidate whose taxonomy cannot be placed is still offered', () => {
  const r = rankCandidates(
    [{ npi: '9', name: 'JO X', firstName: 'JO', lastName: 'X', taxonomyCode: '999900000X', primaryTaxonomy: 'Something Unheard Of' }],
    { firstName: 'Jo', lastName: 'X' },
    { max: 5 }
  );
  assert.deepStrictEqual(r.offered.map((c) => c.npi), ['9']);
  assert.deepStrictEqual(r.refused, []);
});

test('a city the meeting mentions decides between two physicians of the same name', () => {
  // The real "Dr ABESELOM" meeting: the description said "Primary Taxonomy -
  // Internal Medicine from CHICAGO", and NPPES returns two Abeselom internists
  // — one in New York, one in Chicago. Before this, the city only counted when
  // the entity matcher had already turned it into a hint, so both scored the
  // same and neither was shown.
  const chicago = {
    npi: '1033798905', name: 'ABESELOM GELETU', firstName: 'ABESELOM', lastName: 'GELETU',
    taxonomyCode: '207RH0003X', primaryTaxonomy: 'Internal Medicine, Hematology & Oncology',
    city: 'CHICAGO', state: 'IL',
  };
  const newYork = {
    npi: '1780317891', name: 'ABESELOM ASHENAFI', firstName: 'ABESELOM', lastName: 'ASHENAFI',
    taxonomyCode: '207R00000X', primaryTaxonomy: 'Internal Medicine', city: 'NEW YORK', state: 'NY',
  };

  const r = rankCandidates([newYork, chicago], {
    firstName: 'Abeselom',
    lastName: '',
    text: 'Meeting with Dr ABESELOM · Primary Taxonomy - Internal Medicine from CHICAGO',
  }, { max: 5 });

  assert.strictEqual(r.primary?.npi, '1033798905', 'the Chicago internist is the answer');
  assert.ok(r.primary.confidence >= CONFIDENCE_SHOW);
  assert.ok(r.primary.matchReasons.includes('the meeting mentions this city'));
  assert.ok(r.primary.matchReasons.includes('the meeting mentions this taxonomy'));
  assert.strictEqual(r.ranked[1].npi, '1780317891');
  assert.ok(
    r.primary.confidence - r.ranked[1].confidence >= 10,
    'and clearly enough ahead that it is not a coin toss'
  );
});

test('a labelled taxonomy on the meeting is used, and beats a mere mention', () => {
  // "Primary Taxonomy - Internal Medicine" is the rep answering the question
  // outright; hintsFromEvent reads it and passes it as `taxonomy`.
  const ny = {
    npi: '1780317891', name: 'ABESELOM ASHENAFI', firstName: 'ABESELOM', lastName: 'ASHENAFI',
    taxonomyCode: '207R00000X', primaryTaxonomy: 'Internal Medicine', city: 'NEW YORK', state: 'NY',
  };
  const r = scoreCandidate(ny, {
    firstName: 'Abeselom',
    taxonomy: 'Internal Medicine',
    text: 'Meeting with Dr ABESELOM · Primary Taxonomy - Internal Medicine from CHICAGO',
  });
  assert.ok(r.reasons.includes('primary taxonomy matches exactly'));
  assert.ok(r.confidence >= CONFIDENCE_SHOW);
});
