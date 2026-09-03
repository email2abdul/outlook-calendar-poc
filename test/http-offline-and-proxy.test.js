'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * The two escape hatches in front of the network — src/enrichment/cassettes.js
 * and src/enrichment/proxy.js.
 *
 * Both exist for a measured reason: on the developer's own Wi-Fi the router's
 * resolver SERVFAILs `npiregistry.cms.hhs.gov`, and `data.cms.gov/data-api/*`
 * is killed mid-stream (HTTP/2 INTERNAL_ERROR) while `/data.json` on the same
 * edge returns 200. So the same code has to be runnable (a) through an
 * `ssh -D` tunnel and (b) with no network at all.
 *
 * What matters here, and what these tests pin:
 *   · a replayed answer is used instead of asking;
 *   · an offline run with no recording FAILS, loudly, and is recorded as an
 *     outage — never as "the registry has nobody";
 *   · only successful answers are recorded, so a network problem cannot be
 *     replayed later as a fact about a physician;
 *   · the SOCKS5 bytes are the bytes the protocol asks for.
 */

const health = require('../src/enrichment/health');
const cassettes = require('../src/enrichment/cassettes');
const proxy = require('../src/enrichment/proxy');
const { getJson } = require('../src/enrichment/http');

const ENV_KEYS = ['OUTSIDE_HTTP_CACHE_DIR', 'OUTSIDE_HTTP_RECORD', 'OUTSIDE_HTTP_OFFLINE', 'OUTSIDE_HTTP_PROXY'];
const saved = {};
const realFetch = global.fetch;
let fetches = [];

function setEnv(env) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

function fakeFetch(answer) {
  global.fetch = async (url) => {
    fetches.push(url);
    if (answer instanceof Error) throw answer;
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      async text() {
        return answer.text;
      },
    };
  };
}

test.before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

test.after(() => {
  setEnv(Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined)));
  global.fetch = realFetch;
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cassettes-'));
}

// ── Recording and replay ────────────────────────────────────────────────────

test('a successful answer is recorded, and replayed without asking again', async () => {
  const dir = tmpDir();
  fetches = [];
  setEnv({ OUTSIDE_HTTP_CACHE_DIR: dir, OUTSIDE_HTTP_RECORD: '1' });
  fakeFetch({ status: 200, text: '{"result_count":1}' });

  const first = await getJson('https://data.cms.gov/x?a=1', { label: 'cms-name-2024' });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.cached, undefined, 'the first call really went out');
  assert.strictEqual(fetches.length, 1);

  const files = fs.readdirSync(dir);
  assert.strictEqual(files.length, 1);
  assert.match(files[0], /^cms-name-2024-[0-9a-f]{12}\.json$/, 'named for its caller, so a listing reads');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.deepStrictEqual(saved.body, { result_count: 1 });
  assert.strictEqual(saved.url, 'https://data.cms.gov/x?a=1');
  assert.ok(saved.recordedAt, 'when it was recorded, so a stale cassette is visible');

  // Replay: no recording flag needed, and the network is not touched.
  setEnv({ OUTSIDE_HTTP_CACHE_DIR: dir });
  fakeFetch(new Error('the network must not be used'));
  const again = await getJson('https://data.cms.gov/x?a=1', { label: 'cms-name-2024' });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.cached, true);
  assert.deepStrictEqual(again.body, { result_count: 1 });
  assert.strictEqual(fetches.length, 1, 'still one call, from the first test');
});

test('a different URL is a different recording', async () => {
  const dir = tmpDir();
  setEnv({ OUTSIDE_HTTP_CACHE_DIR: dir, OUTSIDE_HTTP_RECORD: '1' });
  fakeFetch({ status: 200, text: '{"a":1}' });

  await getJson('https://data.cms.gov/x?name=Abernathy', { label: 'cms' });
  await getJson('https://data.cms.gov/x?name=Ajjarapu', { label: 'cms' });

  assert.strictEqual(fs.readdirSync(dir).length, 2, 'one file per query, not one per label');
});

test('a failure is never recorded — it would replay as a fact about a physician', async () => {
  const dir = tmpDir();
  setEnv({ OUTSIDE_HTTP_CACHE_DIR: dir, OUTSIDE_HTTP_RECORD: '1' });
  fakeFetch({ status: 503, text: 'gateway blew up' });

  const res = await getJson('https://data.cms.gov/down', { label: 'cms', retries: 0 });

  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'nothing written');
});

