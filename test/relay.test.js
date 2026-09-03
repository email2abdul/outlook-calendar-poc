'use strict';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

/**
 * The relay — src/enrichment/relay.js (client) and src/routes/relay.routes.js
 * (server).
 *
 * It exists so that a developer on a network that blocks data.cms.gov needs
 * nothing but two lines of .env — no ssh key, no alias, no launchd agent. What
 * these tests pin is everything that would make it dangerous or misleading:
 *
 *   · the route is OFF until a token is configured, and a wrong token is a 401;
 *   · only the allowlisted registry hosts, only https — an SSRF attempt at
 *     169.254.169.254 or at evil-data.cms.gov is refused;
 *   · an UPSTREAM answer comes back verbatim WITH the X-Relay-Upstream stamp,
 *     so a 403 from CMS reaches the client as a 403 from CMS;
 *   · the relay refusing (401/403/502) is raised as a transport error, never
 *     returned as an answer — otherwise "could not reach the registry" would
 *     silently become "the registry has nobody about this physician";
 *   · a relay in the .env wins over a stale proxy line, which is the bug that
 *     made a copied .env break a second developer's machine entirely.
 */

const relay = require('../src/enrichment/relay');
const relayRoutes = require('../src/routes/relay.routes');
const httpHelper = require('../src/enrichment/http');

const TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ENV_KEYS = [
  'RELAY_TOKEN',
  'RELAY_TOKENS',
  'RELAY_ALLOWED_HOSTS',
  'RELAY_RATE_PER_MIN',
  'OUTSIDE_HTTP_RELAY',
  'OUTSIDE_HTTP_RELAY_TOKEN',
  'OUTSIDE_HTTP_PROXY',
];
const saved = {};

/** The registry answer the relay will be asked to fetch, per test. */
let upstream = { ok: true, status: 200, text: '{"result_count":1}' };
let upstreamCalls = [];
const realSend = httpHelper.send;

function setEnv(env) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
}

/** Start the relay route on a real loopback server, as a developer would hit it. */
async function startRelayServer() {
  const app = express();
  app.use('/relay', relayRoutes);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () =>
      resolve({ server, base: `http://127.0.0.1:${server.address().port}/relay` })
    );
  });
}

test.before(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  // The route's own outbound call is stubbed: these tests are about the relay,
  // not about CMS being up.
  httpHelper.send = async (url, opts) => {
    upstreamCalls.push({ url, opts });
    if (upstream instanceof Error) throw upstream;
    return upstream;
  };
});

