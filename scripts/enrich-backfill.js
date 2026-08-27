'use strict';

require('dotenv').config();

const physicians = require('../src/physicians');
const enrichment = require('../src/enrichment');
const cache = require('../src/enrichment/cache');

/**
 * Enrichment backfill — pre-compute the outside-BIS picture for a set of
 * physicians, so the first meeting with them is instant instead of a 40-second
 * lookup, and so the rep can see at a glance what the master is missing.
 *
 *   npm run enrich:backfill -- --missing-email --limit 20
 *   npm run enrich:backfill -- --facility HSOP105211 --write
 *   npm run enrich:backfill -- --npi 1467521757,1508935800 --write
 *
 * Flags:
 *   --missing-email      physicians in BIS with no email at all (5,179 of them)
 *   --facility <id>      every physician at one bis_facilities row
 *   --npi <a,b,c>        an explicit list
 *   --limit <n>          cap the run (default 20 — this hits public APIs)
 *   --write              store results in app_external_profiles (keyed by NPI)
 *   --web                allow the PAID identity tier (default: free tiers only)
 *
 * Defaults are deliberately conservative: free tiers only, 20 physicians, and
 * nothing written. A blanket sweep of all 5,179 email-less physicians through
 * the paid tier would cost roughly $780 — decide that deliberately, not by
 * running a script with no arguments.
 */

function parseArgs(argv) {
  const args = { limit: 20, write: false, web: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--missing-email') args.missingEmail = true;
    else if (arg === '--write') args.write = true;
    else if (arg === '--web') args.web = true;
    else if (arg === '--facility') args.facility = argv[++i];
    else if (arg === '--npi') args.npis = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--limit') args.limit = Number(argv[++i]) || 20;
  }
  return args;
}

/** Which physicians this run covers. */
function selectPhysicians(args) {
  const all = physicians.getAllPhysicians();

  if (args.npis?.length) {
    return args.npis.map((npi) => physicians.getByNpi(npi)).filter(Boolean);
  }
  if (args.facility) {
    return all.filter((p) => p.facility?.id === args.facility);
  }
  if (args.missingEmail) {
    return all.filter((p) => !p.email);
  }
  return [];
}

function money(n) {
  return `$${Number(n || 0).toLocaleString('en-US')}`;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  await physicians.ready;

  const selected = selectPhysicians(args);
  if (!selected.length) {
    console.error(
      'Nothing selected. Use --missing-email, --facility <id> or --npi <list>.\n' +
        'Example: npm run enrich:backfill -- --facility HSOP105211 --limit 5'
    );
    process.exit(1);
  }

  const batch = selected.slice(0, args.limit);
  console.log(
    `\n${selected.length} physician(s) match; enriching ${batch.length} ` +
      `(${args.web ? 'PAID web tier ON' : 'free tiers only'}, ` +
      `${args.write ? 'writing to cache' : 'dry run'})\n`
  );

  const totals = { withPayments: 0, withPublications: 0, withTrials: 0, facilityMatched: 0, failed: 0 };

  for (const [i, p] of batch.entries()) {
    const label = `${String(i + 1).padStart(3)}/${batch.length} ${p.npi} ${p.name || ''}`;
    try {
      const result = await enrichment.enrich({
        npi: p.npi,
        // An email-less physician has no address to search, so the web tier has
        // nothing to work from anyway; keep it off unless asked.
        useWeb: args.web ? 'always' : 'never',
        refresh: !args.write ? false : true,
      });

      const bits = [];
      if (result.industryPayments) {
        totals.withPayments++;
        bits.push(
          `💰 ${money(result.industryPayments.totalUsd)} from ` +
            `${result.industryPayments.topPayers.length} co.`
        );
      }
      if (result.publications) {
        totals.withPublications++;
        bits.push(`📚 ${result.publications.count} pubs`);
      }
      if (result.trials) {
        totals.withTrials++;
        bits.push(`🧪 ${result.trials.count} trials`);
      }
      if (result.matchedFacility) totals.facilityMatched++;

      console.log(`${label} — ${result.status}${bits.length ? ' · ' + bits.join(' · ') : ''}`);

      if (args.write) await cache.put({ npi: p.npi }, result);
    } catch (err) {
      totals.failed++;
      console.log(`${label} — FAILED: ${err.message}`);
    }
  }

  console.log(
    `\nDone. payments ${totals.withPayments}/${batch.length} · ` +
      `publications ${totals.withPublications}/${batch.length} · ` +
      `trials ${totals.withTrials}/${batch.length} · ` +
      `facility matched ${totals.facilityMatched}/${batch.length} · failed ${totals.failed}`
  );
  if (!args.write) console.log('Dry run — nothing stored. Re-run with --write to keep these results.');
  if (selected.length > batch.length) {
    console.log(`${selected.length - batch.length} physician(s) not covered — raise --limit to include them.`);
  }
  process.exit(0);
})();
