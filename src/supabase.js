'use strict';

require('dotenv').config();

/**
 * Shared Supabase client (Data API) — created when a URL and anon key resolve
 * for the active environment; null otherwise, and callers fall back to their
 * local backends (CSV directory, SQLite analytics).
 *
 * Two targets live side by side in .env. A single switch, SUPABASE_ENV, picks
 * which one is active — flip it between `development` and `production` and the
 * whole app follows; no other code changes:
 *
 *   SUPABASE_ENV=development|production   (default: production)
 *   SUPABASE_PROD_URL / SUPABASE_PROD_ANON_KEY
 *   SUPABASE_DEV_URL  / SUPABASE_DEV_ANON_KEY
 *
 * Legacy flat vars (SUPABASE_URL / SUPABASE_ANON_KEY) still work as a fallback
 * when the per-env vars are not set, so older configs keep running.
 *
 * Server-side, read-only usage against the bis_* tables via SQL helper
 * functions (see docs/: bis_directory, bis_physician_analytics). HTTP-based,
 * so it works the same on a laptop and on serverless hosts.
 */

const ENV = (process.env.SUPABASE_ENV || 'production').trim().toLowerCase();
const prefix = ENV === 'development' || ENV === 'dev' ? 'SUPABASE_DEV' : 'SUPABASE_PROD';

const url = process.env[`${prefix}_URL`] || process.env.SUPABASE_URL;
const anonKey = process.env[`${prefix}_ANON_KEY`] || process.env.SUPABASE_ANON_KEY;

let client = null;
if (url && anonKey) {
  const { createClient } = require('@supabase/supabase-js');
  client = createClient(url, anonKey, {
    auth: { persistSession: false }, // server-side: no session storage needed
  });
  console.log(`[supabase] client created (env=${ENV}, ${url})`);
}

module.exports = client;
