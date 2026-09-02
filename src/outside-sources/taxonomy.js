'use strict';

/**
 * Is this person a doctor?
 *
 * A name search in a national registry returns whoever holds an NPI, and an NPI
 * is not a medical degree: nine people called AAGAARD include four physicians, a
 * dentist, a counsellor, a social worker, a behaviour technician and a physical
 * therapy assistant. A pre-meeting brief for the social worker is worse than no
 * brief — it spends the rep's two minutes on the wrong person and implies the
 * app checked. So a brief is only produced for a doctor, and everyone else gets
 * a plain statement of what the registry says they are.
 *
 * ── Decided on the CODE, not the words ──────────────────────────────────────
 * NPPES returns each provider's NUCC Health Care Provider Taxonomy code
 * ("207RC0001X"), and its first two digits are the official Provider Grouping.
 * That is a stable, structured fact; classifying "Physician Assistant" by
 * looking for the word "physician" is not. The description is used only when a
 * code is missing, and then negatives are checked first for exactly that reason.
 *
 * ── Three outcomes, and the third is the important one ──────────────────────
 * `doctor` and `not_doctor` are answers. `unknown` means the registry gave a
 * grouping this table does not carry, and it NEVER suppresses a brief. That
 * default is deliberate: while writing this table, a grouping remembered as
 * chiropractic (16) turned out to be nursing, and chiropractic to be 11 — an
 * incomplete table costs a little noise, a wrong one silently eats a real
 * physician's brief.
 *
 * Every prefix below was verified against the live NPPES API on 2026-09-02, by
 * reading back the code of a provider the registry itself returned.
 */

/** Groupings whose members are doctors — the rep's own rule. */
const DOCTOR_GROUPINGS = {
  20: 'Allopathic & Osteopathic Physicians', // 207RC0001X Internal Medicine, 208D00000X General Practice
  21: 'Podiatric Medicine & Surgery', // 213E00000X Podiatrist
};

/**
 * The dental grouping is the one that is NOT uniform, so it gets its own rule.
 *
 * 12 holds the dentist (1223…, every dental specialty) alongside the hygienist
 * (124Q00000X), the dental assistant and the dental laboratory technician.
 * "A dentist is a doctor" was the rep's call; a dental hygienist is not one, and
 * grouping alone would have briefed them.
 */
const DENTIST_PREFIX = '1223';

/**
 * Groupings whose members are not doctors. Clinical or not — a nurse
 * practitioner and a case manager are both here — because the rule is
 * "physicians, dentists and podiatrists get a brief", and everybody else is
 * named rather than briefed.
 */
const OTHER_GROUPINGS = {
  10: 'Behavioral Health & Social Service Providers', // 101YM0800X Counselor, 104100000X Social Worker, 106S00000X Behavior Technician
  11: 'Chiropractic Providers', // 111N00000X Chiropractor
  15: 'Eye and Vision Services Providers', // 152W00000X Optometrist
  16: 'Nursing Service Providers', // 163WP0809X Registered Nurse
  17: 'Other Service Providers', // 171M00000X Case Manager/Care Coordinator, 176B00000X Midwife, 171100000X Acupuncturist
  18: 'Pharmacy Service Providers', // 183500000X Pharmacist
  22: 'Respiratory, Developmental, Rehabilitative & Restorative Providers', // 225100000X Physical Therapist, 225200000X PTA, 225700000X Massage Therapist
  23: 'Speech, Language & Hearing Providers', // 237600000X Audiologist-Hearing Aid Fitter
  24: 'Technologists, Technicians & Other Technical Providers', // 2471M1202X Radiologic Technologist
  25: 'Agencies', // 251S00000X Community/Behavioral Health
  36: 'Physician Assistants & Advanced Practice Nursing Providers', // 363A00000X Physician Assistant
  37: 'Nursing & Custodial Care / Personal Care Providers', // 3747P1801X Technician, Personal Care Attendant
  39: 'Students & Other', // 390200000X Student in an Organized Health Care Education/Training Program
};

/**
 * Words that settle it when there is NO code — checked first, because half of
 * them contain a doctor word: "Physician Assistant", "Nurse Practitioner",
 * "Medical Assistant", "Surgical Technologist".
 */
// NOTE the shape: `\b(?:…)\w*` — anchored at a word start and allowed to finish
// the word. Written as `\b(…)\b` (the first version), every truncated stem was
// dead: "gastroenterolog" cannot be followed by a word boundary in
// "Gastroenterology", so the whole positive list silently matched nothing.
const NOT_DOCTOR_WORDS =
  /\b(?:assistant|aide|technician|technologist|coordinator|manager|navigator|social worker|counsel|therapist|therapy|nurse|nursing|midwife|doula|lactation|paramedic|emt|pharmac|dietit|nutrition|chiropract|optometr|optician|audiolog|acupunctur|massage|athletic trainer|psycholog|behavior|hygienist|denturist|case management|billing|clerk|transport|driver|agency|laboratory|supplier|student|resident|attendant|personal care)\w*/i;

