'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const tunnel = require('../src/enrichment/tunnel');
const { edgeBlocked } = require('../scripts/enrich-doctor');

/**
 * The morning this file exists for.
 *
 * `data.cms.gov` answers an Akamai **403 Access Denied** to this developer's IP
 * — the host is up, TLS completes, the dataset is fine, and this client is
 * simply not allowed in. Two things went wrong on the back of that:
 *
 *   · `enrich:doctor` printed "✅ HTTPS 403 (any status = reachable)" and then
 *     "All enrichment sources reachable" — a green report for a source the app
 *     could not read a single row from;
 *   · the fix (an `ssh -D 1080` tunnel in OUTSIDE_HTTP_PROXY) only held until
 *     the tunnel died, and then nothing brought it back.
 *
 * So: a 401/403 from these credential-free APIs is a BLOCK, and the tunnel is
 * started by the app rather than by a human remembering a command. Both are
 * pinned here.
 */

// ── The doctor's verdict on a 403 ────────────────────────────────────────────

const AKAMAI_403 = `<HTML><HEAD>
<TITLE>Access Denied</TITLE>
</HEAD><BODY>
<H1>Access Denied</H1>
You don't have permission to access "http://data.cms.gov/data-api/v1/dataset" on this server.
Reference #18.8787d817.1788418062.452faba4
</BODY></HTML>`;

test('a 403 is a block, and the Akamai page is named as a geo block', () => {
  const verdict = edgeBlocked(403, AKAMAI_403);
  assert.ok(verdict, 'a 403 must never be reported as reachable');
  assert.match(verdict.reason, /Akamai edge refused this IP \(geo block\)/);
  // The rep-facing point: this is not an outage and not an absence of data.
  assert.match(verdict.reason, /the dataset is fine/);
  assert.match(verdict.fix, /OUTSIDE_HTTP_PROXY/);
});

test('a bare 403 with no Akamai body is still a block, not an auth error', () => {
  const verdict = edgeBlocked(403, '{"message":"forbidden"}');
  assert.ok(verdict);
  assert.match(verdict.reason, /these APIs take no credential/);
});

test('the answers these APIs actually give are not blocks', () => {
  // The data-api root through the tunnel: a JSON 404 proves the edge let us in.
  assert.equal(edgeBlocked(404, '{"errors":[{"status":404}]}'), null);
  assert.equal(edgeBlocked(200, '{"result_count":1}'), null);
  // A 429/5xx is the upstream failing, which http.js already treats as an
  // outage; it is deliberately not this function's business.
  assert.equal(edgeBlocked(429, 'slow down'), null);
  assert.equal(edgeBlocked(503, 'maintenance'), null);
});

// ── Which proxies this app is allowed to start ───────────────────────────────

/**
 * Run `fn` with these env vars set (undefined = deleted), then restore.
 *
 * `await fn()`, not `return fn()`: a sync try/finally restores the environment
 * the moment an async callback returns its PROMISE, so everything after the
 * callback's first await would read the real .env instead. That is not a
 * hypothetical — it made the "no ssh target" case below pick up this machine's
 * OUTSIDE_HTTP_PROXY_SSH and genuinely spawn ssh from a unit test.
 */
async function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('no proxy configured — the deployed server has nothing to manage', async () => {
  await withEnv({ OUTSIDE_HTTP_PROXY: undefined }, () => {
    assert.equal(tunnel.local(), null);
  });
});

test('a loopback SOCKS proxy is ours to start', async () => {
  await withEnv({ OUTSIDE_HTTP_PROXY: 'socks5://127.0.0.1:1080' }, () => {
    assert.deepEqual(tunnel.local(), { host: '127.0.0.1', port: 1080, kind: 'socks5' });
  });
  await withEnv({ OUTSIDE_HTTP_PROXY: 'socks5://localhost:9999' }, () => {
    assert.deepEqual(tunnel.local(), { host: 'localhost', port: 9999, kind: 'socks5' });
  });
});

test('a proxy on someone else\'s host is left alone', async () => {
  await withEnv({ OUTSIDE_HTTP_PROXY: 'socks5://10.0.0.5:1080' }, () => {
    assert.equal(tunnel.local(), null, 'shared infrastructure is not ours to kickstart');
  });
});

test('a malformed proxy does not become a boot crash', async () => {
  await withEnv({ OUTSIDE_HTTP_PROXY: 'not a url' }, () => {
    assert.equal(tunnel.local(), null);
  });
});

// ── ensure(): the three answers, without touching the network ────────────────

test('ensure() is an instant no-op when no local proxy is configured', async () => {
  await withEnv({ OUTSIDE_HTTP_PROXY: undefined }, async () => {
    const result = await tunnel.ensure();
    assert.equal(result.state, 'off');
    assert.equal(result.line, null, 'a server with no proxy must log nothing at all');
  });
});

test('ensure() reports a port that is already answering as up', async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await withEnv({ OUTSIDE_HTTP_PROXY: `socks5://127.0.0.1:${port}` }, async () => {
      const result = await tunnel.ensure();
      assert.equal(result.state, 'up');
      assert.match(result.line, /already up/);
    });
  } finally {
    server.close();
  }
});

test('a dead port with no ssh target says what to set, and does not throw', async () => {
  // Port 1 on loopback: nothing listens, and nothing can be started without a
  // target — the honest answer is a one-line instruction.
  await withEnv(
    {
      OUTSIDE_HTTP_PROXY: 'socks5://127.0.0.1:1',
      OUTSIDE_HTTP_PROXY_SSH: undefined,
      // Keep the test off any launchd agent that may exist on the dev machine.
      OUTSIDE_TUNNEL_LAUNCHD_LABEL: 'com.bis.cms-tunnel.test-does-not-exist',
    },
    async () => {
      const result = await tunnel.ensure({ timeoutMs: 500 });
      assert.equal(result.state, 'unavailable');
      assert.match(result.detail, /OUTSIDE_HTTP_PROXY_SSH/);
      assert.match(result.line, /⚠️/);
    }
  );
});
