'use strict';

require('dotenv').config();

/**
 * T1 — web identity resolution. The only paid tier in the cascade.
 *
 * Registries can turn a NAME into an NPI; nothing free can turn an opaque email
 * address into a name. That is this module's single job: given
 * `nshaheen@med.unc.edu`, come back with "Nicholas James Shaheen, MD, MPH,
 * Gastroenterology, UNC, Chapel Hill NC" **and the pages that prove it**.
 *
 * Two calls, deliberately:
 *
 *   1. web_search with `tool_choice: auto` — the model must be free to search,
 *      so the call cannot force a tool. Its per-sentence citations are the
 *      proof URLs the brief renders.
 *   2. forced tool-use over call 1's text + citations — the repo's standard
 *      strict-JSON pattern (see ai-extractor.js / intel-extractor.js).
 *
 * No-ops (returns null) when ANTHROPIC_API_KEY is unset, like every other AI
 * module here, so P1's free tiers keep working on their own.
 *
 * Verified live 2026-08-18: email alone → correct identity at 98 % confidence,
 * citing med.unc.edu and an FDA filing that both print the address verbatim.
 * ~20.6k in / 1.6k out tokens + 2 searches ≈ $0.15.
 */

const MODEL = 'claude-opus-4-8'; // same model the rest of the app's AI uses

/**
 * Deliberately the BASIC search tool, not the newer `web_search_20260209`.
 *
 * Measured head-to-head on this model, 2026-08-18, same prompt:
 *   web_search_20250305 → 14 s, 1 search, **7 citations (4 unique proof URLs)**
 *   web_search_20260209 → 200 s+ (and once a 396 s timeout), **zero citations**
 *
 * The newer variant filters results through code execution, which appears to
 * cost the per-sentence citations — and citations are not a nice-to-have here,
 * they ARE the feature: a web-sourced field with no link to prove it is exactly
 * what this design refuses to render.
 */
const SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };

const IDENTITY_TOOL = {
  name: 'record_identity',
  description:
    'Record who an email address belongs to, based ONLY on the search findings provided. ' +
    'Never guess: if the findings do not establish a fact, leave that field empty and lower ' +
    'the confidence. It is far better to return an empty result than a plausible wrong person.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      is_physician: {
        type: 'boolean',
        description:
          'True only if this person is a physician / clinician (MD, DO, surgeon, etc.). ' +
          'False for administrators, sales reps, researchers, students and unknowns.',
      },
      full_name: { type: 'string', description: 'Full name as published, else "".' },
      first_name: { type: 'string', description: 'Given name, else "".' },
      last_name: { type: 'string', description: 'Family name, else "".' },
      credentials: { type: 'string', description: 'e.g. "MD, MPH". Empty if unknown.' },
      specialty: { type: 'string', description: 'Clinical specialty / sub-specialty, else "".' },
      title: { type: 'string', description: 'Job title or academic position, else "".' },
      institution: { type: 'string', description: 'Hospital / university / practice, else "".' },
      city: { type: 'string', description: 'Practice city, else "".' },
      state: { type: 'string', description: 'US state — 2-letter code preferred. Else "".' },
      confidence: {
        type: 'integer',
        description:
          '0-100. 90+ only when a page shows this exact email address next to the name. ' +
          '50-89 when the identity is strongly implied. Below 50 when it is a guess.',
      },
      evidence_urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'URLs from the findings that support this identity. Empty if none.',
      },
      reasoning: { type: 'string', description: 'One sentence on how the identity was established.' },
    },
    required: [
      'is_physician', 'full_name', 'first_name', 'last_name', 'credentials',
      'specialty', 'title', 'institution', 'city', 'state', 'confidence',
      'evidence_urls', 'reasoning',
    ],
  },
};

let client; // lazy singleton
function getClient() {
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic();
  }
  return client;
}

/**
 * Strip tool-call delimiter fragments that can leak into string values — the
 * gotcha documented in CLAUDE.md and handled the same way in intel-extractor.js.
 */
function cleanField(s) {
  if (typeof s !== 'string') return '';
  const cut = s.search(/<\/?\s*antml|<\s*parameter\b|<\/\s*parameter\s*>|parameter\s+name\s*=/i);
  return (cut === -1 ? s : s.slice(0, cut)).replace(/\s+/g, ' ').trim();
}

