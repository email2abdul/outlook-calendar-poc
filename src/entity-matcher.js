'use strict';

const physicians = require('./physicians');
const ALIASES = require('../config/entity-aliases.json');

/**
 * Entity extraction + matching engine.
 *
 * Analyzes free text (meeting titles, descriptions, email subjects/bodies,
 * messages — anything) and:
 *   1. extracts entities (people, organizations/facilities, locations),
 *   2. classifies them (Doctor, Professor, Hospital, Medical College,
 *      University, Institute, Clinic, Facility, Organization, Location),
 *   3. matches them against master data (the Supabase-loaded physician +
 *      facility directory) via a chain of strategies — exact, alias /
 *      abbreviation, initials, partial (token), fuzzy (edit distance),
 *   4. scores each match 0–100 and, when nothing clears the confidence
 *      threshold, returns the top-5 closest candidates with the reason each
 *      one was suggested.
 *
 * Future-proofing — everything is data + plug points, not hard-coding:
 *   - CLASSIFICATION_RULES / FACILITY_STOPWORDS / config/entity-aliases.json
 *     are editable tables; new keywords or aliases need no code changes.
 *   - Master data comes from MASTER_SOURCES providers — register another
 *     provider to support a new entity type.
 *   - Matching is a strategy chain per entity type; push a new strategy
 *     (rule-based or AI) with `use()`. Strategies may be async, so an
 *     LLM-backed semantic matcher (e.g. Claude scoring candidate similarity)
 *     drops in without touching the pipeline. Hybrid = rule strategies first,
 *     AI strategy as a lower-priority fallback.
 */

// ── Tunables ─────────────────────────────────────────────────────────────────

const MATCH_THRESHOLD = 75; // ≥ this = confident match; below = suggestions
const SUGGESTION_FLOOR = 35; // ignore candidates scoring under this
const MAX_SUGGESTIONS = 5;

// Ordered: first keyword hit wins (so "medical college" beats "college").
const CLASSIFICATION_RULES = [
  ['medical college', 'Medical College'],
  ['medical university', 'Medical College'],
  ['college', 'College'],
  ['university', 'University'],
  ['institute', 'Institute'],
  ['hospital', 'Hospital'],
  ['clinic', 'Clinic'],
  ['health', 'Healthcare Organization'],
  ['medical center', 'Hospital'],
  ['medical centre', 'Hospital'],
  ['labs', 'Organization'],
  ['laboratories', 'Organization'],
];

const STOPWORDS = new Set(['of', 'the', 'and', 'for', 'at', 'in', 'de', 'la']);
const FACILITY_GENERIC = new Set([
  'hospital', 'medical', 'center', 'centre', 'clinic', 'health', 'healthcare',
  'regional', 'community', 'memorial', 'general', 'university', 'institute',
  'college', 'saint',
]);