test('an offline run with no recording fails loudly, and counts as an outage', async () => {
  const dir = tmpDir();
  setEnv({ OUTSIDE_HTTP_CACHE_DIR: dir, OUTSIDE_HTTP_OFFLINE: '1' });
  fetches = [];
  fakeFetch({ status: 200, text: '{"should":"not be reached"}' });

  const { res, blind } = await health.run(async () => ({
    res: await getJson('https://npiregistry.cms.hhs.gov/api/?last_name=Nobody', { label: 'nppes' }),
    blind: health.blindFor('nppes'),
  }));

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.kind, 'offline');
  assert.strictEqual(res.body, null);
  assert.deepStrictEqual(fetches, [], 'the network was not touched');
  assert.strictEqual(blind.length, 1, 'reported as "we never asked"');
  assert.match(health.describe(blind[0], 'NPPES NPI Registry'), /was not asked/);
});

test('with no cache dir, nothing changes at all', async () => {
  setEnv({});
  fetches = [];
  fakeFetch({ status: 200, text: '{"ok":true}' });

  const res = await getJson('https://data.cms.gov/plain', { label: 'cms' });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.cached, undefined);
  assert.strictEqual(fetches.length, 1);
  assert.strictEqual(cassettes.enabled(), false);
});

// ── The proxy ───────────────────────────────────────────────────────────────

test('a proxy is off unless it is configured, and a bad value is refused', () => {
  setEnv({});
  assert.strictEqual(proxy.enabled(), false);
  assert.strictEqual(proxy.describe(), null);

  setEnv({ OUTSIDE_HTTP_PROXY: 'socks5://127.0.0.1:1080' });
  assert.strictEqual(proxy.enabled(), true);
  assert.match(proxy.describe(), /SOCKS5 proxy 127\.0\.0\.1:1080/);

  assert.deepStrictEqual(proxy.parseProxy('socks5://127.0.0.1'), {
    kind: 'socks5',
    host: '127.0.0.1',
    port: 1080,
    auth: null,
  });
  assert.strictEqual(proxy.parseProxy('http://proxy.internal:3128').kind, 'connect');
  assert.strictEqual(proxy.parseProxy('   '), null, 'blank is off, not an error');
  assert.strictEqual(proxy.parseProxy(''), null);
  assert.strictEqual(proxy.parseProxy(undefined), null);
  assert.throws(() => proxy.parseProxy('ftp://nope'), /not supported/);
  assert.throws(() => proxy.parseProxy('nonsense'), /not a URL/);

  setEnv({});
});

test('the SOCKS5 handshake is the bytes the protocol asks for', () => {
  // Version 5, one method offered, "no authentication".
  assert.deepStrictEqual([...proxy.greeting()], [0x05, 0x01, 0x00]);

  // CONNECT, address type 3 (a DOMAIN — the proxy resolves it, which is the
  // whole point when the local resolver is the broken half).
  const req = proxy.connectRequest('data.cms.gov', 443);
  assert.deepStrictEqual([...req.subarray(0, 5)], [0x05, 0x01, 0x00, 0x03, 12]);
  assert.strictEqual(req.subarray(5, 17).toString(), 'data.cms.gov');
  assert.deepStrictEqual([...req.subarray(17)], [0x01, 0xbb], '443, big-endian');
  assert.throws(() => proxy.connectRequest('x'.repeat(256), 443), /too long/);
});

test('a CONNECT reply is measured, never assumed', () => {
  const head = [0x05, 0x00, 0x00];
  assert.strictEqual(proxy.replyLength(Buffer.from([0x05, 0x00])), 0, 'incomplete → wait');
  // IPv4: 4 header + 4 address + 2 port
  assert.strictEqual(proxy.replyLength(Buffer.from([...head, 0x01, 0, 0, 0, 0, 0, 0])), 10);
  // Domain: 4 header + 1 length + n + 2 port
  assert.strictEqual(proxy.replyLength(Buffer.from([...head, 0x03, 3, 97, 98, 99, 0, 0])), 10);
  // IPv6: 4 + 16 + 2
  assert.strictEqual(proxy.replyLength(Buffer.from([...head, 0x04, ...new Array(16).fill(0), 0, 0])), 22);
  assert.strictEqual(proxy.replyLength(Buffer.from([...head, 0x09, 0, 0])), -1, 'unknown type → give up');
  assert.strictEqual(proxy.SOCKS_ERRORS[0x05], 'connection refused');
});
