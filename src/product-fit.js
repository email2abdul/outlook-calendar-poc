'use strict';

/**
 * Product-fit recommendation — "which Lumendi product is the best fit for this
 * physician?" — surfaced in the pre-meeting brief.
 *
 * DiLumen products are advanced-endoscopy platforms whose value is keeping
 * EMR/ESD resection cases in-suite rather than referring them out. So the best
 * product for a physician follows from WHAT they actually do: we score each
 * product against the physician's procedure-family profile (byFamily, from
 * src/procedure-families.js) plus the authoritative `esd_procedure` flag, and
 * recommend the highest-scoring fit.
 *
 * The product → indicated-procedure mapping is HARDCODED here (POC "quick"
 * approach): the `products` table carries device attributes — balloon config,
 * working channel — but no clinical indication. The catalog below mirrors the
 * dev `products` table (company Lumendi LLC); real indications should later be
 * sourced from brochure ingest (scripts/ingest-products.js) and this catalog
 * replaced with a DB read.
 */

// Each product is scored on its PRIMARY procedure family (what it's really for)
// plus SECONDARY families it also serves. `advanced` = an advanced-resection
// product that benefits from an ESD-performing physician. `accessory` products
// lose a tie-break to platforms. Order = platforms before their accessory.
const CATALOG = [
  {
    name: 'DiLumen C1',
    primary: 'ESD',
    secondary: ['EMR'],
    advanced: true,
    blurb: '6 mm working-channel platform built for advanced in-suite ESD.',
  },
  {
    name: 'DiLumen EZ1',
    primary: 'EMR',
    secondary: ['ESD', 'Colonoscopy'],
    advanced: true,
    blurb:
      'Stabilizes the colon to create a therapeutic working space for resection (EMR/ESD).',
  },
  {
    name: 'DiLumen EZ Glide',
    primary: 'Colonoscopy',
    secondary: ['EMR'],
    advanced: false,
    blurb: 'Double-balloon access platform for difficult-to-reach colonoscopy.',
  },
  {
    name: 'DiLumen IgE Grasper',
    primary: 'ESD',
    secondary: ['EMR'],
    advanced: true,
    accessory: true,
    blurb: 'Grasper accessory for tissue traction during ESD/EMR.',
  },
  {
    name: 'DiLumen EUS Accessory',
    primary: 'EUS',
    secondary: [],
    // `advanced` here means "benefits from the esd_procedure flag" — EUS is a
    // distinct technique from ESD, so it does NOT take the ESD bonus.
    advanced: false,
    accessory: true,
    blurb: 'Accessory that improves access and stability during EUS-guided procedures.',
  },
];

// Acuity ladder — the heart of the model. Almost every GI physician's volume is
// dominated by routine colonoscopy, so scoring on raw volume/share would always
// recommend the colonoscopy product. But DiLumen's value is the *minority,
// high-acuity* resection work. So a product's score is anchored by the ACUITY
// of its primary family that the physician actually performs: an ESD operator
// gets the ESD platform even if ESD is a tiny fraction of their book.
const TIER_BASE = { ESD: 300, EUS: 250, EMR: 200, Colonoscopy: 100 };
const SECONDARY_ONLY_BASE = 50; // product's primary absent but a secondary present
const ESD_FLAG_BONUS = 40; // authoritative esd_procedure flag → advanced platforms
const ACCESSORY_PENALTY = 15; // platforms beat an accessory on a tie
const INTENSITY_CAP = 99; // volume adds at most this on top of the tier base

const STRENGTH = (base) =>
  base >= 200 ? 'Strong fit' : base >= 100 ? 'Moderate fit' : 'Possible fit';

/**
 * Product-name equality between an account's product string and a catalog name.
 * Exact (normalized) match only: account names like "DiLumen EZ"/"DiLumen" don't
 * cleanly map to catalog SKUs ("DiLumen EZ1"/"DiLumen EZ Glide"), and a loose
 * prefix match would let a bare "DiLumen" match every product. So the
 * already-owned/expansion path only fires on a confident exact match; otherwise
 * the current account is still shown, just without an expansion reframe.
 */
function sameProduct(a, b) {
  const n = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const x = n(a);
  const y = n(b);
  return Boolean(x) && x === y;
}

const fmt = (n) => Number(n || 0).toLocaleString();

