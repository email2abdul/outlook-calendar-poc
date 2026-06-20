'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Product Context Layer — match (Lumendi spec, P6).
 *
 * Loads the product knowledge that scripts/ingest-products.js extracted from the
 * Lumendi brochures (config/product-context.json) and, given a physician's
 * procedure-family profile, surfaces the products and talking points relevant to
 * what that physician actually does. This is the brief's "What to discuss?"
 * answer (success-criteria Q6) and is fully deterministic — the AI work happened
 * once during ingest, so no LLM call is made per briefing.
 *
 * When the config is absent (brochures not yet ingested) every call returns
 * null and the brief simply omits the section.
 */

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'product-context.json');

let cache; // undefined = not loaded; null = absent/invalid; object = loaded
function load() {
  if (cache !== undefined) return cache;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed.products) ? parsed.products : null;
  } catch {
    cache = null; // not generated yet
  }
  return cache;
}

/**
 * Talking points for a physician, ranked by how much they perform each family.
 * @param {object} byFamily analytics.byFamily — { families:[{family,volume}], total }
 * @param {object} [opts]
 * @param {number} [opts.maxProducts=3]
 * @returns {{ products: Array<{
 *   productName:string, summary:string, matchedFamilies:string[], volume:number,
 *   talkingPoints:string[], differentiation:string[], reimbursement:string[],
 *   valueProps:string[] }> }|null}
 */
function getTalkingPoints(byFamily, { maxProducts = 3 } = {}) {
  const products = load();
  if (!products?.length || !byFamily?.families?.length) return null;

  // Volume the physician does in each family — drives product relevance ranking.
  const volByFamily = {};
  for (const f of byFamily.families) volByFamily[f.family] = f.volume;

  const matched = [];
  for (const p of products) {
    const fams = (p.applies_to_families || []).filter((f) => volByFamily[f] > 0);
    if (!fams.length) continue; // product doesn't serve anything this physician does
    const volume = fams.reduce((s, f) => s + volByFamily[f], 0);
    matched.push({
      productName: p.product_name,
      summary: p.summary || '',
      matchedFamilies: fams,
      volume,
      talkingPoints: p.talking_points || [],
      differentiation: p.competitive_differentiation || [],
      reimbursement: p.reimbursement_notes || [],
      valueProps: p.value_propositions || [],
    });
  }
  if (!matched.length) return null;

  matched.sort((a, b) => b.volume - a.volume);
  return { products: matched.slice(0, maxProducts) };
}

module.exports = { getTalkingPoints, configPath: CONFIG_PATH };
