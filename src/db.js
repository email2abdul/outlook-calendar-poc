'use strict';

require('dotenv').config();

/**
 * Shared Postgres (Supabase) connection pool — created only when DATABASE_URL
 * is set; null otherwise, and callers fall back to their local backends.
 *
 * Use the Supavisor *transaction pooler* string (port 6543) from the Supabase
 * dashboard's Connect dialog, so this also works on serverless hosts like
 * Vercel where every instance opens its own connections.
 */

let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5, // modest per-instance cap; Supavisor multiplexes the rest
    // Supabase requires TLS; its pooler cert chain isn't in Node's CA store.
    ssl: { rejectUnauthorized: false },
  });
  pool.on('error', (err) => console.error('[db]', err.message));
  console.log('[db] Supabase Postgres pool created');
}

module.exports = pool;
