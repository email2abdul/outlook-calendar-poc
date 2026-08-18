'use strict';

/**
 * Provenance — the field type the whole enrichment feature is built on.
 *
 * A physician assembled from outside BIS is only useful if the rep can see
 * WHERE each value came from, so an enriched field is never a bare scalar:
 *
 *   { value, source, sourceUrl, tier, confidence, retrievedAt }
 *
 * Four tiers, in precedence order (see docs/external-enrichment-agent.md §5):
 *
 *   db        🟢 BIS       your Supabase master (bis_physicians / bis_facilities)
 *   verified  🔵 Verified  official government registry (NPPES, CMS, Open Payments)
 *   web       🟡 Web       AI-extracted from the open web — always with a link
 *   inferred  ⚪ Inferred  derived by us (email domain → org, state → territory)
 *
 * Two rules matter more than the rest:
 *
 *  1. BIS wins. A higher tier never loses to a lower one, so external data can
 *     fill gaps but can never overwrite the master.
 *  2. Losers are kept. A disagreement is recorded as a visible conflict rather
 *     than silently discarded — the rep decides who is right, not this module.
 *
 * Fields the bis_* schema has no column for (publications, star ratings,
 * industry payments) go to `setExtra()` and render under "Extra Intelligence",
 * so "new information" is always distinguishable from "enriched information".
 */

const TIERS = ['db', 'verified', 'web', 'inferred'];
const TIER_RANK = { db: 4, verified: 3, web: 2, inferred: 1 };

const TIER_LABEL = {
  db: 'BIS',
  verified: 'Verified',
  web: 'Web',
  inferred: 'Inferred',
};

const TIER_BADGE = {
  db: '🟢',
  verified: '🔵',
  web: '🟡',
  inferred: '⚪',
};

/** Empty-ish values must not become fields — they'd render as blank rows. */
function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Build one provenance-tagged field. Returns null for an empty value, so
 * callers can write `p.set('phone', field(maybePhone, meta))` unconditionally.
 *
 * @param {*} value
 * @param {object} meta
 * @param {string} meta.source     human-readable source name ("NPPES NPI Registry")
 * @param {string} [meta.sourceUrl] page a human can open to verify the claim
 * @param {'db'|'verified'|'web'|'inferred'} meta.tier
 * @param {number} [meta.confidence=100] 0-100
 * @param {string} [meta.retrievedAt]  ISO timestamp; defaults to now
 */
function field(value, meta = {}) {
  if (isEmpty(value)) return null;
  const tier = TIERS.includes(meta.tier) ? meta.tier : 'inferred';
  return {
    value: typeof value === 'string' ? value.trim() : value,
    source: meta.source || 'unknown',
    sourceUrl: meta.sourceUrl || null,
    tier,
    tierLabel: TIER_LABEL[tier],
    badge: TIER_BADGE[tier],
    confidence: Number.isFinite(meta.confidence) ? meta.confidence : 100,
    retrievedAt: meta.retrievedAt || new Date().toISOString(),
  };
}

/** Convenience wrappers so call sites read as prose. */
const fromBis = (value, meta = {}) => field(value, { tier: 'db', source: 'BIS master data', ...meta });
const fromRegistry = (value, meta = {}) => field(value, { tier: 'verified', ...meta });
const fromWeb = (value, meta = {}) => field(value, { tier: 'web', ...meta });
const inferred = (value, meta = {}) => field(value, { tier: 'inferred', source: 'derived', ...meta });

/**
 * A profile under construction. Not a class — the rest of the codebase uses
 * plain factory functions returning closures over local state.
 */
function createProfile() {
  const fields = {};   // key → field  (maps onto something bis_* models)
  const extras = {};   // key → field  (no BIS counterpart — "+ EXTRA")
  const conflicts = []; // { key, kept, discarded }
  const notes = [];    // free-text explanations for the UI

  /** Insert `f` at `key`, keeping the higher tier and recording any conflict. */
  function place(bucket, key, f) {
    if (!f) return bucket[key] || null;

    const existing = bucket[key];
    if (!existing) {
      bucket[key] = f;
      return f;
    }

    const incomingWins = TIER_RANK[f.tier] > TIER_RANK[existing.tier];
    const [kept, discarded] = incomingWins ? [f, existing] : [existing, f];
    bucket[key] = kept;

    // Only a genuine disagreement is a conflict; the same value confirmed by a
    // second source is corroboration, and noise in the UI.
    const same =
      String(kept.value).trim().toLowerCase() === String(discarded.value).trim().toLowerCase();
    if (!same) {
      conflicts.push({
        key,
        kept: { value: kept.value, source: kept.source, tier: kept.tier },
        discarded: { value: discarded.value, source: discarded.source, tier: discarded.tier },
      });
    }
    return kept;
  }

  return {
    /** Set a field that has a BIS counterpart. */
    set: (key, f) => place(fields, key, f),
    /** Set a field BIS does not model at all — rendered as "+ EXTRA". */
    setExtra: (key, f) => place(extras, key, f),
    /** Add a human-readable explanation ("Facility found in BIS: …"). */
    note: (text) => {
      if (text) notes.push(text);
      return text;
    },
    /**
     * Remove every field matching `fn(field, key)`.
     *
     * Needed when an identity is withdrawn: if the person we resolved turns out
     * to be too uncertain to name, everything derived from that identity has to
     * go with it — leaving the fields behind would show a stranger's specialty
     * and address under a "could not identify" heading.
     */
    dropWhere(fn) {
      for (const bucket of [fields, extras]) {
        for (const key of Object.keys(bucket)) {
          if (fn(bucket[key], key)) delete bucket[key];
        }
      }
      for (let i = conflicts.length - 1; i >= 0; i--) {
        if (!fields[conflicts[i].key] && !extras[conflicts[i].key]) conflicts.splice(i, 1);
      }
    },

    get: (key) => fields[key] || extras[key] || null,
    /** Plain value of a field, or `fallback`. */
    valueOf: (key, fallback = null) => (fields[key] || extras[key] || {}).value ?? fallback,
    has: (key) => Boolean(fields[key] || extras[key]),

    /** Serialisable shape for the API, the store and the renderer. */
    toJSON() {
      return {
        fields,
        extra: extras,
        conflicts,
        notes,
        sources: sourceSummary({ ...fields, ...extras }),
      };
    },
  };
}

/**
 * Collapse a field map into a per-source summary:
 * `[{ source, url, tier, fields: [...], retrievedAt }]` — this is what the
 * "where did this come from" footer and the `sources` column render from.
 */
function sourceSummary(allFields) {
  const bySource = new Map();
  for (const [key, f] of Object.entries(allFields)) {
    if (!f) continue;
    const id = `${f.source}|${f.sourceUrl || ''}`;
    if (!bySource.has(id)) {
      bySource.set(id, {
        source: f.source,
        url: f.sourceUrl,
        tier: f.tier,
        badge: f.badge,
        fields: [],
        retrievedAt: f.retrievedAt,
      });
    }
    bySource.get(id).fields.push(key);
  }
  return [...bySource.values()].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier]);
}

module.exports = {
  field,
  fromBis,
  fromRegistry,
  fromWeb,
  inferred,
  createProfile,
  sourceSummary,
  TIERS,
  TIER_RANK,
  TIER_LABEL,
  TIER_BADGE,
};
