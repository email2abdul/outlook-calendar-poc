'use strict';

const test = require('node:test');
const assert = require('node:assert');

/**
 * Who gets a brief — src/outside-sources/taxonomy.js.
 *
 * Every code below was read back from the live NPPES API (2026-09-02), so this
 * is the real registry's own vocabulary, not a fixture. The rep's rule: a brief
 * is produced for physicians, dentists and podiatrists; everybody else is named
 * rather than briefed; and anything this table cannot place is briefed anyway.
 */
const { classify, classifyCandidate, isSuppressed } = require('../src/outside-sources/taxonomy');

test('the nine real AAGAARDs split the way the registry says they do', () => {
  const cases = [
    ['207RC0001X', 'Internal Medicine, Clinical Cardiac Electrophysiology', 'doctor'],
    ['207Q00000X', 'Family Medicine', 'doctor'],
    ['208D00000X', 'General Practice', 'doctor'],
    ['207P00000X', 'Emergency Medicine', 'doctor'],
    ['122300000X', 'Dentist', 'doctor'], // the rep's call: a dentist is a doctor
    ['101YM0800X', 'Counselor, Mental Health', 'not_doctor'],
    ['104100000X', 'Social Worker', 'not_doctor'],
    ['106S00000X', 'Behavior Technician', 'not_doctor'],
    ['225200000X', 'Physical Therapy Assistant', 'not_doctor'],
  ];
  for (const [code, desc, kind] of cases) {
    assert.strictEqual(classify({ code, desc }).kind, kind, `${desc} (${code})`);
  }
});

test('the roles the rep named by hand are all refused', () => {
  const refused = [
    ['171M00000X', 'Case Manager/Care Coordinator'],
    ['104100000X', 'Social Worker'],
    ['363A00000X', 'Physician Assistant'], // contains "physician"; still not a doctor
    ['163WP0809X', 'Registered Nurse, Psych/Mental Health, Adult'],
    ['183500000X', 'Pharmacist'],
    ['152W00000X', 'Optometrist'],
    ['111N00000X', 'Chiropractor'],
    ['2471M1202X', 'Radiologic Technologist, Magnetic Resonance'],
    ['225100000X', 'Physical Therapist'],
    ['237600000X', 'Audiologist-Hearing Aid Fitter'],
    ['176B00000X', 'Midwife'],
    ['251S00000X', 'Community/Behavioral Health'],
  ];
  for (const [code, desc] of refused) {
    const c = classify({ code, desc });
    assert.strictEqual(c.kind, 'not_doctor', `${desc} (${code})`);
    assert.strictEqual(c.via, 'code', 'the code decides it, not the words');
    assert.match(c.reason, /not a physician, dentist or podiatrist/);
  }
});

test('podiatrists and every physician sub-specialty are doctors', () => {
  assert.strictEqual(classify({ code: '213E00000X', desc: 'Podiatrist' }).kind, 'doctor');
  assert.strictEqual(classify({ code: '207L00000X', desc: 'Anesthesiology' }).kind, 'doctor');
  assert.strictEqual(
    classify({ code: '207RG0100X', desc: 'Internal Medicine, Gastroenterology' }).kind,
    'doctor'
  );
});

test('a grouping this table does not carry is briefed, never suppressed', () => {
  // The safe default, and the reason it exists: a grouping remembered wrongly
  // would otherwise eat a real physician's brief in silence.
  const unplaced = classify({ code: '999900000X', desc: 'Something Nobody Has Heard Of' });
  assert.strictEqual(unplaced.kind, 'unknown');
  assert.match(unplaced.reason, /cannot place either way — so the brief is shown/);

  const nothing = classify({});
  assert.strictEqual(nothing.kind, 'unknown');
  assert.match(nothing.reason, /states no taxonomy/);
});

test('with no code, the words decide — and negatives are read first', () => {
  // Each of these contains a doctor word and is not a doctor.
  for (const desc of ['Physician Assistant', 'Nurse Practitioner, Family', 'Medical Assistant', 'Surgical Technologist']) {
    const c = classify({ desc });
    assert.strictEqual(c.kind, 'not_doctor', desc);
    assert.strictEqual(c.via, 'description');
  }

  for (const desc of ['Gastroenterology', 'Colon & Rectal Surgery', 'Hospitalist', 'Dentist']) {
    assert.strictEqual(classify({ desc }).kind, 'doctor', desc);
  }
});

test('a candidate is classified from whichever taxonomy field it carries', () => {
  assert.strictEqual(
    classifyCandidate({ taxonomyCode: '104100000X', primaryTaxonomy: 'Social Worker' }).kind,
    'not_doctor'
  );
  // CMS supplies a provider type but no NUCC code — the words have to do it.
  assert.strictEqual(classifyCandidate({ specialty: 'Internal Medicine' }).kind, 'doctor');
  assert.strictEqual(isSuppressed({ taxonomyCode: '171M00000X', primaryTaxonomy: 'Case Manager/Care Coordinator' }), true);
  assert.strictEqual(isSuppressed({ taxonomyCode: '207Q00000X', primaryTaxonomy: 'Family Medicine' }), false);
  assert.strictEqual(isSuppressed({}), false, 'unknown is never suppressed');
});

test('the roles a first-name search drags in are refused, on live-verified codes', () => {
  // Every one of these came back from `first_name=ABESELOM` (2026-09-02): a
  // personal care attendant, a driver and a student alongside two physicians.
  const cases = [
    ['3747P1801X', 'Technician, Personal Care Attendant', 'not_doctor'],
    ['172A00000X', 'Driver', 'not_doctor'],
    ['390200000X', 'Student in an Organized Health Care Education/Training Program', 'not_doctor'],
    ['207R00000X', 'Internal Medicine', 'doctor'],
    ['207RH0003X', 'Internal Medicine, Hematology & Oncology', 'doctor'],
  ];
  for (const [code, desc, kind] of cases) {
    assert.strictEqual(classify({ code, desc }).kind, kind, `${desc} (${code})`);
  }
});

test('"Internal Medicine" survives the negative word list', () => {
  // A negative stem of "intern" matched "Internal Medicine" and turned every
  // internist without a NUCC code — CMS supplies none — into a non-doctor.
  for (const desc of ['Internal Medicine', 'Internal Medicine, Gastroenterology', 'Internal Medicine, Cardiovascular Disease']) {
    assert.strictEqual(classify({ desc }).kind, 'doctor', desc);
  }
  assert.strictEqual(classify({ desc: 'Student in an Organized Health Care Education/Training Program' }).kind, 'not_doctor');
  assert.strictEqual(classify({ desc: 'Technician, Personal Care Attendant' }).kind, 'not_doctor');
});
