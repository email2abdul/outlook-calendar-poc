'use strict';

require('dotenv').config();

const physicians = require('../src/physicians');
const enrichment = require('../src/enrichment');

/**
 * Try the enrichment agent on one person, from the terminal.
 *
 * The fastest way to verify behaviour without booking a meeting or signing in:
 *
 *   npm run enrich:try -- lisa.gangarosa@unchealth.org
 *   npm run enrich:try -- nshaheen@med.unc.edu --state NC --free
 *   npm run enrich:try -- --name "Nicholas Shaheen" --state NC
 *   npm run enrich:try -- info@unch.unc.edu --context "UNC Hospitals GI"
 *
 * Flags:
 *   --free              free tiers only (no paid web lookup)
 *   --web               force the paid web lookup
 *   --refresh           ignore the cache
 *   --state / --city    narrow the registry search
 *   --name              search by name instead of an address
 *   --context "…"       meeting title/description, as the app passes it
 *   --html              print the rendered brief HTML instead of a summary
 */

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--free') args.useWeb = 'never';
    else if (a === '--web') args.useWeb = 'always';
    else if (a === '--refresh') args.refresh = true;
    else if (a === '--html') args.html = true;
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--state') args.state = argv[++i];
    else if (a === '--city') args.city = argv[++i];
    else if (a === '--npi') args.npi = argv[++i];
    else if (a === '--context') args.meetingContext = argv[++i];
    else if (a === '--facility') args.facilityName = argv[++i];
    else if (!a.startsWith('--')) args.email = a;
  }
  return args;
}

const STATUS_HELP = {
  in_bis: 'Already in bis_physicians — the standard brief applies, nothing was enriched.',
  recovered_in_bis: 'IS in BIS by NPI; only the email was missing from the master.',
  external: 'Genuinely outside BIS — profile assembled from public sources.',
  ambiguous: 'Best match is not confident enough to assert — confirm before using.',
  facility_only: 'Person not identified, but the facility was.',
  not_physician: 'Identified as a non-physician — no brief produced.',
  unresolved: 'Nothing confident enough was found.',
};

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email && !args.name && !args.npi) {
    console.error('Usage: npm run enrich:try -- <email> [--free|--web] [--state NC] [--refresh]');
    process.exit(1);
  }

  await physicians.ready;
  const result = await enrichment.enrich(args);

  if (args.html) {
    console.log(require('../src/graph').externalBriefHtml(result));
    process.exit(0);
  }

  const line = '─'.repeat(78);
  console.log(`\n${line}`);
  console.log(`STATUS      ${result.status}   (confidence ${result.confidence}${result.cached ? ', from cache' : ''})`);
  console.log(`            ${STATUS_HELP[result.status] || ''}`);
  console.log(`NPI         ${result.npi || '—'}`);
  console.log(`TIERS       ${result.tiers.join('  →  ') || '(none)'}`);
  console.log(`TOOK        ${result.elapsedMs} ms`);
  if (result.web) {
    console.log(
      `PAID LOOKUP ${result.web.usage.searches} search(es), ` +
        `${result.web.usage.inputTokens} in / ${result.web.usage.outputTokens} out tokens`
    );
  }
  if (result.physician) console.log(`BIS MATCH   ${result.physician.name} — ${result.physician.specialty}`);
  if (result.matchedFacility) {
    console.log(`BIS FACILITY ${result.matchedFacility.name} [${result.matchedFacility.id}]`);
  }
  if (result.colleagues?.length) {
    console.log(`COLLEAGUES  ${result.colleagues.map((c) => c.name).join(', ')}`);
  }
  console.log(line);

  const show = (title, bag) => {
    const entries = Object.entries(bag || {});
    if (!entries.length) return;
    console.log(`\n${title}`);
    for (const [key, f] of entries) {
      const value = Array.isArray(f.value) ? f.value.join(' | ') : String(f.value);
      console.log(`  ${f.badge} ${key.padEnd(19)} ${value.slice(0, 60)}`);
      console.log(`     ${''.padEnd(19)} ↳ ${f.source}${f.sourceUrl ? ` — ${f.sourceUrl}` : ''}`);
    }
  };
  show('FIELDS', result.profile.fields);
  show('EXTRA (not held in BIS)', result.profile.extra);

  if (result.profile.conflicts?.length) {
    console.log('\nSOURCE DISAGREEMENTS');
    for (const c of result.profile.conflicts) {
      console.log(`  ${c.key}: kept "${c.kept.value}" (${c.kept.source}) over "${c.discarded.value}" (${c.discarded.source})`);
    }
  }
  if (result.alternatives?.length) {
    console.log('\nOTHER POSSIBLE MATCHES');
    for (const a of result.alternatives) {
      console.log(`  ${a.name || a.npi} — ${[a.specialty, a.city, a.state].filter(Boolean).join(', ')}`);
    }
  }
  if (result.profile.notes?.length) {
    console.log('\nNOTES');
    for (const n of result.profile.notes) console.log(`  • ${n}`);
  }
  console.log();
  process.exit(0);
})();