test.after(() => {
  httpHelper.send = realSend;
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test.beforeEach(() => {
  upstream = { ok: true, status: 200, text: '{"result_count":1}' };
  upstreamCalls = [];
});

// ── The route ───────────────────────────────────────────────────────────────

test('no token configured → the route is off, and says so', async () => {
  setEnv({});
  const { server, base } = await startRelayServer();
  try {
    const res = await fetch(`${base}?url=${encodeURIComponent('https://data.cms.gov/data.json')}`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'relay_disabled');
    assert.equal(res.headers.get(relay.UPSTREAM_HEADER), null);
    assert.equal(upstreamCalls.length, 0, 'nothing may be fetched without a token');
  } finally {
    server.close();
  }
});

test('a missing or wrong token is 401, and nothing is fetched', async () => {
  setEnv({ RELAY_TOKEN: TOKEN });
  const { server, base } = await startRelayServer();
  const url = encodeURIComponent('https://data.cms.gov/data.json');
  try {
    const anonymous = await fetch(`${base}?url=${url}`);
    assert.equal(anonymous.status, 401);

    const wrong = await fetch(`${base}?url=${url}`, {
      headers: { Authorization: 'Bearer not-the-token' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(upstreamCalls.length, 0);
  } finally {
    server.close();
  }
});

test('an allowlisted host is fetched and returned verbatim, with the stamp', async () => {
  setEnv({ RELAY_TOKEN: TOKEN });
  upstream = { ok: true, status: 200, text: '{"result_count":7}' };
  const { server, base } = await startRelayServer();
  try {
    const res = await fetch(
      `${base}?url=${encodeURIComponent('https://npiregistry.cms.hhs.gov/api/?number=1')}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get(relay.UPSTREAM_HEADER), '200');
    assert.equal(await res.text(), '{"result_count":7}');
    assert.equal(upstreamCalls.length, 1);
    assert.equal(
      upstreamCalls[0].opts.allowRelay,
      false,
      'the relay must fetch directly, never back into a relay'
    );
  } finally {
    server.close();
  }
});

test("the upstream's own error is passed through as the upstream's, stamped", async () => {
  setEnv({ RELAY_TOKEN: TOKEN });
  upstream = { ok: false, status: 403, text: '<html>Access Denied</html>' };
  const { server, base } = await startRelayServer();
  try {
    const res = await fetch(`${base}?url=${encodeURIComponent('https://data.cms.gov/data.json')}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    // A CMS 403 must reach the developer AS a CMS 403 — stamped, so the client
    // reads it as an answer about the registry, not as the relay refusing.
    assert.equal(res.status, 403);
    assert.equal(res.headers.get(relay.UPSTREAM_HEADER), '403');
  } finally {
    server.close();
  }
});

test('SSRF attempts are refused: off-allowlist host, private address, non-https', async () => {
  setEnv({ RELAY_TOKEN: TOKEN });
  const { server, base } = await startRelayServer();
  const forbidden = [
    'https://evil-data.cms.gov/data.json', // suffix trick — exact match only
    'https://169.254.169.254/latest/meta-data/', // cloud metadata
    'https://127.0.0.1:3002/api/leads', // our own app
    'http://data.cms.gov/data.json', // plaintext
    'file:///etc/passwd',
  ];
  try {
    for (const target of forbidden) {
      const res = await fetch(`${base}?url=${encodeURIComponent(target)}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 403, `${target} must be refused`);
      assert.equal(res.headers.get(relay.UPSTREAM_HEADER), null);
    }
    assert.equal(upstreamCalls.length, 0, 'no refused target may be fetched');
  } finally {
    server.close();
  }
});

test('an unreachable upstream is a 502 WITHOUT the stamp (an outage, not an answer)', async () => {
  setEnv({ RELAY_TOKEN: TOKEN });
  upstream = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const { server, base } = await startRelayServer();
  try {
    const res = await fetch(`${base}?url=${encodeURIComponent('https://data.cms.gov/data.json')}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 502);
    assert.equal(res.headers.get(relay.UPSTREAM_HEADER), null);
    assert.equal((await res.json()).error, 'upstream_unreachable');
  } finally {
    server.close();
  }
});

test('per-token rate limit', async () => {
  setEnv({ RELAY_TOKENS: `dev2:${TOKEN}`, RELAY_RATE_PER_MIN: '3' });
  const { server, base } = await startRelayServer();
  const url = encodeURIComponent('https://clinicaltrials.gov/api/v2/studies');
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}?url=${url}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      codes.push(res.status);
    }
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  } finally {
    server.close();
  }
});

// ── The client ──────────────────────────────────────────────────────────────

test('client: a relayed GET returns the upstream answer', async () => {
  setEnv({ RELAY_TOKEN: TOKEN });
  upstream = { ok: true, status: 200, text: '{"ok":true}' };
  const { server, base } = await startRelayServer();
  try {
    setEnv({ RELAY_TOKEN: TOKEN, OUTSIDE_HTTP_RELAY: base, OUTSIDE_HTTP_RELAY_TOKEN: TOKEN });
    assert.equal(relay.enabled(), true);
    const res = await relay.request('https://data.cms.gov/data.json');
    assert.equal(res.status, 200);
    assert.equal(res.text, '{"ok":true}');
  } finally {
    server.close();
  }
});

test('client: the relay refusing is thrown, never returned as an empty answer', async () => {
  const { server, base } = await startRelayServer();
  try {
    setEnv({
      RELAY_TOKEN: TOKEN,
      OUTSIDE_HTTP_RELAY: base,
      OUTSIDE_HTTP_RELAY_TOKEN: 'the-wrong-token',
    });
    await assert.rejects(
      () => relay.request('https://data.cms.gov/data.json'),
      /refused \(HTTP 401\)/,
      'a bad token must surface as a transport failure, not as "no such physician"'
    );
  } finally {
    server.close();
  }
});

test('client: http.send prefers the relay over a stale proxy line', async () => {
  const { server, base } = await startRelayServer();
  try {
    setEnv({
      RELAY_TOKEN: TOKEN,
      OUTSIDE_HTTP_RELAY: base,
      OUTSIDE_HTTP_RELAY_TOKEN: TOKEN,
      // The line a copied .env leaves behind: nothing is listening on it.
      OUTSIDE_HTTP_PROXY: 'socks5://127.0.0.1:1080',
    });
    const res = await realSend('https://data.cms.gov/data.json', { timeoutMs: 5000 });
    assert.equal(res.status, 200, 'the dead proxy must not be used when a relay is set');
  } finally {
    server.close();
  }
});

test('client: an http:// relay is refused unless it is loopback', () => {
  setEnv({ OUTSIDE_HTTP_RELAY: 'http://agentpoc.insightmonk.com/relay' });
  assert.equal(relay.enabled(), false, 'a malformed relay must not throw at boot');
  assert.match(relay.describe(), /MISCONFIGURED/);

  setEnv({ OUTSIDE_HTTP_RELAY: 'http://localhost:3002/relay' });
  assert.equal(relay.enabled(), true);
});
