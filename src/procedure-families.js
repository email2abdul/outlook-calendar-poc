'use strict';

/**
 * Procedure-family classifier for the pre-meeting brief's "Procedure
 * Intelligence" section (Lumendi spec: Colonoscopy / ESD / EMR / EUS volumes).
 *
 * The master data categorizes CPT codes only as Diagnostic / Therapeutic /
 * Screening, not by the clinical procedure families Lumendi sells into. This
 * module maps each CPT code (by code, then by description keywords) into one of
 * those families so the brief can headline the numbers a rep actually needs.
 *
 * Why description-first matters: ESD and EUS are low-volume, *emerging* signals
 * — exactly what Lumendi wants surfaced — so they must be bucketed from the
 * physician's FULL CPT list, never just the top-N (where they'd be truncated).
 */

// Display order = the order Lumendi listed them in the spec.
const FAMILIES = ['Colonoscopy', 'EMR', 'ESD', 'EUS'];

const FAMILY_LABELS = {
  Colonoscopy: 'Colonoscopy',
  EMR: 'EMR (Endoscopic Mucosal Resection)',
  ESD: 'ESD (Endoscopic Submucosal Dissection)',
  EUS: 'EUS (Endoscopic Ultrasound)',
  Other: 'Other procedures',
};

// Exact CPT → family. Most precise signal; checked before keyword heuristics.
const CPT_FAMILY = {
  // EMR — mucosal resection
  '45390': 'EMR', // colonoscopy with endoscopic mucosal resection
  '43254': 'EMR', // EGD with endoscopic mucosal resection
  // EUS — endoscopic ultrasound (incl. FNA)
  '45391': 'EUS', '45392': 'EUS',
  '43231': 'EUS', '43232': 'EUS', '43237': 'EUS', '43238': 'EUS',
  '43242': 'EUS', '43253': 'EUS', '43259': 'EUS', '76975': 'EUS',
  // Colonoscopy — diagnostic/therapeutic lower-GI endoscopy + screening
  '45378': 'Colonoscopy', '45379': 'Colonoscopy', '45380': 'Colonoscopy',
  '45381': 'Colonoscopy', '45382': 'Colonoscopy', '45383': 'Colonoscopy',
  '45384': 'Colonoscopy', '45385': 'Colonoscopy', '45386': 'Colonoscopy',
  '45388': 'Colonoscopy', '45389': 'Colonoscopy', '45393': 'Colonoscopy',
  '45398': 'Colonoscopy',
  G0105: 'Colonoscopy', G0120: 'Colonoscopy', G0121: 'Colonoscopy',
};

// Description keyword → family. Fallback when the code isn't in the table.
// Ordered most-specific first (ESD/EMR/EUS before generic colonoscopy).
const KEYWORD_RULES = [
  [/submucosal dissection|\besd\b/i, 'ESD'],
  [/mucosal resection|\bemr\b/i, 'EMR'],
  [/ultrasound|\beus\b|endosonograph/i, 'EUS'],
  [/colonoscop|large bowel|colorectal|sigmoidoscop|lower gi/i, 'Colonoscopy'],
];

/**
 * Classify one CPT code + description into a procedure family.
 * @returns {'Colonoscopy'|'EMR'|'ESD'|'EUS'|'Other'}
 */
function classifyCpt(cptCode, description) {
  const code = String(cptCode || '').trim().toUpperCase();
  if (CPT_FAMILY[code]) return CPT_FAMILY[code];

  const desc = String(description || '');
  for (const [re, family] of KEYWORD_RULES) {
    if (re.test(desc)) return family;
  }
  return 'Other';
}

/**
 * Bucket per-CPT volumes into procedure families.
 * @param {Array<{cptCode:string, description?:string, volume:number|string}>} rows
 * @returns {{ families: Array<{family:string,label:string,volume:number,
 *   cptCodes:string[]}>, total:number }}
 *   families includes only non-empty buckets, highest volume first; 'Other'
 *   always sorts last when present.
 */
function bucketVolumes(rows) {
  const acc = {}; // family -> { volume, cptCodes:Set }
  let total = 0;

  for (const r of rows || []) {
    const vol = Number(r.volume) || 0;
    if (!vol) continue; // zero-volume CPTs add no signal
    const family = classifyCpt(r.cptCode, r.description);
    if (!acc[family]) acc[family] = { volume: 0, cptCodes: new Set() };
    acc[family].volume += vol;
    acc[family].cptCodes.add(String(r.cptCode));
    total += vol;
  }

  const families = Object.entries(acc)
    .map(([family, v]) => ({
      family,
      label: FAMILY_LABELS[family] || family,
      volume: v.volume,
      cptCodes: [...v.cptCodes].sort(),
    }))
    .sort((a, b) => {
      if (a.family === 'Other') return 1; // Other last
      if (b.family === 'Other') return -1;
      return b.volume - a.volume;
    });

  return { families, total };
}

module.exports = { FAMILIES, FAMILY_LABELS, classifyCpt, bucketVolumes };
