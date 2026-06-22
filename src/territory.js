'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Health-system + territory identification for the pre-meeting brief.
 *
 * The master facility data has no health-system, region, or territory column
 * (only name / type / address / city / state / zip), so both are DERIVED from
 * real fields — no fabrication:
 *   - territory: state → US Census region (deterministic geography). Override
 *     with config/territories.json { "stateToTerritory": { "<State>": "<T>" } }
 *     to use real sales territories instead.
 *   - healthSystem: detect a known system brand inside the facility name
 *     (config/health-systems.json). No brand match → null (caller shows
 *     "Independent"); we never invent an affiliation.
 */

// US Census Bureau regions, keyed by lowercased full state name.
const STATE_REGION = {};
const REGIONS = {
  Northeast: ['Connecticut', 'Maine', 'Massachusetts', 'New Hampshire', 'Rhode Island', 'Vermont', 'New Jersey', 'New York', 'Pennsylvania'],
  Midwest: ['Illinois', 'Indiana', 'Michigan', 'Ohio', 'Wisconsin', 'Iowa', 'Kansas', 'Minnesota', 'Missouri', 'Nebraska', 'North Dakota', 'South Dakota'],
  South: ['Delaware', 'Florida', 'Georgia', 'Maryland', 'North Carolina', 'South Carolina', 'Virginia', 'West Virginia', 'District of Columbia', 'Alabama', 'Kentucky', 'Mississippi', 'Tennessee', 'Arkansas', 'Louisiana', 'Oklahoma', 'Texas'],
  West: ['Arizona', 'Colorado', 'Idaho', 'Montana', 'Nevada', 'New Mexico', 'Utah', 'Wyoming', 'Alaska', 'California', 'Hawaii', 'Oregon', 'Washington'],
};
for (const [region, states] of Object.entries(REGIONS)) {
  for (const s of states) STATE_REGION[s.toLowerCase()] = region;
}
// Common 2-letter abbreviations → region, so abbreviated state values still map.
const ABBR_REGION = {
  ct: 'Northeast', me: 'Northeast', ma: 'Northeast', nh: 'Northeast', ri: 'Northeast', vt: 'Northeast', nj: 'Northeast', ny: 'Northeast', pa: 'Northeast',
  il: 'Midwest', in: 'Midwest', mi: 'Midwest', oh: 'Midwest', wi: 'Midwest', ia: 'Midwest', ks: 'Midwest', mn: 'Midwest', mo: 'Midwest', ne: 'Midwest', nd: 'Midwest', sd: 'Midwest',
  de: 'South', fl: 'South', ga: 'South', md: 'South', nc: 'South', sc: 'South', va: 'South', wv: 'South', dc: 'South', al: 'South', ky: 'South', ms: 'South', tn: 'South', ar: 'South', la: 'South', ok: 'South', tx: 'South',
  az: 'West', co: 'West', id: 'West', mt: 'West', nv: 'West', nm: 'West', ut: 'West', wy: 'West', ak: 'West', ca: 'West', hi: 'West', or: 'West', wa: 'West',
};

let territoryOverride; // lazy: config/territories.json stateToTerritory
function loadTerritoryOverride() {
  if (territoryOverride !== undefined) return territoryOverride;
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'config', 'territories.json'), 'utf8');
    const map = JSON.parse(raw).stateToTerritory || {};
    territoryOverride = {};
    for (const [k, v] of Object.entries(map)) territoryOverride[k.trim().toLowerCase()] = v;
  } catch {
    territoryOverride = null; // no override file
  }
  return territoryOverride;
}

/** Territory for a state — config override if present, else the US region. Null if unknown. */
function resolveTerritory(state) {
  if (!state) return null;
  const key = String(state).trim().toLowerCase();
  const override = loadTerritoryOverride();
  if (override && override[key]) return override[key];
  return STATE_REGION[key] || ABBR_REGION[key] || null;
}

let systems; // lazy: config/health-systems.json
function loadSystems() {
  if (systems !== undefined) return systems;
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'config', 'health-systems.json'), 'utf8');
    systems = (JSON.parse(raw).systems || [])
      .map((s) => ({ name: s.name, match: (s.match || []).map((m) => m.toLowerCase()) }))
      .filter((s) => s.name && s.match.length);
  } catch {
    systems = [];
  }
  return systems;
}

/**
 * The health system a facility belongs to, by detecting a known brand in its
 * name. Returns the system name, or null when no brand matches (the caller
 * should treat null as "Independent / unaffiliated" — we do not guess).
 */
function resolveHealthSystem(facilityName) {
  if (!facilityName) return null;
  const n = String(facilityName).toLowerCase();
  for (const sys of loadSystems()) {
    if (sys.match.some((m) => n.includes(m))) return sys.name;
  }
  return null;
}

module.exports = { resolveTerritory, resolveHealthSystem };
