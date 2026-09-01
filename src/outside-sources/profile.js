'use strict';

const sources = require('./index');
const score = require('./score');

/**
 * Everything the public sources can say about one NPI, assembled once.
 *
 * Order matters and is the rep's own: identity from NPPES (it is the registry
 * that owns names and addresses), then CMS by that NPI for what it alone has —
 * the CPT lines, year by year. CMS also fills gaps NPPES leaves (its provider
 * type when the registry lists no specialty, an address when the registry has
 * none), never overwrites what NPPES stated.
 *
 * CPT volumes are NOT folded into the stored record: they are a list, they
 * belong to the notes, and whether to persist them is a separate decision.
 *
 * @param {string} npi
 * @param {string} [preferredSourceId] the source the rep picked from
 * @returns {Promise<{record, extra, cms, sourceName, sourceUrl, failures}|null>}
 */
async function assembleProfile(npi, preferredSourceId) {
  const failures = [];

  const registryId = preferredSourceId && preferredSourceId !== 'cms-service' ? preferredSourceId : 'nppes';
  const registry = sources.byId(registryId);
  let identity = null;
  if (registry?.getByNpi) {
    try {
      identity = await registry.getByNpi(npi);
    } catch (err) {
      failures.push({ source: registry.id, name: registry.name, error: err.message });
    }
  }

  const cmsSource = sources.byId('cms-service');
  let cms = null;
  if (cmsSource?.getByNpi) {
    try {
      cms = await cmsSource.getByNpi(npi);
    } catch (err) {
      failures.push({ source: cmsSource.id, name: cmsSource.name, error: err.message });
    }
  }

  if (!identity && !cms) return null;

  // Do the two sources describe the SAME person? Two independent registries
  // agreeing on a name and a place is the strongest confirmation available
  // without asking the physician, and it is what lifts a candidate over the bar.
  const same = (a, b) =>
    a && b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  const agreedOn = [];
  if (identity && cms) {
    const lastOf = (n) => score.splitFullName(n).last;
    if (same(lastOf(identity.name), lastOf(cms.name))) agreedOn.push('surname');
    if (same(identity.city, cms.city)) agreedOn.push('city');
    if (same(identity.state, cms.state)) agreedOn.push('state');
  }
  const agreement = {
    // The surname has to be one of them: agreeing only on a state is two
    // strangers in the same place.
    confirmed: agreedOn.includes('surname') && agreedOn.length >= 2,
    on: agreedOn,
    // Display names, not ids: "Confirmed by NPPES NPI Registry and CMS Medicare
    // …" is a sentence a rep can act on; "nppes and cms-service" is not.
    by: [
      identity ? registry?.name || registryId : null,
      cms && (cms.years || []).length ? cmsSource?.name || 'CMS' : null,
    ].filter(Boolean),
  };

  // NPPES leads; CMS fills the blanks it left.
  const record = {
    ...(cms || {}),
    ...Object.fromEntries(Object.entries(identity || {}).filter(([, v]) => v !== null && v !== undefined)),
    npi: String(npi),
    inBis: false,
  };
  delete record.extra;
  delete record.years;
  delete record.unreachableYears;
  delete record.latestYear;
  delete record.ruralUrban;
  delete record.medicareParticipating;
  delete record.credential;

  return {
    record,
    extra: { ...(cms?.extra || {}), ...(identity?.extra || {}) },
    cms,
    agreement,
    sourceName: identity ? registry.name : cmsSource.name,
    sourceUrl: identity?.externalSourceUrl || registry?.url || cmsSource?.url || null,
    failures,
  };
}

module.exports = assembleProfile;
module.exports.assembleProfile = assembleProfile;
