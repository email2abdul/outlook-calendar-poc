'use strict';

const nppes = require('./sources/nppes');
const states = require('./states');

/**
 * Freshness check for a physician the app already holds in BIS.
 *
 * The brief used to present `bis_physicians` as fact. It is not: the master is
 * purchased/scraped data, and a physician who has changed practice keeps their
 * OLD facility, OLD phone and — the damaging one — an OLD email on the previous
 * employer's domain. Verified 2026-08-31: Tesu Lin (NPI 1508893496) is
 * "Island View Gastroenterology Associates, Ventura California" with
 * `tlin@islandviewgastro.com` in BIS, while NPPES (last updated 2021-06-10)
 * has him at 98-211 Pali Momi St, Aiea, **HI**. A 30-physician sample put the
 * disagreement rate at ~10 %.
 *
 * NPPES is the right referee: it is free, authoritative for practice location,
 * and every physician in BIS carries the NPI that keys it. What it can never
 * give is an email — the registry has no such field (`endpoints: []` for a
 * plain provider) — so this module never "corrects" an address, it only says
 * how much the one on file can be trusted.
 *
 * Everything degrades to null: no NPI, no network, DNS down (a real failure
 * mode here — see docs/enrichment-testing.md) → the brief renders exactly as
 * it did before, minus the check.
 */

const TTL_MS = 12 * 60 * 60 * 1000; // registry rows change monthly at most
// A miss is usually the network (or the DNS failure documented in
// docs/enrichment-testing.md), not a missing provider — so it expires fast
// rather than blanking the check on every brief for the next twelve hours.
const MISS_TTL_MS = 10 * 60 * 1000;
const registryCache = new Map(); // npi → { at, record }

/** NPPES row for an NPI, memoised. null when unavailable — never throws. */
async function registryRecord(npi) {
  const key = String(npi || '');
  if (!key) return null;

  const hit = registryCache.get(key);
  if (hit && Date.now() - hit.at < (hit.record ? TTL_MS : MISS_TTL_MS)) return hit.record;

  let record = null;
  try {
    record = await nppes.getByNpi(key);
  } catch (err) {
    console.warn(`[verify] NPPES lookup failed for ${key}: ${err.message}`);
    return null; // NOT cached — a network blip must not poison 12 hours
  }
  registryCache.set(key, { at: Date.now(), record });
  return record;
}

/**
 * Compare one BIS physician against the NPPES registry.
 *
 * @param {object} physician normalized profile from src/physicians.js
 * @returns {Promise<object|null>} null when there is nothing to compare against
 */
async function verifyPhysician(physician) {
  if (!physician?.npi) return null;

  const record = await registryRecord(physician.npi);
  if (!record || record.npi !== String(physician.npi)) return null;

  const facility = physician.facility || null;
  const bisState = states.toCode(facility?.state);
  const bisCity = (facility?.city || '').trim().toLowerCase();
  const regCity = (record.city || '').trim().toLowerCase();

  const stateMismatch = Boolean(bisState && record.state && bisState !== record.state);
  // Only worth reporting when the state agrees — a different state already
  // says everything a different city would.
  const cityMismatch = Boolean(!stateMismatch && bisCity && regCity && bisCity !== regCity);

  const reasons = [];
  if (stateMismatch) {
    reasons.push(
      `BIS places this physician in ${facility?.state || bisState}, ` +
        `the NPPES registry in ${states.toName(record.state) || record.state}`
    );
  }
  if (cityMismatch) {
    reasons.push(`BIS says ${facility.city}, the NPPES registry says ${record.city}`);
  }

  return {
    npi: String(physician.npi),
    checkedAt: new Date().toISOString(),
    stale: stateMismatch || cityMismatch,
    stateMismatch,
    cityMismatch,
    reasons,
    registry: {
      name: record.name,
      address: record.address,
      city: record.city,
      state: record.state,
      phone: record.phone,
      specialty: record.specialty,
      lastUpdated: record.lastUpdated,
      sourceUrl: record.sourceUrl,
    },
    bis: {
      facility: facility?.name || null,
      city: facility?.city || null,
      state: facility?.state || null,
    },
  };
}

/** verifyPhysician for several physicians at once → { [npi]: verification }. */
async function verifyMany(list) {
  const out = {};
  const results = await Promise.all((list || []).filter(Boolean).map((p) => verifyPhysician(p)));
  results.forEach((v) => {
    if (v) out[v.npi] = v;
  });
  return out;
}

/**
 * How far the email on the brief can be trusted.
 *
 * Order of preference — a rep-confirmed address always wins:
 *   1. `app_contacts.email` (someone verified it; /api/enrich/promote writes here)
 *   2. `bis_physicians.email` — unverified by definition, and *suspect* when the
 *      registry says the physician has moved, because the address almost always
 *      lives on the old employer's domain.
 *
 * @param {object} physician
 * @param {object|null} contact      app_contacts overlay (contacts-store)
 * @param {object|null} verification verifyPhysician() output
 * @returns {{address:string,status:'verified'|'unverified'|'suspect',note:string,
 *            masterEmail:string|null}|null}
 */
function emailTrust(physician, contact, verification) {
  const verified = contact?.email || null;
  const master = physician?.email || null;

  if (verified) {
    const bits = [];
    if (contact.lastVerified) bits.push(`verified ${contact.lastVerified}`);
    if (contact.confidenceScore != null) bits.push(`confidence ${contact.confidenceScore}%`);
    if (contact.source) bits.push(contact.source);
    return {
      address: verified,
      status: 'verified',
      note: bits.join(' · ') || 'confirmed in app_contacts',
      masterEmail: master && master.toLowerCase() !== verified.toLowerCase() ? master : null,
    };
  }

  if (!master) return null;

  if (verification?.stale) {
    return {
      address: master,
      status: 'suspect',
      note:
        'from the BIS master, and the registry places this physician elsewhere — ' +
        'this address may belong to a practice they have left',
      masterEmail: null,
    };
  }

  return {
    address: master,
    status: 'unverified',
    note: 'from the BIS master, never confirmed with the physician',
    masterEmail: null,
  };
}

module.exports = { verifyPhysician, verifyMany, emailTrust, registryRecord };
