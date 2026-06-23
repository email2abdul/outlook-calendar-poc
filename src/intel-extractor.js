'use strict';

require('dotenv').config();

/**
 * Email Intelligence extractor (feature/old-email-read, step 2).
 *
 * Reads one inbox email and pulls out the flat-sheet fields: the physician the
 * email is ABOUT (not the sender), the facility, any CPT/procedure items, and
 * other key business/clinical points. Claude (claude-opus-4-8) with FORCED
 * tool-use so the output is a validated object. No-op (returns null) when
 * ANTHROPIC_API_KEY is unset, so the sheet still seeds its identity columns.
 *
 * Distinct from src/ai-extractor.js (that one writes the per-reply MOM note);
 * this one is tuned for the structured sheet.
 */

const MODEL = 'claude-opus-4-8';

const INTEL_TOOL = {
  name: 'record_meeting_intel',
  description:
    'Record the structured facts an email states about a physician/procedure, for a sales ' +
    'intelligence sheet. Capture ONLY what the email actually says — never invent. Leave a ' +
    'string empty ("") or an array empty when the email does not mention it.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      physician_name: {
        type: 'string',
        description:
          'The physician/doctor the email is ABOUT (the subject of discussion), e.g. "Dr. Ruma ' +
          'Rajbhandari". NOT the sender unless the sender is clearly the physician being discussed. ' +
          'Empty string if none named.',
      },
      facility_name: {
        type: 'string',
        description: 'Hospital / clinic / facility named in the email. Empty string if none.',
      },
      cpt_items: {
        type: 'array',
        description: 'CPT / procedure codes or procedures mentioned.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            code: { type: 'string', description: 'CPT code if given (e.g. "45378"), else "".' },
            description: { type: 'string', description: 'Procedure name/description, else "".' },
            note: { type: 'string', description: 'Any volume/context the email gives, else "".' },
          },
          required: ['code', 'description', 'note'],
        },
      },
      other_notes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Other key business/clinical points the email states (one per item).',
      },
      people_mentioned: {
        type: 'array',
        items: { type: 'string' },
        description: 'Other people named in the email (reps, staff, etc.).',
      },
    },
    required: ['physician_name', 'facility_name', 'cpt_items', 'other_notes', 'people_mentioned'],
  },
};

/**
 * Strip tool-call delimiter fragments that can leak into string field values
 * (e.g. "</ant" + "ml...parameter>", "<parameter name=...>") and collapse
 * whitespace. Anything from the first such fragment onward is dropped, since the
 * real value ended there. Returns '' for non-strings / empties.
 */
function cleanField(s) {
  if (typeof s !== 'string') return '';
  const cut = s.search(/<\/?\s*antml|<\s*parameter\b|<\/\s*parameter\s*>|parameter\s+name\s*=/i);
  const out = (cut === -1 ? s : s.slice(0, cut)).replace(/\s+/g, ' ').trim();
  return out;
}

/** Recursively clean every string in the extracted insight. */
function sanitize(insight) {
  if (!insight) return insight;
  return {
    physician_name: cleanField(insight.physician_name),
    facility_name: cleanField(insight.facility_name),
    cpt_items: (Array.isArray(insight.cpt_items) ? insight.cpt_items : [])
      .map((it) => ({
        code: cleanField(it?.code),
        description: cleanField(it?.description),
        note: cleanField(it?.note),
      }))
      .filter((it) => it.code || it.description || it.note),
    other_notes: (Array.isArray(insight.other_notes) ? insight.other_notes : [])
      .map(cleanField)
      .filter(Boolean),
    people_mentioned: (Array.isArray(insight.people_mentioned) ? insight.people_mentioned : [])
      .map(cleanField)
      .filter(Boolean),
  };
}

let client; // lazy singleton
function getClient() {
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic();
  }
  return client;
}

/**
 * Extract sheet facts from one email. Returns the validated object, or null when
 * disabled / empty / on any error (caller treats null as "no AI columns").
 * @param {{bodyText:string, subject?:string, fromName?:string}} opts
 */
async function extract({ bodyText, subject, fromName } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const text = (bodyText || '').trim();
  if (!text) return null;

  const ctx = [
    subject ? `Subject: ${subject}` : null,
    fromName ? `From: ${fromName}` : null,
  ].filter(Boolean).join('\n');

  try {
    const resp = await getClient().messages.create({
      model: MODEL,
      max_tokens: 2000,
      tools: [INTEL_TOOL],
      tool_choice: { type: 'tool', name: 'record_meeting_intel' },
      messages: [
        {
          role: 'user',
          content:
            `${ctx ? ctx + '\n\n' : ''}` +
            'Extract the physician / facility / CPT / key points from the email below using the ' +
            'record_meeting_intel tool. Only capture what the email states; leave fields empty ' +
            'when not mentioned.\n\n' +
            `--- EMAIL ---\n${text}`,
        },
      ],
    });
    const block = resp.content.find((b) => b.type === 'tool_use');
    return block ? sanitize(block.input) : null;
  } catch (err) {
    console.warn('[intel-extractor] extraction failed:', err.message);
    return null;
  }
}

module.exports = {
  extract,
  get enabled() {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  },
};