function sanitize(id) {
  if (!id) return null;
  return {
    is_physician: Boolean(id.is_physician),
    full_name: cleanField(id.full_name),
    first_name: cleanField(id.first_name),
    last_name: cleanField(id.last_name),
    credentials: cleanField(id.credentials),
    specialty: cleanField(id.specialty),
    title: cleanField(id.title),
    institution: cleanField(id.institution),
    city: cleanField(id.city),
    state: cleanField(id.state),
    confidence: Number.isFinite(id.confidence) ? Math.max(0, Math.min(100, id.confidence)) : 0,
    evidence_urls: (Array.isArray(id.evidence_urls) ? id.evidence_urls : [])
      .map(cleanField)
      .filter((u) => /^https?:\/\//i.test(u)),
    reasoning: cleanField(id.reasoning),
  };
}

/** Pull the citation URLs (with titles) out of a response's content blocks. */
function collectCitations(content) {
  const byUrl = new Map();
  for (const block of content || []) {
    for (const c of block.citations || []) {
      if (c.url && !byUrl.has(c.url)) byUrl.set(c.url, { url: c.url, title: c.title || null });
    }
  }
  return [...byUrl.values()];
}

/**
 * Resolve who an email address belongs to.
 *
 * @param {object} opts
 * @param {string} opts.email            the address to identify (required)
 * @param {string} [opts.facilityHint]   facility from the meeting title/description
 * @param {string} [opts.cityHint]
 * @param {string} [opts.stateHint]
 * @param {string} [opts.meetingContext] meeting title / description, for disambiguation
 * @returns {Promise<{identity:object, citations:Array, queries:string[], usage:object}|null>}
 */
async function identify(opts = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const email = String(opts.email || '').trim();
  if (!email.includes('@')) return null;

  const context = [
    opts.facilityHint ? `The meeting mentions this facility/organisation: ${opts.facilityHint}` : null,
    opts.cityHint || opts.stateHint
      ? `Likely location: ${[opts.cityHint, opts.stateHint].filter(Boolean).join(', ')}`
      : null,
    opts.meetingContext ? `Meeting context: ${opts.meetingContext}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    // ── Call 1: search the web (tool_choice must stay auto) ──────────────────
    const search = await getClient().messages.create({
      model: MODEL,
      max_tokens: 1500,
      tools: [SEARCH_TOOL],
      messages: [
        {
          role: 'user',
          content:
            `I have a meeting with the person at this email address: ${email}\n` +
            `${context ? context + '\n' : ''}\n` +
            'Search the web and identify them: full name, credentials, clinical specialty, ' +
            'job title, and institution with city and state. Say explicitly whether they are ' +
            'a practising physician/clinician or not.\n\n' +
            'The email address itself is the strongest evidence — a page that prints it next ' +
            'to a name is near-proof. Prefer the institution\'s own directory or faculty pages. ' +
            'If you cannot establish who this is, say so plainly rather than guessing.',
        },
      ],
    });

    const findings = (search.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    const citations = collectCitations(search.content);
    const queries = (search.content || [])
      .filter((b) => b.type === 'server_tool_use')
      .map((b) => b.input?.query)
      .filter(Boolean);

    if (!findings) return null;

    // ── Call 2: structure it (forced tool use, no search) ────────────────────
    const structured = await getClient().messages.create({
      model: MODEL,
      max_tokens: 1200,
      tools: [IDENTITY_TOOL],
      tool_choice: { type: 'tool', name: 'record_identity' },
      messages: [
        {
          role: 'user',
          content:
            `Email address: ${email}\n\n` +
            `--- SEARCH FINDINGS ---\n${findings}\n\n` +
            `--- SOURCE URLS ---\n${citations.map((c) => c.url).join('\n') || '(none)'}\n\n` +
            'Record the identity using the record_identity tool. Use only the findings above. ' +
            'Use a 2-letter US state code. If the findings do not identify one specific person, ' +
            'set confidence below 50 and leave the name fields empty.',
        },
      ],
    });

    const block = (structured.content || []).find((b) => b.type === 'tool_use');
    const identity = block ? sanitize(block.input) : null;
    if (!identity) return null;

    // Any URL the model cites must have come from the search, so union the two
    // and let the caller render whichever it needs.
    const citationUrls = new Set(citations.map((c) => c.url));
    for (const u of identity.evidence_urls) {
      if (!citationUrls.has(u)) citations.push({ url: u, title: null });
    }

    return {
      identity,
      citations,
      queries,
      usage: {
        searches: search.usage?.server_tool_use?.web_search_requests || 0,
        inputTokens: (search.usage?.input_tokens || 0) + (structured.usage?.input_tokens || 0),
        outputTokens: (search.usage?.output_tokens || 0) + (structured.usage?.output_tokens || 0),
      },
    };
  } catch (err) {
    console.warn('[enrichment:web-identity] failed:', err.message);
    return null;
  }
}

module.exports = {
  identify,
  SOURCE_NAME: 'Web (AI-researched)',
  get enabled() {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  },
};