// ── Small text utilities ─────────────────────────────────────────────────────

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9@.\s]/g, ' ').replace(/\s+/g, ' ').trim();
const tokensOf = (s) => norm(s).split(' ').filter(Boolean);
const isInitial = (t) => /^[a-z]\.?$/.test(t);

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** 0..1 string similarity (1 = identical). */
function similarity(a, b) {
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/** "All India Institute of Medical Sciences" → "aiims" */
function acronymOf(name) {
  return tokensOf(name).filter((w) => !STOPWORDS.has(w)).map((w) => w[0]).join('');
}

/** Expand alias tokens ("aiims delhi" → "all india institute ... delhi"). */
function expandAliases(text) {
  return tokensOf(text)
    .map((t) => (ALIASES[t] ? norm(ALIASES[t]) : t))
    .join(' ');
}

// ── 1+2. Extraction & classification ─────────────────────────────────────────

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// "Dr. Bhajit", "Professor S. K. Malan", "Doctor John Smith" — honorific then
// up to 4 capitalized words / initials.
const PERSON_RE = /\b(Dr|Doctor|Prof|Professor)\.?\s+((?:[A-Z][\w'’.-]*\s+){0,3}[A-Z][\w'’.-]*)/g;
// "at Apollo Hospital", "@ AIIMS Delhi", "in IIT Delhi" — preposition then a
// capitalized phrase (allows lowercase connector words like "of").
const PLACE_RE = /\b(?:at|@|in|with)\s+((?:[A-Z][\w'’&.-]*|of|the|and|for)(?:\s+(?:[A-Z][\w'’&.-]*|of|the|and|for)){0,7})/g;

function classifyPlace(text) {
  const t = norm(text);
  for (const [keyword, label] of CLASSIFICATION_RULES) {
    if (t.includes(keyword)) return label;
  }
  // All-caps single token reads as an abbreviation of an org (AIIMS, IIT).
  if (/^[A-Z]{2,6}(\s|$)/.test(text.trim())) return 'Organization';
  return 'Facility';
}

function extractEntities(text) {
  const raw = String(text || '');
  const seen = new Set();
  const entities = [];
  const add = (e) => {
    const key = `${e.type}:${norm(e.text)}`;
    if (e.text && !seen.has(key)) {
      seen.add(key);
      entities.push(e);
    }
  };

  for (const m of raw.match(EMAIL_RE) || []) {
    add({ text: m, type: 'person', classification: 'Email Contact' });
  }

  let m;
  PERSON_RE.lastIndex = 0;
  while ((m = PERSON_RE.exec(raw)) !== null) {
    const honorific = m[1].toLowerCase().startsWith('prof') ? 'Professor' : 'Doctor';
    // Trim connector words that the greedy capture may have swallowed.
    const name = m[2].replace(/\s+(?:At|In|On|Regarding|About|For)\b.*$/, '').trim();
    // "Dr"/"Prof" get a period; full words ("Doctor", "Professor") don't.
    const title = m[1].length <= 4 ? `${m[1].replace(/\.$/, '')}.` : m[1];
    add({ text: `${title} ${name}`, name, type: 'person', classification: honorific });
  }

  PLACE_RE.lastIndex = 0;
  while ((m = PLACE_RE.exec(raw)) !== null) {
    const phrase = m[1].trim();
    // Skip phrases that are actually the person we already captured.
    if (/^(Dr|Doctor|Prof|Professor)\b/.test(phrase)) continue;
    const classification = classifyPlace(phrase);
    add({
      text: phrase,
      type: ['Hospital', 'Medical College', 'Clinic', 'Healthcare Organization'].includes(classification)
        ? 'facility'
        : ['University', 'College', 'Institute', 'Organization'].includes(classification)
          ? 'organization'
          : 'facility',
      classification,
    });
  }

  // Gazetteer sweep against the master data — catches bare mentions that the
  // honorific/preposition patterns miss ("Demo for Adam Smith - Avera
  // McKennan Hospital", "Visit Mayo Clinic Rochester"). Relevant info can
  // appear anywhere in the text, in no predefined shape.
  const tokenSet = new Set(tokensOf(raw));

  for (const p of physicians.getAllPhysicians()) {
    if (!p.name) continue;
    const words = tokensOf(p.name).filter((w) => w.length >= 2 && !isInitial(w));
    if (words.length >= 2 && words.every((w) => tokenSet.has(w))) {
      add({
        text: words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
        type: 'person',
        classification: 'Healthcare Professional',
      });
    }
  }

  // Facility mentions must appear as a CONTIGUOUS phrase in the text (in the
  // facility's own word order) — scattered shared words ("North … Center")
  // would otherwise explode into junk entities. Shorter phrases that sit
  // inside a longer extracted phrase are suppressed ("Mayo Clinic" inside
  // "Mayo Clinic Rochester").
  const normText = ` ${tokensOf(raw).join(' ')} `;
  const facilityPhrases = new Map(); // phrase → facility name (for classification)
  for (const f of physicians.getAllFacilities()) {
    if (!f.name) continue;
    const words = tokensOf(f.name).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    const present = words.filter((w) => tokenSet.has(w));
    const distinctive = present.filter((w) => !FACILITY_GENERIC.has(w) && w.length >= 4);
    if (present.length < 2 || !distinctive.length) continue;
    const phrase = present.join(' ');
    if (normText.includes(` ${phrase} `)) facilityPhrases.set(phrase, f.name);
  }
  const maximal = [...facilityPhrases.keys()].filter(
    (p) => ![...facilityPhrases.keys()].some((other) => other !== p && other.includes(p))
  );
  for (const phrase of maximal) {
    // Classify by what the text actually says; fall back to the master name.
    const byPhrase = classifyPlace(phrase);
    add({
      text: phrase.replace(/\b\w/g, (c) => c.toUpperCase()),
      type: 'facility',
      classification: byPhrase !== 'Facility' ? byPhrase : classifyPlace(facilityPhrases.get(phrase)),
    });
  }

  // Known cities from the facility master appearing anywhere in the text —
  // longest first, so "Mason City" suppresses a nested "Mason".
  const t = ` ${norm(raw)} `;
  const cities = [...new Set(
    physicians.getAllFacilities().map((f) => f.city && norm(f.city)).filter(Boolean)
  )].sort((a, b) => b.length - a.length);
  const cityHits = [];
  for (const city of cities) {
    if (city.length >= 4 && t.includes(` ${city} `) && !cityHits.some((c) => c.includes(city))) {
      cityHits.push(city);
      add({ text: city.replace(/\b\w/g, (c) => c.toUpperCase()), type: 'location', classification: 'Location' });
    }
  }

  return entities;
}

// ── 3. Matching strategies (per entity type) ────────────────────────────────
// A strategy: { name, match(queryText, candidate) → { score, reason } | null }
// Candidates: { id, label, record } from a master source.

const personStrategies = [
  {
    name: 'exact-email',
    match(q, c) {
      const emails = q.match(EMAIL_RE);
      if (emails && c.record.email && emails.some((e) => e.toLowerCase() === c.record.email.toLowerCase())) {
        return { score: 100, reason: `email "${c.record.email}" appears in the text (exact match)` };
      }
      return null;
    },
  },
  {
    name: 'exact-name',
    match(q, c) {
      const qt = tokensOf(q).filter((t) => !['dr', 'doctor', 'prof', 'professor'].includes(t));
      const ct = tokensOf(c.label);
      if (qt.length && qt.join(' ') === ct.join(' ')) {
        return { score: 100, reason: 'full name matches exactly' };
      }
      return null;
    },
  },
  {
    name: 'initials-surname',
    match(q, c) {
      // "Dr. A. Sharma" → initial(s) + surname against "Amit Sharma".
      const qt = tokensOf(q).filter((t) => !['dr', 'doctor', 'prof', 'professor'].includes(t));
      const ct = tokensOf(c.label);
      if (qt.length < 2 || ct.length < 2) return null;
      const qSurname = qt[qt.length - 1];
      const cSurname = ct[ct.length - 1];
      if (qSurname !== cSurname || isInitial(qSurname)) return null;
      const initials = qt.slice(0, -1).filter(isInitial);
      if (!initials.length || initials.length !== qt.length - 1) return null;
      const cFirsts = ct.slice(0, -1).map((w) => w[0]);
      const allMatch = initials.every((ini) => cFirsts.includes(ini[0]));
      if (allMatch) {
        return { score: 88, reason: `surname "${qSurname}" matches and initial(s) "${initials.join(', ')}" fit "${c.label}"` };
      }
      return null;
    },
  },
  {
    name: 'partial-name',
    match(q, c) {
      // Every (non-initial) name word in the query appears in the candidate —
      // "Adam Smith" hits "Adam J Smith"; middle initials don't get in the way.
      const qt = tokensOf(q).filter((t) => !['dr', 'doctor', 'prof', 'professor'].includes(t) && !isInitial(t));
      const ct = new Set(tokensOf(c.label));
      if (qt.length >= 2 && qt.every((t) => ct.has(t))) {
        return { score: 82, reason: `all name words (${qt.join(', ')}) appear in "${c.label}"` };
      }
      if (qt.length === 1 && qt[0].length >= 4 && ct.has(qt[0])) {
        return { score: 60, reason: `name word "${qt[0]}" appears in "${c.label}" (single-word match — ambiguous)` };
      }
      return null;
    },
  },
  {
    name: 'fuzzy-name',
    match(q, c) {
      const qn = tokensOf(q).filter((t) => !['dr', 'doctor', 'prof', 'professor'].includes(t)).join(' ');
      const sim = similarity(qn, tokensOf(c.label).join(' '));
      if (sim >= 0.62) {
        return { score: Math.min(78, Math.round(sim * 100)), reason: `name is ${Math.round(sim * 100)}% similar to "${c.label}" (edit distance)` };
      }
      return null;
    },
  },
];

const placeStrategies = [
  {
    name: 'exact',
    match(q, c) {
      if (norm(q) === norm(c.label)) return { score: 100, reason: 'name matches exactly' };
      return null;
    },
  },
  {
    name: 'contains-phrase',
    match(q, c) {
      // The whole query appears contiguously inside the candidate — picks
      // "Mercyone North Iowa Medical Center Mason City Iowa" over another
      // Mercyone that merely shares words.
      const qn = tokensOf(q).join(' ');
      const cn = tokensOf(c.label).join(' ');
      if (qn.length >= 8 && qn !== cn && cn.includes(qn)) {
        return { score: 97, reason: `"${q}" appears verbatim inside "${c.label}"` };
      }
      return null;
    },
  },
  {
    name: 'alias-abbreviation',
    match(q, c) {
      // Alias table ("AIIMS" → "All India Institute of Medical Sciences") and
      // generated acronyms ("IIT Delhi" → "Indian Institute of Technology Delhi").
      const expanded = expandAliases(q);
      const cNorm = tokensOf(c.label).join(' ');
      if (expanded !== norm(q) && cNorm.includes(expanded)) {
        return { score: 95, reason: `"${q}" expands via alias table to "${expanded}" which matches "${c.label}"` };
      }
      const qTokens = tokensOf(q).filter((t) => !STOPWORDS.has(t));
      const abbrev = qTokens.find((t) => t.length >= 2 && t.length <= 6 && acronymOf(c.label).startsWith(t));
      if (abbrev && acronymOf(c.label) === abbrev) {
        const rest = qTokens.filter((t) => t !== abbrev);
        const cSet = new Set(tokensOf(c.label));
        if (rest.every((t) => cSet.has(t))) {
          return { score: 92, reason: `"${abbrev}" is the acronym of "${c.label}"${rest.length ? ` and "${rest.join(' ')}" appears in it` : ''}` };
        }
      }
      return null;
    },
  },
  {
    name: 'partial-tokens',
    match(q, c) {
      const qt = [...new Set(tokensOf(expandAliases(q)).filter((t) => !STOPWORDS.has(t)))];
      const ct = new Set(tokensOf(c.label));
      if (!qt.length) return null;
      const present = qt.filter((t) => ct.has(t));
      // A "distinctive" hit must be a real word (≥4 chars) that isn't generic
      // facility vocabulary — keeps "all"/"medical" overlaps from suggesting
      // unrelated hospitals.
      const distinctive = present.filter((t) => !FACILITY_GENERIC.has(t) && t.length >= 4);
      if (present.length === qt.length && distinctive.length) {
        return { score: 85, reason: `every word of "${q}" appears in "${c.label}"` };
      }
      if (present.length >= 2 && distinctive.length) {
        const score = Math.round(40 + 40 * (present.length / qt.length));
        return { score, reason: `${present.length}/${qt.length} words of "${q}" appear in "${c.label}" (${present.join(', ')})` };
      }
      return null;
    },
  },
  {
    name: 'fuzzy',
    match(q, c) {
      const sim = similarity(tokensOf(expandAliases(q)).join(' '), tokensOf(c.label).join(' '));
      if (sim >= 0.6) {
        return { score: Math.min(78, Math.round(sim * 100)), reason: `${Math.round(sim * 100)}% similar to "${c.label}" (edit distance)` };
      }
      return null;
    },
  },
];

const locationStrategies = [
  {
    name: 'exact-city',
    match(q, c) {
      if (norm(q) === norm(c.label)) return { score: 100, reason: 'city matches exactly' };
      return null;
    },
  },
  {
    name: 'fuzzy-city',
    match(q, c) {
      const sim = similarity(norm(q), norm(c.label));
      if (sim >= 0.8) return { score: Math.round(sim * 90), reason: `${Math.round(sim * 100)}% similar to "${c.label}"` };
      return null;
    },
  },
];

// ── Master data providers — register more to support new entity types ───────

const MASTER_SOURCES = {
  person: {
    label: 'physician directory',
    candidates: () =>
      physicians.getAllPhysicians().map((p) => ({ id: p.npi, label: p.name || p.npi, record: p })),
    strategies: personStrategies,
  },
  facility: {
    label: 'facility directory',
    candidates: () =>
      physicians.getAllFacilities().map((f) => ({ id: f.id, label: f.name || f.id, record: f })),
    strategies: placeStrategies,
  },
  organization: {
    label: 'facility directory', // orgs match against the same master for now
    candidates: () =>
      physicians.getAllFacilities().map((f) => ({ id: f.id, label: f.name || f.id, record: f })),
    strategies: placeStrategies,
  },
  location: {
    label: 'facility cities',
    candidates: () => {
      const cities = new Map();
      for (const f of physicians.getAllFacilities()) {
        if (f.city) cities.set(norm(f.city), { id: norm(f.city), label: f.city, record: { city: f.city, state: f.state } });
      }
      return [...cities.values()];
    },
    strategies: locationStrategies,
  },
};

/**
 * Plug-in point: add a strategy (rule-based or AI) for one or more entity
 * types. AI example:
 *   use(['person'], { name: 'ai-semantic', async match(q, c) {
 *     const score = await llmScore(q, c.label); // e.g. Claude API
 *     return score >= 60 ? { score, reason: 'semantic similarity (LLM)' } : null;
 *   }});
 * Strategies may be async — the pipeline awaits each one.
 */
function use(types, strategy) {
  for (const t of types) MASTER_SOURCES[t]?.strategies.push(strategy);
}

// ── 4+5. Scoring + suggestions ───────────────────────────────────────────────

async function matchEntity(entity) {
  const source = MASTER_SOURCES[entity.type];
  if (!source) return { best: null, candidates: [] };

  const queryText = entity.name || entity.text;
  const scored = [];
  for (const candidate of source.candidates()) {
    let best = null;
    for (const strategy of source.strategies) {
      const r = await strategy.match(queryText, candidate);
      if (r && (!best || r.score > best.score)) {
        best = { ...r, strategy: strategy.name };
      }
    }
    if (best && best.score >= SUGGESTION_FLOOR) {
      scored.push({ candidate, ...best });
    }
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(Boolean(b.candidate.record.email)) - Number(Boolean(a.candidate.record.email)) ||
      String(a.candidate.label).localeCompare(String(b.candidate.label))
  );

  const top = scored.slice(0, MAX_SUGGESTIONS);
  const best = top[0] && top[0].score >= MATCH_THRESHOLD ? top[0] : null;
  return { best, candidates: top };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyze any text (meeting title, description, email subject/body, message)
 * and return extraction + classification + matching in one report.
 */
async function analyze(text) {
  await physicians.ready;
  const extracted = extractEntities(text);

  const matched_entities = [];
  const confidence_scores = [];
  const suggestions = [];
  const reasoningLines = [];

  for (const entity of extracted) {
    const { best, candidates } = await matchEntity(entity);

    if (best) {
      matched_entities.push({
        entity: entity.text,
        entity_type: entity.type,
        classification: entity.classification,
        matched_entity: best.candidate.label,
        master_id: best.candidate.id,
        match_type: best.strategy,
        confidence: best.score,
      });
      confidence_scores.push({ entity: entity.text, matched_entity: best.candidate.label, confidence: best.score });
      reasoningLines.push(`"${entity.text}" → "${best.candidate.label}" (${best.score}%): ${best.reason}.`);
    } else if (candidates.length) {
      suggestions.push({
        entity: entity.text,
        entity_type: entity.type,
        classification: entity.classification,
        suggestions: candidates.map((c) => ({
          candidate: c.candidate.label,
          master_id: c.candidate.id,
          confidence: c.score,
          reason: c.reason,
        })),
      });
      reasoningLines.push(
        `"${entity.text}" had no match ≥${MATCH_THRESHOLD}% — suggesting ${candidates.length} closest candidate(s), best "${candidates[0].candidate.label}" at ${candidates[0].score}%.`
      );
    } else {
      reasoningLines.push(`"${entity.text}" (${entity.classification}) — nothing close in the ${MASTER_SOURCES[entity.type]?.label || 'master data'}.`);
    }
  }

  return {
    extracted_entities: extracted.map((e) => ({ text: e.text, type: e.type, classification: e.classification })),
    matched_entities,
    confidence_scores,
    suggestions,
    reasoning: reasoningLines.join(' '),
  };
}

/**
 * Physician profiles referenced by an analysis — confident person matches
 * first, then person suggestions, then physicians working at matched
 * facilities. Used by the calendar to render "who is this meeting with?"
 * option chips.
 */
function physicianProfilesFrom(analysis, { exclude = new Set(), limit = 5 } = {}) {
  const out = [];
  const taken = new Set(exclude);
  const push = (profileOrNpi) => {
    const p =
      typeof profileOrNpi === 'object' && profileOrNpi !== null
        ? profileOrNpi
        : physicians.getByNpi(profileOrNpi);
    if (p && !taken.has(p.npi) && out.length < limit) {
      taken.add(p.npi);
      out.push(p);
    }
  };

  for (const m of analysis.matched_entities) {
    if (m.entity_type === 'person') push(m.master_id);
  }
  for (const s of analysis.suggestions) {
    if (s.entity_type === 'person') s.suggestions.forEach((c) => push(c.master_id));
  }
  for (const m of analysis.matched_entities) {
    if (m.entity_type === 'facility' || m.entity_type === 'organization') {
      const linked = physicians.getByFacility(m.master_id, limit);
      if (linked.length) {
        linked.forEach(push);
      } else {
        // Orphan facility (exists in master, nothing linked to it — e.g. the
        // ~2.3k ASC records): offer same-city physicians, tagged with a
        // matchHint so the UI can say why they're being suggested.
        const fac = physicians.getFacilityById(m.master_id);
        physicians.getNearbyForFacility(fac, limit).forEach(push);
      }
    }
  }
  return out;
}

module.exports = { analyze, physicianProfilesFrom, extractEntities, use };