/**
 * Score every catalog product against a physician's procedure profile and
 * return the best fit.
 *
 * @param {object} opts
 * @param {object} [opts.byFamily] procedure-family rollup ({families,total}) from analytics
 * @param {boolean} [opts.esdProcedure] authoritative esd_procedure flag from bis_physicians
 * @param {object} [opts.account] current Lumendi account ({product,status,isActiveUser}) or null
 * @returns {{
 *   recommended: {productName,score,matchedFamilies,reason,isExpansion}|null,
 *   ranked: Array<{productName,score,matchedFamilies}>,
 *   current: {product,status}|null,
 *   doesAdvanced: boolean,
 *   note: string|null,
 * }}
 */
function computeProductFit({ byFamily, esdProcedure = false, account = null } = {}) {
  const famVol = {};
  let total = 0;
  for (const f of byFamily?.families || []) {
    if (f.family === 'Other') continue;
    famVol[f.family] = f.volume;
    total += f.volume;
  }

  const doesAdvanced =
    Boolean(esdProcedure) || (famVol.ESD || 0) > 0 || (famVol.EMR || 0) > 0;
  const current =
    account && account.product
      ? { product: account.product, status: account.status || null }
      : null;

  // A family is "present" if the physician has volume in it — and for ESD, the
  // authoritative esd_procedure flag alone also qualifies them for the ESD tier.
  const present = (fam) =>
    (famVol[fam] || 0) > 0 || (fam === 'ESD' && Boolean(esdProcedure));

  const ranked = CATALOG.map((p) => {
    const fams = [p.primary, ...p.secondary];
    const matchedFamilies = fams.filter(present);

    let base = 0;
    if (present(p.primary)) base = TIER_BASE[p.primary] || 0;
    else if (matchedFamilies.length) base = SECONDARY_ONLY_BASE;

    // intensity = volume backing this product's families, scaled and capped so
    // it ranks within a tier without letting colonoscopy volume jump tiers.
    const intensity = base
      ? Math.min(
          INTENSITY_CAP,
          Math.round(fams.reduce((s, f) => s + (famVol[f] || 0), 0) / 10)
        )
      : 0;
    const bonus = esdProcedure && p.advanced && base ? ESD_FLAG_BONUS : 0;
    let score = base ? base + intensity + bonus : 0;
    if (score && p.accessory) score -= ACCESSORY_PENALTY;

    return { def: p, base, score, matchedFamilies };
  })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return {
      recommended: null,
      ranked: [],
      current,
      doesAdvanced,
      note: 'No EMR/ESD/colonoscopy volume on record yet — screening-led profile; nurture before pitching a platform.',
    };
  }

  // If the physician is already active on the top pick, recommend the next
  // distinct product as the expansion play (and flag it as such).
  const activeProduct = account?.isActiveUser ? account.product : null;
  const top = ranked[0];
  const alreadyOnTop = activeProduct && sameProduct(activeProduct, top.def.name);
  const pick = alreadyOnTop && ranked[1] ? ranked[1] : top;

  return {
    recommended: {
      productName: pick.def.name,
      strength: STRENGTH(pick.base),
      score: pick.score,
      matchedFamilies: pick.matchedFamilies,
      reason: reasonFor(pick, { famVol, esdProcedure }),
      isExpansion: Boolean(alreadyOnTop),
    },
    ranked: ranked.map((p) => ({
      productName: p.def.name,
      strength: STRENGTH(p.base),
      score: p.score,
      matchedFamilies: p.matchedFamilies,
    })),
    current,
    doesAdvanced,
    note: alreadyOnTop
      ? `Already active on ${activeProduct}; ${pick.def.name} is the expansion play.`
      : null,
  };
}

/** Human-readable "why this product" line for the brief. */
function reasonFor(p, { famVol, esdProcedure }) {
  const famStr = p.matchedFamilies
    .filter((f) => (famVol[f] || 0) > 0)
    .map((f) => `${f} (${fmt(famVol[f])})`)
    .join(', ');
  const signals = [];
  if (famStr) signals.push(`procedure volume in ${famStr}`);
  if (esdProcedure && p.def.advanced) signals.push('an ESD-procedure flag');
  const why = signals.length ? `Matches ${signals.join(' + ')}. ` : '';
  return (why + p.def.blurb).trim();
}

module.exports = { computeProductFit, sameProduct, CATALOG };
