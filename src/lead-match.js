'use strict';

const physicians = require('./physicians');

/**
 * Match a Dynamics 365 Lead to the BIS master data (Supabase), in the priority
 * the rep asked for:
 *   1. email    — exact physician by email address
 *   2. name     — physician whose full name matches first + last
 *   3. facility — physicians at the lead's company/facility
 *
 * Returns the FIRST tier that hits:
 *   { matchedBy:'email'|'name', physician }               // → render the brief
 *   { matchedBy:'facility', facility, candidates:[...] }   // → facility + people
 *   { matchedBy:null }                                     // → no BIS match
 *
 * `physician` here is a search/lookup record; the route re-resolves the full
 * profile by NPI before rendering the brief.
 */

/** A physician-name hit is "strong" only when the lead's last name (and first,
 *  if present) actually appears in it — keeps generic search hits from matching. */
function nameIsStrong(physicianName, firstName, lastName) {
  const pn = String(physicianName || '').toLowerCase();
  const ln = String(lastName || '').trim().toLowerCase();
  const fn = String(firstName || '').trim().toLowerCase();
  if (ln.length < 2 || !pn.includes(ln)) return false;
  // If we have a first name, require it too (avoids matching a same-surname
  // physician). One-letter first names are too weak to trust.
  if (fn.length >= 2) return pn.includes(fn);
  return true;
}

async function matchLeadToBis(lead = {}) {
  const email = String(lead.email || '').trim();
  const firstName = String(lead.firstName || '').trim();
  const lastName = String(lead.lastName || '').trim();
  const company = String(lead.company || '').trim();

  // 1) Email — exact.
  if (email) {
    const p = physicians.getByEmail(email);
    if (p) return { matchedBy: 'email', physician: p };
  }

  // 2) Name — search, keep only a confident name hit.
  const fullName = `${firstName} ${lastName}`.trim();
  if (fullName) {
    const hits = await physicians.search(fullName, 5);
    const strong = (hits || []).find((h) => nameIsStrong(h.name, firstName, lastName));
    if (strong) return { matchedBy: 'name', physician: strong, candidates: hits };
  }

  // 3) Facility — physicians at the lead's company/facility.
  if (company) {
    const hits = await physicians.search(company, 10);
    if (hits && hits.length) {
      return { matchedBy: 'facility', facility: hits[0].facility || null, candidates: hits };
    }
  }

  return { matchedBy: null };
}

module.exports = { matchLeadToBis };
