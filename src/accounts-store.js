'use strict';

const supabase = require('./supabase');

/**
 * Lumendi account store (Lumendi brief spec, P5).
 *
 * Reads the app_accounts table — which physicians use which Lumendi product, and
 * their status — for the brief's "Existing Lumendi account status" line and the
 * per-facility "N physicians currently using a Lumendi product" count. Anon key;
 * every method degrades to null/empty when Supabase or the table is absent.
 *
 * A physician counts as an active Lumendi user when status is 'active' or
 * 'trial' (i.e. actually using a product), not 'lapsed'/'prospect'.
 */

const ACTIVE = new Set(['active', 'trial']);

function mapRow(r) {
  if (!r) return null;
  const status = r.status ? String(r.status).toLowerCase() : null;
  return {
    npi: String(r.npi),
    product: r.product || null,
    status,
    sinceDate: r.since_date || null,
    source: r.source || null,
    isActiveUser: status ? ACTIVE.has(status) : false,
  };
}

/** Lumendi account for one physician, or null. */
async function getAccount(npi) {
  if (!supabase || !npi) return null;
  try {
    const { data, error } = await supabase
      .from('app_accounts')
      .select('*')
      .eq('npi', String(npi))
      .limit(1);
    if (error) return null;
    return mapRow(data?.[0]);
  } catch {
    return null;
  }
}

/** Lumendi accounts for many NPIs → { [npi]: account }. */
async function getAccounts(npis) {
  const out = {};
  if (!supabase || !npis?.length) return out;
  try {
    const { data, error } = await supabase
      .from('app_accounts')
      .select('*')
      .in('npi', npis.map(String));
    if (error || !data) return out;
    for (const r of data) out[String(r.npi)] = mapRow(r);
  } catch {
    /* table missing / unreachable */
  }
  return out;
}

/** Upsert one account row (used by the CSV importer). Throws on error. */
async function upsertAccount(row) {
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase
    .from('app_accounts')
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'npi' });
  if (error) throw new Error(error.message);
}

module.exports = { getAccount, getAccounts, upsertAccount, enabled: Boolean(supabase) };
