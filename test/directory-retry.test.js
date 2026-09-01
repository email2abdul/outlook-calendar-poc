'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

/**
 * The directory load used to get exactly one attempt.
 *
 * `bis_directory` pulls 21k physicians and 12.8k facilities in one statement,
 * so a busy database is enough to hit Postgres's statement timeout. When that
 * happened the loader fell through to a CSV fallback whose files no longer
 * ship, and the server came up serving an EMPTY directory — every lookup,
 * brief and search silently answering "nobody" — until somebody restarted it.
 *
 * Each case runs in a child process: the loader fires once, at require time.
 */

const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');

/**
 * Boot src/physicians with a fake Supabase that fails `failTimes` times, then
 * returns one physician. Waits `waitMs` for the background retry.
 */
function boot({ failTimes, waitMs = 0, attempts = 3 }) {
  const script = `
    let calls = 0;
    const fake = { rpc: async (fn) => {
      if (fn !== 'bis_directory') return { data: [], error: null };
      calls++;
      if (calls <= ${failTimes}) {
        return { data: null, error: { message: 'canceling statement due to statement timeout' } };
      }
      return { data: {
        physicians: [{ npi: '1', physician_name: 'Barry J Pronold', primary_facility_id: 'F1' }],
        facilities: [{ facility_id: 'F1', facility_name: 'Upstate GI', state: 'NY' }],
      }, error: null };
    }};
    const f = require.resolve(${JSON.stringify(path.join(ROOT, 'src/supabase'))});
    require.cache[f] = { id: f, filename: f, loaded: true, exports: fake, children: [], paths: [] };

    process.env.DIRECTORY_LOAD_ATTEMPTS = '${attempts}';
    process.env.DIRECTORY_LOAD_BACKOFF_MS = '20';
    process.env.DIRECTORY_RELOAD_SECONDS = '1';

    const p = require(${JSON.stringify(path.join(ROOT, 'src/physicians'))});
    (async () => {
      await p.ready;
      const atBoot = { loaded: p.isLoaded(), count: p.getAllPhysicians().length, calls };
      await new Promise((r) => setTimeout(r, ${waitMs}));
      const after = { loaded: p.isLoaded(), count: p.getAllPhysicians().length, calls };
      process.stdout.write('@@' + JSON.stringify({ atBoot, after }) + '@@');
      process.exit(0);
    })();
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30000,
  });
  return JSON.parse(out.split('@@')[1]);
}

test('a transient timeout is retried on the way up', () => {
  // Two timeouts then success — the directory is ready before anything asks.
  const { atBoot } = boot({ failTimes: 2, attempts: 3 });
  assert.strictEqual(atBoot.loaded, true, 'directory should be loaded after boot retries');
  assert.strictEqual(atBoot.count, 1);
  assert.strictEqual(atBoot.calls, 3, 'one failed attempt, one more, then the success');
});

test('an empty directory heals itself without a restart', () => {
  // Every boot attempt times out — this is the reported failure, where the app
  // used to serve an empty directory indefinitely.
  const { atBoot, after } = boot({ failTimes: 3, attempts: 3, waitMs: 3000 });
  assert.strictEqual(atBoot.loaded, false, 'boot genuinely failed');
  assert.strictEqual(atBoot.count, 0);
  assert.strictEqual(after.loaded, true, 'background retry recovered it');
  assert.strictEqual(after.count, 1);
  assert.ok(after.calls > atBoot.calls, 'the background retry actually ran');
});

test('a directory that never comes back keeps trying and never crashes', () => {
  const { atBoot, after } = boot({ failTimes: 10000, attempts: 2, waitMs: 2500 });
  assert.strictEqual(atBoot.loaded, false);
  assert.strictEqual(after.loaded, false);
  assert.ok(after.calls > atBoot.calls, 'still retrying rather than giving up');
});

test('the load succeeding first time costs exactly one call', () => {
  const { atBoot } = boot({ failTimes: 0 });
  assert.strictEqual(atBoot.loaded, true);
  assert.strictEqual(atBoot.calls, 1, 'no retry when none is needed');
});
