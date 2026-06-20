'use strict';

require('dotenv').config();
const physicians = require('../src/physicians');
const notes = require('../src/notes');
const ai = require('../src/ai-extractor');

/**
 * Test helper for the reply→AI-MOM feature WITHOUT needing a real inbound email.
 * Runs the real AI extractor on a sample (or given) reply and saves the result
 * as an AI Meeting Note for a chosen physician + the logged-in rep's email, so
 * you can open that physician in the UI and see the "🤖 AI from reply" note.
 *
 *   node scripts/test-reply-mom.js <npi> <organizerEmail> ["reply text"]
 *   e.g. node scripts/test-reply-mom.js 1114144375 wajid.jmi@gmail.com
 *
 * Note: organizerEmail must match the account you're signed into the web app
 * with (notes are per physician + per rep).
 */

const SAMPLE =
  "Hi, thanks for meeting today. We're keen to trial DiLumen EZ for our EMR " +
  'cases. Please send the protocol document and pricing by Friday. We will need ' +
  'budget approval from the department chief before we proceed. Can we also set ' +
  'up a follow-up call next week? Best, Dr. ' ;

async function main() {
  const npi = process.argv[2];
  const email = process.argv[3];
  const reply = process.argv[4] || SAMPLE;
  if (!npi || !email) {
    console.error('Usage: node scripts/test-reply-mom.js <npi> <organizerEmail> ["reply text"]');
    process.exit(1);
  }
  if (!ai.enabled) {
    console.error('ANTHROPIC_API_KEY not set in .env — cannot run the extractor.');
    process.exit(1);
  }
  await physicians.ready;
  const p = physicians.getByNpi(npi);
  if (!p) {
    console.error(`No physician with NPI ${npi} in the current directory (SUPABASE_ENV=${process.env.SUPABASE_ENV || 'production'}).`);
    process.exit(1);
  }

  console.log(`Extracting MOM for ${p.name} (${npi}) → Meeting Notes of ${email} ...`);
  const insight = await ai.extractFromReply({
    bodyText: reply,
    physicianName: p.name,
    meetingTitle: 'Test meeting (simulated reply)',
    fromName: p.name,
  });
  if (!insight) {
    console.error('Extractor returned null.');
    process.exit(1);
  }
  const note = ai.formatNote(insight, { receivedAt: new Date().toISOString() });
  await notes.addNote({
    npi,
    organizerEmail: email,
    notes: note,
    source: 'ai',
    meetingDate: new Date().toISOString().slice(0, 10),
  });

  console.log('\n--- Saved AI Meeting Note ---\n' + note);
  const search = (p.name || '').split(' ').pop();
  console.log(`\n✓ Done. Web app me sign in (${email}) → physician "${p.name}" search karo ("${search}") → Meeting Notes me "🤖 AI from reply" note dikhega.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
