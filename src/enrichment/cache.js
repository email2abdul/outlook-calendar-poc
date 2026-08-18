'use strict';

const supabase = require('../supabase');

/**
 * Enrichment cache — app_external_profiles, plus a small in-process layer.
 *
 * Enrichment is the most expensive thing this app does: a full lookup costs a
 * paid web search and half a dozen registry round-trips, and the same physician
 * gets looked at every time the rep opens the meeting. Nothing about a
 * physician's NPI, specialty or hospital changes hour to hour, so results are
 * held for two weeks.
 *
 * Two rules keep the cache from doing harm:
 *
 *  1. **Never serve a shallower answer than the caller asked for.** A result
 *     produced without the paid web tier must not satisfy a request that wants
 *     it, or "Identify with web search" would return the same "unresolved" it
 *     was pressed to fix.
 *  2. **Never cache a BIS hit.** `in_bis` is a free in-memory lookup that must
 *     reflect the master as it is now, not as it was a fortnight ago.
 *  3. **Never cache a failure.** An `unresolved` is as often a transient source
 *     outage as a real dead end; remembering it would hide the physician until
 *     the entry expired.
 *
 * Degrades to a no-op when Supabase is unconfigured or the table has not been
 * created yet (DDL is applied by hand — supabase/enrichment-setup.sql), so the
 * agent keeps working, just without memory.
 */

const TABLE = 'app_external_profiles';
const TTL_DAYS = Number(process.env.ENRICHMENT_CACHE_DAYS) || 14;
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;
const MEMORY_LIMIT = 500;

// Statuses that represent a finished answer. Anything else is worth retrying.
const RESOLVED = new Set(['recovered_in_bis', 'external', 'not_physician']);

const memory = new Map(); // email → { row, storedAt }
let tableMissing = false; // set once the table is known to be absent

/**
 * Is this error "the table does not exist"?
 *
 * PostgREST does not surface Postgres's 42P01 here — a missing table comes back
 * as PGRST205 with "Could not find the table … in the schema cache". Matching
 * only on 42P01 meant the agent logged a write failure on every single lookup
 * instead of disabling the cache once.
 */
function isMissingTable(error) {
  if (!error) return false;
  const code = error.code || '';
  const message = error.message || '';
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    /schema cache/i.test(message) ||
    /does not exist/i.test(message)
  );
}

function normEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return e.includes('@') ? e : null;
}

/**
 * The cache key for a lookup. A profile is addressable two ways: by the email
 * the rep is looking at, and by NPI — the backfill enriches physicians who are
 * already in BIS and have no email at all, so there is no address to key on.
 */
function keyFor({ email, npi } = {}) {
  const e = normEmail(email);
  if (e) return e;
  const n = String(npi || '').replace(/\D/g, '');
  return n.length === 10 ? `npi:${n}` : null;
}

function isFresh(refreshedAt) {
  if (!refreshedAt) return false;
  const ts = Date.parse(refreshedAt);
  return Number.isFinite(ts) && Date.now() - ts < TTL_MS;
}

/**
 * Can this cached result answer the current request?
 *
 * @param {object} row      cached row
 * @param {boolean} wantWeb caller expects the paid identity tier to run
 */
function satisfies(row, wantWeb) {
  if (!row || !isFresh(row.refreshed_at)) return false;
  if (RESOLVED.has(row.status)) return true;
  // An unfinished answer is only reusable if it was already as deep as we'd go.
  return wantWeb ? Boolean(row.web_used) : true;
}

function rememberInMemory(email, row) {
  if (memory.size >= MEMORY_LIMIT) {
    // Cheap FIFO eviction — enough for a per-process hot set.
    memory.delete(memory.keys().next().value);
  }
  memory.set(email, row);
}

/**
 * Look up a cached enrichment.
 * @returns {Promise<object|null>} the stored `result` object, or null
 */
async function get(emailOrRef, { wantWeb = false } = {}) {
  const key =
    typeof emailOrRef === 'string' ? keyFor({ email: emailOrRef }) : keyFor(emailOrRef || {});
  if (!key) return null;

  const local = memory.get(key);
  if (local && satisfies(local, wantWeb)) return hydrate(local);

  if (!supabase || tableMissing) return null;

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('lookup_key', key)
      .limit(1);

    if (error) {
      if (isMissingTable(error)) {
        tableMissing = true;
        console.warn(
          `[enrichment:cache] ${TABLE} not found — run supabase/enrichment-setup.sql. ` +
            'Falling back to in-process caching only.'
        );
      }
      return null;
    }

    const row = data?.[0];
    if (!row || !satisfies(row, wantWeb)) return null;

    rememberInMemory(key, row);
    return hydrate(row);
  } catch {
    return null;
  }
}

/** Stored row → the enrich() result shape, tagged as served from cache. */
function hydrate(row) {
  const result = row.profile?.result || null;
  if (!result) return null;
  return {
    ...result,
    cached: true,
    cachedAt: row.refreshed_at || row.created_at || null,
  };
}

/**
 * Store an enrichment result. Best-effort: a cache write must never fail the
 * request that produced it.
 */
async function put(emailOrRef, result) {
  const ref = typeof emailOrRef === 'string' ? { email: emailOrRef } : emailOrRef || {};
  const key = keyFor(ref);
  if (!key || !result) return;
  if (result.status === 'in_bis') return; // rule 2 — always read the master live

  // Rule 3: only remember a finished answer.
  //
  // `unresolved` is as often a transient source outage as a real dead end — an
  // NPPES blip during testing produced one, and caching it would have hidden
  // the physician for two weeks. `ambiguous` is only worth keeping when the
  // paid tier already ran, since a retry would spend that money to reach the
  // same weak answer.
  const webUsed = (result.tiers || []).includes('T1:web-identity');
  if (result.status === 'unresolved') return;
  if (result.status === 'ambiguous' && !webUsed) return;

  const row = {
    lookup_key: key,
    lookup_email: normEmail(ref.email),
    resolved_npi: result.npi || null,
    in_bis: Boolean(result.inBis),
    matched_facility_id: result.matchedFacility?.id || null,
    status: result.status,
    confidence: result.confidence ?? null,
    web_used: webUsed,
    // The whole result is stored so a cache hit can rebuild the brief exactly.
    profile: { result },
    sources: result.profile?.sources || [],
    refreshed_at: new Date().toISOString(),
  };

  rememberInMemory(key, { ...row, created_at: row.refreshed_at });

  if (!supabase || tableMissing) return;

  try {
    const { error } = await supabase.from(TABLE).upsert(row, { onConflict: 'lookup_key' });
    if (error) {
      if (isMissingTable(error)) {
        tableMissing = true;
        console.warn(
          `[enrichment:cache] ${TABLE} not found — run supabase/enrichment-setup.sql. ` +
            'Falling back to in-process caching only.'
        );
      } else {
        console.warn('[enrichment:cache] write failed:', error.message);
      }
    }
  } catch (err) {
    console.warn('[enrichment:cache] write failed:', err.message);
  }
}

/** Drop one entry (both layers) — used by a forced refresh. */
async function invalidate(emailOrRef) {
  const key =
    typeof emailOrRef === 'string' ? keyFor({ email: emailOrRef }) : keyFor(emailOrRef || {});
  if (!key) return;
  memory.delete(key);
  if (!supabase || tableMissing) return;
  try {
    await supabase.from(TABLE).delete().eq('lookup_key', key);
  } catch {
    /* best effort */
  }
}

module.exports = {
  get,
  put,
  invalidate,
  keyFor,
  TTL_DAYS,
  get enabled() {
    return Boolean(supabase) && !tableMissing;
  },
};