/** Words that name a doctor, once the negatives above are out of the way. */
const DOCTOR_WORDS =
  /\b(?:physician|surgeon|surgery|surgical|hospitalist|dentist|podiatrist|anesthesiolog|cardiolog|dermatolog|endocrinolog|gastroenterolog|geriatric medicine|hematolog|internal medicine|nephrolog|neurolog|obstetric|oncolog|ophthalmolog|orthopaed|orthoped|otolaryngolog|patholog|pediatric|psychiatr|pulmonolog|radiolog|rheumatolog|urolog|family medicine|general practice|emergency medicine|preventive medicine|colon (?:&|and) rectal)\w*/i;

/** The first two digits of a NUCC taxonomy code, or null. */
function groupingOf(code) {
  const digits = String(code || '').trim();
  return /^\d{2}/.test(digits) ? digits.slice(0, 2) : null;
}

/**
 * Classify one provider by their PRIMARY taxonomy.
 *
 * @param {object} taxonomy
 * @param {string} [taxonomy.code]  NUCC code, e.g. "104100000X"
 * @param {string} [taxonomy.desc]  e.g. "Social Worker"
 * @returns {{
 *   kind: 'doctor'|'not_doctor'|'unknown',
 *   label: string|null,      the taxonomy as the registry states it
 *   grouping: string|null,   the two-digit NUCC grouping
 *   groupingLabel: string|null,
 *   via: 'code'|'description'|null,
 *   reason: string           one line, written for a rep to read
 * }}
 */
function classify({ code, desc } = {}) {
  const label = desc ? String(desc).trim() : null;
  const grouping = groupingOf(code);

  if (grouping === '12') {
    const isDentist = String(code).startsWith(DENTIST_PREFIX);
    return {
      kind: isDentist ? 'doctor' : 'not_doctor',
      label,
      grouping,
      groupingLabel: 'Dental Providers',
      via: 'code',
      reason: isDentist
        ? `${label || 'this taxonomy'} is a dentist (NUCC ${DENTIST_PREFIX}…), which counts as a doctor here.`
        : `${label || 'this taxonomy'} is in the dental grouping but is not a dentist (NUCC ${code}) — not a physician, dentist or podiatrist.`,
    };
  }

  if (grouping && DOCTOR_GROUPINGS[grouping]) {
    return {
      kind: 'doctor',
      label,
      grouping,
      groupingLabel: DOCTOR_GROUPINGS[grouping],
      via: 'code',
      reason: `${label || 'this taxonomy'} is in NUCC grouping ${grouping} — ${DOCTOR_GROUPINGS[grouping]}.`,
    };
  }

  if (grouping && OTHER_GROUPINGS[grouping]) {
    return {
      kind: 'not_doctor',
      label,
      grouping,
      groupingLabel: OTHER_GROUPINGS[grouping],
      via: 'code',
      reason: `${label || 'this taxonomy'} is in NUCC grouping ${grouping} — ${OTHER_GROUPINGS[grouping]}, not a physician, dentist or podiatrist.`,
    };
  }

  // No code, or a grouping this table does not carry: fall back to the words —
  // negatives first, since "Physician Assistant" contains "physician".
  if (label) {
    if (NOT_DOCTOR_WORDS.test(label)) {
      return {
        kind: 'not_doctor',
        label,
        grouping,
        groupingLabel: grouping ? null : null,
        via: 'description',
        reason: `The registry lists them as "${label}", which is not a physician, dentist or podiatrist.`,
      };
    }
    if (DOCTOR_WORDS.test(label)) {
      return {
        kind: 'doctor',
        label,
        grouping,
        groupingLabel: null,
        via: 'description',
        reason: `The registry lists them as "${label}".`,
      };
    }
  }

  return {
    kind: 'unknown',
    label,
    grouping,
    groupingLabel: null,
    via: null,
    reason: label
      ? `The registry lists them as "${label}", which this app cannot place either way — so the brief is shown.`
      : 'The registry states no taxonomy for them, so the brief is shown.',
  };
}

/** Convenience: classify a source candidate (its primary taxonomy). */
function classifyCandidate(candidate = {}) {
  return classify({
    code: candidate.taxonomyCode,
    desc: candidate.primaryTaxonomy || candidate.specialty,
  });
}

/** True when a brief must NOT be produced for this candidate. */
function isSuppressed(candidate) {
  return classifyCandidate(candidate).kind === 'not_doctor';
}

module.exports = {
  classify,
  classifyCandidate,
  isSuppressed,
  groupingOf,
  DOCTOR_GROUPINGS,
  OTHER_GROUPINGS,
};
