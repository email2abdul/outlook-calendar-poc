'use strict';

require('dotenv').config();

/**
 * AI extractor — reads one ingested email reply and pulls out the business
 * signal (the "kaam ki baat"): a short summary plus action items, decisions,
 * key points, risks/objections, opportunities, and next steps. Used by the
 * ingestion engine to turn each physician reply into an AI Meeting Note (MOM)
 * shown in the UI.
 *
 * Claude (claude-opus-4-8) with FORCED tool-use, so the output is a validated
 * object rather than parsed prose. Forced tool_choice is incompatible with
 * thinking, so we rely on the strict schema guarantee. No-op (returns null)
 * when ANTHROPIC_API_KEY is unset, so ingestion keeps working without it.
 */

const MODEL = 'claude-opus-4-8';

const EXTRACTION_TOOL = {
  name: 'record_email_intelligence',
  description:
    'Record structured sales intelligence extracted from a single email reply in a ' +
    'physician/customer meeting thread. Capture only what the message actually says.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string', description: 'One or two sentence summary of this reply.' },
      action_items: { type: 'array', items: { type: 'string' }, description: 'Concrete things the rep must do.' },
      decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions made or confirmed.' },
      key_points: { type: 'array', items: { type: 'string' }, description: 'Other important discussion points.' },
      risks_or_objections: { type: 'array', items: { type: 'string' }, description: 'Concerns, objections, blockers raised.' },
      opportunities: { type: 'array', items: { type: 'string' }, description: 'Sales opportunities / buying signals.' },
      next_steps: { type: 'array', items: { type: 'string' }, description: 'Agreed or suggested next steps.' },
    },
    required: [
      'summary', 'action_items', 'decisions', 'key_points',
      'risks_or_objections', 'opportunities', 'next_steps',
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
 * Extract intelligence from one reply. Returns the validated object, or null
 * when disabled / empty / on any error (caller treats null as "skip").
 * @param {{bodyText:string, physicianName?:string, meetingTitle?:string, fromName?:string}} opts
 */
async function extractFromReply({ bodyText, physicianName, meetingTitle, fromName } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const text = (bodyText || '').trim();
  if (!text) return null;

  const ctx = [
    physicianName ? `Physician: ${physicianName}` : null,
    meetingTitle ? `Meeting: ${meetingTitle}` : null,
    fromName ? `Reply from: ${fromName}` : null,
  ].filter(Boolean).join('\n');

  try {
    const resp = await getClient().messages.create({
      model: MODEL,
      max_tokens: 2000,
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: 'tool', name: 'record_email_intelligence' },
      messages: [
        {
          role: 'user',
          content:
            `${ctx ? ctx + '\n\n' : ''}` +
            'Extract the business intelligence from the email reply below using the ' +
            'record_email_intelligence tool. Be concise and factual — only capture what ' +
            'the message states. Leave arrays empty when a category does not apply.\n\n' +
            `--- EMAIL REPLY ---\n${text}`,
        },
      ],
    });
    const block = resp.content.find((b) => b.type === 'tool_use');
    return block ? block.input : null;
  } catch (err) {
    console.warn('[ai-extractor] extraction failed:', err.message);
    return null;
  }
}

/**
 * Render an extracted insight into the multi-line note text shown under Meeting
 * Notes (rendered with white-space:pre-wrap, so newlines + bullets display).
 * Only non-empty sections are included.
 */
function formatNote(insight, { receivedAt } = {}) {
  if (!insight) return '';
  const lines = [];

  // Day + date + time stamp at the top, so every reply note is distinguishable
  // (multiple replies to the same meeting each get their own timestamped note),
  // and the stamp shows even in the collapsed one-line preview.
  const stamp = formatStamp(receivedAt);
  const head = stamp ? `🕒 ${stamp}` : '';
  if (head && insight.summary) lines.push(`${head} — ${insight.summary}`);
  else if (head) lines.push(head);
  else if (insight.summary) lines.push(insight.summary);

  const section = (title, items) => {
    if (!items?.length) return;
    lines.push('', title);
    for (const it of items) lines.push(`• ${it}`);
  };
  section('Action items', insight.action_items);
  section('Decisions', insight.decisions);
  section('Next steps', insight.next_steps);
  section('Opportunities', insight.opportunities);
  section('Risks / objections', insight.risks_or_objections);
  section('Key points', insight.key_points);

  return lines.join('\n').trim();
}

/** "Fri, Jun 20, 2026, 9:18 AM" from an ISO timestamp, or '' if unparseable. */
function formatStamp(receivedAt) {
  if (!receivedAt) return '';
  const d = new Date(receivedAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

module.exports = {
  extractFromReply,
  formatNote,
  get enabled() {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  },
};
