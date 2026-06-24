'use strict';

require('dotenv').config();

const auth = require('../src/auth');
const graph = require('../src/graph');
const tokenStore = require('../src/token-store');
const physiciansDir = require('../src/physicians');
const emailIntel = require('../src/email-intel');
const intelStore = require('../src/email-intel-store');
const { cleanBody } = require('../src/email-ingest');

/**
 * Email Intelligence backfill (feature/old-email-read).
 *
 * One-off seeder: for every signed-in rep, read the last N days of Inbox mail
 * (EMAIL_INTEL_DAYS, default 10 — bump to 30 later) and upsert a sheet row for
 * each physician-related email into app_email_intel. Safe to re-run — rows are
 * keyed by message id, so it updates in place.
 *
 *   SUPABASE_ENV=development node scripts/intel-backfill.js [days]
 *
 * `days` arg overrides EMAIL_INTEL_DAYS. Requires a signed-in user (tokens in
 * the token store) and Supabase configured. AI CPT/other-notes enrichment is a
 * separate pass (step 2); this seeds the identity + meeting-context columns.
 */

async function main() {
  const days = Number(process.argv[2]) || Number(process.env.EMAIL_INTEL_DAYS) || 10;

  if (!intelStore.enabled) {
    console.error('Supabase not configured (check SUPABASE_ENV + URL/anon key in .env).');
    process.exit(1);
  }
  await physiciansDir.ready;

  const users = await tokenStore.listUsers();
  if (!users.length) {
    console.error('No signed-in users — sign in via the app first, then re-run.');
    process.exit(2);
  }

  let totalSaved = 0, totalSkipped = 0, totalErr = 0, totalSeen = 0;
  for (const user of users) {
    const token = await auth.getAccessTokenForUser(user);
    if (!token) {
      console.warn(`  ${user.email || user.homeAccountId}: no valid token — skipping.`);
      continue;
    }
    const messages = await graph.getInboxMessages(token, { sinceDays: days });
    totalSeen += messages.length;
    let saved = 0, skipped = 0, err = 0;
    for (const msg of messages) {
      const cleanedBody = cleanBody(msg.bodyText || msg.bodyPreview);
      const r = await emailIntel.processMessage({ msg, user, cleanedBody });
      if (r === 'saved') saved++;
      else if (r === 'error') err++;
      else skipped++;
    }
    totalSaved += saved; totalSkipped += skipped; totalErr += err;
    console.log(`  ${user.email}: ${messages.length} mail in last ${days}d → ${saved} sheet rows, ${skipped} skipped (non-physician), ${err} errors`);
  }

  console.log(`\nBackfill done (env=${process.env.SUPABASE_ENV || 'production'}): ${totalSeen} mail scanned → ${totalSaved} rows, ${totalSkipped} skipped, ${totalErr} errors.`);
  process.exit(totalErr ? 1 : 0);
}

main().catch((err) => {
  console.error('backfill failed:', err.message);
  process.exit(1);
});
