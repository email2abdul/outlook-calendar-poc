'use strict';

require('dotenv').config();

/**
 * Shared Supabase client (Data API) — created when SUPABASE_URL and
 * SUPABASE_ANON_KEY are set; null otherwise, and callers fall back to their
 * local backends (CSV directory, SQLite analytics).
 *
 * Server-side, read-only usage against the bis_* tables via two SQL helper
 * functions (see docs/: bis_directory, bis_physician_analytics). HTTP-based,
 * so it works the same on a laptop and on serverless hosts.
 */

let client = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false }, // server-side: no session storage needed
  });
  console.log('[supabase] client created');
}

module.exports = client;
