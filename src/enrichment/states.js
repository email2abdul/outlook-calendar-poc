'use strict';

/**
 * US state code ↔ full name.
 *
 * Needed because the two sides of a re-match spell states differently:
 * `bis_facilities.state` holds the FULL name ("North Carolina") while NPPES and
 * the CMS provider datasets return the 2-letter code ("NC"). Comparing them
 * directly is the difference between finding a facility and silently missing
 * it, so every state value crossing a source boundary goes through
 * `toCode()` / `toName()` first.
 *
 * src/territory.js has its own abbreviation table, but only maps state →
 * Census region; it deliberately stays untouched here.
 */

const NAME_BY_CODE = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  PR: 'Puerto Rico', VI: 'Virgin Islands', GU: 'Guam',
};

const CODE_BY_NAME = {};
for (const [code, name] of Object.entries(NAME_BY_CODE)) {
  CODE_BY_NAME[name.toLowerCase()] = code;
}

/** "North Carolina" | "nc" | "NC" → "NC". Null when unrecognised. */
function toCode(state) {
  if (!state) return null;
  const s = String(state).trim();
  if (s.length === 2 && NAME_BY_CODE[s.toUpperCase()]) return s.toUpperCase();
  return CODE_BY_NAME[s.toLowerCase()] || null;
}

/** "NC" | "north carolina" → "North Carolina". Null when unrecognised. */
function toName(state) {
  const code = toCode(state);
  return code ? NAME_BY_CODE[code] : null;
}

/** True when two state values refer to the same state, in either spelling. */
function sameState(a, b) {
  const ca = toCode(a);
  const cb = toCode(b);
  return Boolean(ca && cb && ca === cb);
}

module.exports = { toCode, toName, sameState, NAME_BY_CODE };
