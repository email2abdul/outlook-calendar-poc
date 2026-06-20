'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

/**
 * Product Context Layer — ingest (Lumendi spec, P6).
 *
 * Reads Lumendi product brochure PDFs and uses Claude (forced tool-use, so the
 * output is a validated object rather than parsed prose) to extract structured
 * product knowledge — what each product is, which procedure families it serves,
 * and the talking points / differentiation / reimbursement / value props a rep
 * needs. The result is written to config/product-context.json, which the
 * briefing reads at run time to answer "What should I discuss?" — no LLM call
 * happens per briefing; the AI work is done once, here.
 *
 * Run rarely (only when brochures change):
 *   node scripts/ingest-products.js path/to/a.pdf path/to/b.pdf ...
 *   node scripts/ingest-products.js            # defaults to ./brochures/*.pdf
 *
 * Requires ANTHROPIC_API_KEY in the environment (.env).
 */

const MODEL = 'claude-opus-4-8';
const OUT_PATH = path.join(__dirname, '..', 'config', 'product-context.json');
const DEFAULT_DIR = path.join(__dirname, '..', 'brochures');

// Forced tool-use → tool_use.input is the validated payload (no prose parsing).
// strict:true guarantees the schema; families align with src/procedure-families.js.
const RECORD_PRODUCT_TOOL = {
  name: 'record_product',
  description:
    'Record structured sales intelligence extracted from one medical-device product brochure.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      product_name: { type: 'string', description: 'The product name as printed on the brochure.' },
      summary: { type: 'string', description: 'One-sentence description of what the product is and does.' },
      applies_to_families: {
        type: 'array',
        description:
          'Procedure families this product is used in or supports. Choose only from the allowed values; omit families the brochure does not support.',
        items: { type: 'string', enum: ['Colonoscopy', 'EMR', 'ESD', 'EUS'] },
      },
      talking_points: {
        type: 'array',
        description: 'Concise, rep-ready talking points a salesperson can raise in a meeting.',
        items: { type: 'string' },
      },
      competitive_differentiation: {
        type: 'array',
        description: 'How this product differs from or improves on alternatives.',
        items: { type: 'string' },
      },
      reimbursement_notes: {
        type: 'array',
        description: 'Reimbursement, coding, or economic points stated in the brochure (empty if none).',
        items: { type: 'string' },
      },
      value_propositions: {
        type: 'array',
        description: 'Procedure-specific value propositions / clinical benefits.',
        items: { type: 'string' },
      },
    },
    required: [
      'product_name',
      'summary',
      'applies_to_families',
      'talking_points',
      'competitive_differentiation',
      'reimbursement_notes',
      'value_propositions',
    ],
  },
};

async function extractFromPdf(client, pdfPath) {
  const data = fs.readFileSync(pdfPath).toString('base64');
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    tools: [RECORD_PRODUCT_TOOL],
    tool_choice: { type: 'tool', name: 'record_product' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
          {
            type: 'text',
            text:
              'Extract structured sales intelligence from this product brochure using the ' +
              'record_product tool. Map applies_to_families to the procedures the product is ' +
              'actually used in (Colonoscopy, EMR, ESD, EUS). Keep talking points concise and ' +
              'factual — only what the brochure supports.',
          },
        ],
      },
    ],
  });

  const block = response.content.find((b) => b.type === 'tool_use');
  if (!block) throw new Error('no tool_use block in response');
  return block.input;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set (.env). Aborting.');
    process.exit(1);
  }

  let pdfs = process.argv.slice(2);
  if (!pdfs.length) {
    if (!fs.existsSync(DEFAULT_DIR)) {
      console.error(`No PDF args and ${DEFAULT_DIR} does not exist.`);
      console.error('Usage: node scripts/ingest-products.js <a.pdf> <b.pdf> ...  (or drop PDFs in ./brochures/)');
      process.exit(1);
    }
    pdfs = fs
      .readdirSync(DEFAULT_DIR)
      .filter((f) => f.toLowerCase().endsWith('.pdf'))
      .map((f) => path.join(DEFAULT_DIR, f));
  }
  if (!pdfs.length) {
    console.error('No PDFs to process.');
    process.exit(1);
  }

  const client = new Anthropic();
  const products = [];
  for (const pdf of pdfs) {
    process.stdout.write(`Extracting ${path.basename(pdf)} ... `);
    try {
      const product = await extractFromPdf(client, pdf);
      products.push({ ...product, source_file: path.basename(pdf) });
      console.log(`✓ ${product.product_name} [${(product.applies_to_families || []).join(', ') || 'no families'}]`);
    } catch (err) {
      console.log(`✗ ${err.message}`);
    }
  }

  if (!products.length) {
    console.error('No products extracted — not writing output.');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify({ generatedBy: MODEL, products }, null, 2) + '\n'
  );
  console.log(`\nWrote ${products.length} product(s) to ${path.relative(process.cwd(), OUT_PATH)}`);
}

main().catch((err) => {
  console.error('ingest failed:', err.message);
  process.exit(1);
});
