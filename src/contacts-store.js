'use strict';

const supabase = require('./supabase');

/**
 * Contact Intelligence overlay store (Lumendi brief spec, P4).
 *
 * Reads the app_contacts table — trust metadata (confidence, last verified,
 * last refresh) plus optional verified field overrides — that enriches the
 * directory's base email/phone/linkedin. Anon key; every method degrades to a
 * null/empty result when Supabase is unconfigured or the table is absent, so
 * the brief simply omits the section.
 */

function mapRow(r) {
  if (!r) return null;
  return {
    npi: String(r.npi),
    email: r.email || null,
    mobile: r.mobile || null,
    linkedinUrl: r.linkedin_url || null,
    confidenceScore: r.confidence_score ?? null,
    lastVerified: r.last_verified || null,
    lastRefresh: r.last_refresh || null,
    source: r.source || null,
  };
}

/** Contact overlay for one physician, or null. */
async function getContact(npi) {
  if (!supabase || !npi) return null;
  try {
    const { data, error } = await supabase
      .from('app_contacts')
      .select('*')
      .eq('npi', String(npi))
      .limit(1);
    if (error) return null;
    return mapRow(data?.[0]);
  } catch {
    return null;
  }
}

/** Contact overlays for many NPIs → { [npi]: contact }. */
async function getContacts(npis) {
  const out = {};
  if (!supabase || !npis?.length) return out;
  try {
    const { data, error } = await supabase
      .from('app_contacts')
      .select('*')
      .in('npi', npis.map(String));
    if (error || !data) return out;
    for (const r of data) out[String(r.npi)] = mapRow(r);
  } catch {
    /* table missing / unreachable — return what we have */
  }
  return out;
}

/** Upsert one contact overlay (used by the CSV importer). Throws on error. */
async function upsertContact(row) {
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase
    .from('app_contacts')
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'npi' });
  if (error) throw new Error(error.message);
}

module.exports = { getContact, getContacts, upsertContact, enabled: Boolean(supabase) };
