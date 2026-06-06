'use strict';

require('dotenv').config();

/**
 * Shared Redis connection — used by the session store and the meeting-notes
 * store when the app runs on a serverless host (Vercel), where a local
 * SQLite file doesn't survive between invocations.
 *
 * Enabled by setting REDIS_URL (or KV_URL, as provisioned by the Upstash
 * integration on the Vercel marketplace). When neither is set this exports
 * null and the SQLite-backed stores are used instead — local dev needs no
 * Redis and is unchanged.
 */

const url = process.env.REDIS_URL || process.env.KV_URL || null;

let client = null;
if (url) {
  const { createClient } = require('redis');
  client = createClient({ url });
  client.on('error', (err) => console.error('[redis]', err.message));
  // Connect eagerly; commands issued while connecting are queued by node-redis.
  client.connect().then(
    () => console.log('[redis] connected — sessions and notes use Redis'),
    (err) => console.error('[redis] initial connect failed:', err.message)
  );
}

module.exports = client;
