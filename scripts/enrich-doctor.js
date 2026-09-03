#!/usr/bin/env node
'use strict';

/**
 * enrich:doctor — is this box able to reach the enrichment sources at all?
 *
 * Written because a lookup failure and a lookup MISS are indistinguishable from
 * the outside. On a router that would not resolve npiregistry.cms.hhs.gov, the
 * NPPES tier returned an empty array, `enrich()` reported "unresolved", and the
 * brief read as though the physician did not exist. Forcing 8.8.8.8 fixed it —
 * but nothing in the app said DNS was the problem.
 *
 * src/enrichment/health.js now makes that visible at runtime. This script is the
 * deployment-time half: run it on the server (EC2, container, laptop) BEFORE
 * blaming the data.
 *
 *   npm run enrich:doctor
 *
 * Exits 0 when every source answered, 1 otherwise — so it is usable as a
 * post-deploy smoke check in CI or a systemd ExecStartPre.
 *
 * ── Two things this script used to get WRONG, both fixed here ───────────────
 *
 * 1. It called a geo-block "reachable". `data.cms.gov` answers an Akamai
 *    **403 Access Denied** to an Indian IP — the host is up, TLS completes, and
 *    the old "any status = reachable" rule printed a green tick while the CMS
 *    source could not read a single row. A 401/403 from these APIs is never an
 *    answer: none of them takes a credential, so it is the edge refusing us.
 *
 * 2. It ignored the proxy. When OUTSIDE_HTTP_PROXY is set, the app's requests
 *    go through the tunnel — so this script must ask the same way, and the
 *    laptop's own DNS becomes IRRELEVANT (the proxy resolves names at the far
 *    end). It used to fail the whole run over a local resolver the app was not
 *    using, and pass a CMS the app could not read. Now it starts the tunnel
 *    (src/enrichment/tunnel.js), probes through it, and reports local DNS as
 *    information rather than as a verdict.
 */

// The proxy and the tunnel are configured in .env, and this script used to be
// the one thing in the repo that never read it — which is why it reported a
// direct, blocked CMS while the app was happily going through the tunnel.
require('dotenv').config();

const dns = require('node:dns');
const net = require('node:net');
const { classifyError } = require('../src/enrichment/health');
const proxy = require('../src/enrichment/proxy');
const tunnel = require('../src/enrichment/tunnel');

const TIMEOUT_MS = 12000;

/**
 * One probe per source, hitting the same host the source module hits. The URLs
 * are the cheapest real request each API accepts.
 */
const PROBES = [
  {
    name: 'CMS Medicare Physician & Other Practitioners',
    tier: 'T2 — the FIRST source a name is asked of (it proves the physician bills Medicare).',
    // The data-api root: 404 with a JSON error when the edge lets us in, and
    // the Akamai 403 page when it does not. Two bytes of signal for one cheap
    // request — the alternative, /data.json, is 3 MB and 8 seconds.
    url: 'https://data.cms.gov/data-api/v1/dataset',
    check: (body, res) =>
      res.status === 404 && body?.errors
        ? { ok: true, detail: 'data-api root answered (404 JSON = the edge let us through)' }
        : { ok: true, detail: `data-api answered ${res.status}` },
  },
  {
    name: 'NPPES NPI Registry',
    tier: 'T2 — identity (NPI), the fallback when CMS has nobody by that name.',
    // The provider used as the module's live-verification fixture.
    url: 'https://npiregistry.cms.hhs.gov/api/?version=2.1&number=1467521757',
    check: (body) => (body && Number.isFinite(body.result_count)
      ? { ok: true, detail: `result_count=${body.result_count}` }
      : { ok: false, detail: 'reachable, but the response was not NPPES JSON' }),
  },
  {
    name: 'CMS Provider Data',
    tier: 'T4 — hospital affiliation / CCN.',
    url: 'https://data.cms.gov/provider-data/api/1/datastore/query',
  },
  {
    name: 'CMS Open Payments',
    tier: 'T4 — industry payments (Extra Intelligence).',
    url: 'https://openpaymentsdata.cms.gov/api/1/datastore/query',
  },
  {
    name: 'PubMed (E-utilities)',
    tier: 'T4 — publications.',
    url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi?retmode=json',
  },
  {
    name: 'ClinicalTrials.gov',
    tier: 'T4 — trial involvement.',
    url: 'https://clinicaltrials.gov/api/v2/studies?pageSize=1',
  },
];

const hostOf = (url) => new URL(url).host;

/**
 * Is this response the EDGE refusing us, rather than the API answering?
 *
 * None of these datasets takes a credential, so a 401/403 cannot mean "log in"
 * — it means a CDN in front of the data said no to this client, and every
 * lookup through it will come back empty. That must read as a failure here,
 * because the whole point of this script is to stop an empty result being
 * mistaken for an empty dataset.
 *
 * Exported so a test can pin the Akamai body that started all this.
 */
function edgeBlocked(status, text = '') {
  if (status !== 401 && status !== 403) return null;
  const akamai = /access denied|errors\.edgesuite\.net|reference\s*#\d/i.test(text);
  return {
    reason: akamai
      ? 'Akamai edge refused this IP (geo block) — the host is up and the dataset is fine; ' +
        'this client is not allowed in'
      : `the edge refused this request (HTTP ${status}) — these APIs take no credential, ` +
        'so this is a block, not an authentication error',
    fix: 'reach it through the tunnel: OUTSIDE_HTTP_PROXY=socks5://127.0.0.1:1080 ' +
      '(+ OUTSIDE_HTTP_PROXY_SSH=user@host so it starts itself)',
  };
}

/** Resolve A and AAAA separately — which one is missing is the diagnosis. */
async function resolveHost(host) {
  const out = { v4: [], v6: [], error: null };
  const [v4, v6] = await Promise.all([
    dns.promises.resolve4(host).catch((e) => e),
    dns.promises.resolve6(host).catch((e) => e),
  ]);
  if (Array.isArray(v4)) out.v4 = v4;
  if (Array.isArray(v6)) out.v6 = v6;
  if (!out.v4.length && !out.v6.length) {
    const err = v4 instanceof Error ? v4 : v6;
    out.error = classifyError(err);
  }
  return out;
}

/** Open a bare TCP socket to 443 on one address — isolates egress from DNS. */
function tcpProbe(address, family) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port: 443, family });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(5000);
    socket.once('connect', () => done({ ok: true }));
    socket.once('timeout', () => done({ ok: false, error: 'timeout' }));
    socket.once('error', (err) => done({ ok: false, error: err.code || err.message }));
  });
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * GET one probe URL the same way the app would: through the proxy when one is
 * configured, with plain `fetch` when it is not.
 */
async function httpProbe(url) {
  const startedAt = Date.now();

  if (proxy.enabled()) {
    try {
      const res = await proxy.request(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'outlook-calendar-poc/enrich-doctor' },
        timeoutMs: TIMEOUT_MS,
      });
      return {
        reached: true,
        status: res.status,
        text: res.text,
        body: parseJson(res.text),
        ms: Date.now() - startedAt,
        viaProxy: true,
      };
    } catch (err) {
      return { reached: false, ...classifyError(err), ms: Date.now() - startedAt, viaProxy: true };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'outlook-calendar-poc/enrich-doctor' },
    });
    const text = await res.text();
    return {
      reached: true,
      status: res.status,
      text,
      body: parseJson(text),
      ms: Date.now() - startedAt,
      viaProxy: false,
    };
  } catch (err) {
    return { reached: false, ...classifyError(err), ms: Date.now() - startedAt, viaProxy: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The local resolver and local egress — a DIAGNOSIS, and only sometimes a
 * verdict.
 *
 * Unproxied, a host that will not resolve is the failure and there is nothing
 * more to say. Proxied, the tunnel resolves names at the far end, so a local
 * SERVFAIL is a fact about the router and not about the app; printing it as a
 * failure is how this script used to exit 1 on a machine where every lookup
 * worked.
 *
 * @returns {Promise<{failed: boolean, warning: string|null}>}
 */
async function checkLocalNetwork(host, { proxied }) {
  const addrs = await resolveHost(host);

  if (addrs.error) {
    const what = `DNS: ${addrs.error.code || addrs.error.kind} — ${addrs.error.message}`;
    if (proxied) {
      console.log(`   ·  local ${what}`);
      console.log('      Not used: requests go through the proxy, which resolves names itself.');
      return { failed: false, warning: null };
    }
    console.log(`   ❌ ${what}`);
    console.log('      The host was never contacted. Fix the resolver before reading anything');
    console.log('      into an empty enrichment result.');
    return { failed: true, warning: null };
  }

  const found =
    `DNS: ${addrs.v4.length} A, ${addrs.v6.length} AAAA` +
    `${addrs.v4.length ? ` (${addrs.v4[0]})` : ''}`;
  if (proxied) {
    console.log(`   ·  local ${found} (informational — the proxy resolves for us)`);
    return { failed: false, warning: null };
  }
  console.log(`   ✅ ${found}`);

  // A host that resolves ONLY to AAAA on a box with no IPv6 route is the
  // quietest version of this failure: name resolution "works", every request
  // stalls. Node's Happy Eyeballs usually rescues it — but only when
  // autoSelectFamily is on, so the trap is worth naming explicitly.
  if (addrs.v6.length && !addrs.v4.length) {
    const v6 = await tcpProbe(addrs.v6[0], 6);
    if (!v6.ok) {
      console.log(`   ⚠️  IPv6-only DNS, but IPv6 connect failed (${v6.error})`);
      return {
        failed: false,
        warning:
          `${host} resolves to IPv6 only and IPv6 egress fails here (${v6.error}) — ` +
          'every request to it depends on a fallback that may not exist.',
      };
    }
  } else if (addrs.v6.length) {
    const v6 = await tcpProbe(addrs.v6[0], 6);
    if (!v6.ok) {
      console.log(`   ·  IPv6 connect fails (${v6.error}); IPv4 available, so requests still work`);
    }
  }
  return { failed: false, warning: null };
}

/** The tunnel + proxy header: what these probes are about to go through. */
async function reportTransport() {
  const t = await tunnel.ensure();
  if (t.line) console.log(`  ${t.line}`);

  const via = proxy.describe();
  if (!via) {
    console.log('  requests: direct (no OUTSIDE_HTTP_PROXY)');
    return { proxied: false, blocked: 0 };
  }
  console.log(`  requests: via ${via}`);
  if (t.state === 'unavailable') {
    console.log('  ⚠️  the proxy is configured but not up — every probe below will fail through it');
  }
  return { proxied: true, blocked: 0 };
}

async function main() {
  console.log('Enrichment connectivity check');
  console.log(`  node ${process.version}  ·  resolvers: ${dns.getServers().join(', ') || '(none)'}`);
  console.log(`  dns result order: ${dns.getDefaultResultOrder()}  ·  autoSelectFamily: ${net.getDefaultAutoSelectFamily()}`);
  const { proxied } = await reportTransport();
  console.log('');

  let failures = 0;
  let blocks = 0;
  const warnings = [];

  for (const probe of PROBES) {
    const host = hostOf(probe.url);
    console.log(`── ${probe.name}  (${host})`);
    console.log(`   ${probe.tier}`);

    const local = await checkLocalNetwork(host, { proxied });
    if (local.warning) warnings.push(local.warning);
    if (local.failed) {
      failures += 1;
      console.log('');
      continue;
    }

    const res = await httpProbe(probe.url);
    const label = `HTTPS${res.viaProxy ? ' (via proxy)' : ''}`;

    if (!res.reached) {
      failures += 1;
      console.log(`   ❌ ${label}: ${res.kind}${res.code ? ` (${res.code})` : ''} — ${res.message}`);
      console.log('');
      continue;
    }

    // Before any body check: was this the edge refusing us? A 403 page is not
    // an answer, however healthy the socket was.
    const block = edgeBlocked(res.status, res.text);
    if (block) {
      failures += 1;
      blocks += 1;
      console.log(`   ❌ ${label} ${res.status} in ${res.ms}ms — ${block.reason}`);
      console.log(`      Fix: ${block.fix}`);
      console.log('');
      continue;
    }

    if (probe.check) {
      const verdict = probe.check(res.body, res);
      if (verdict.ok) {
        console.log(`   ✅ ${label} ${res.status} in ${res.ms}ms — ${verdict.detail}`);
      } else {
        failures += 1;
        console.log(`   ❌ ${label} ${res.status} in ${res.ms}ms — ${verdict.detail}`);
      }
    } else {
      // No response shape to assert; any status that is not a block proves the
      // API is talking to us.
      console.log(`   ✅ ${label} ${res.status} in ${res.ms}ms (reachable)`);
    }
    console.log('');
  }

  for (const w of warnings) console.log(`⚠️  ${w}`);
  if (warnings.length) console.log('');

  if (failures) {
    console.log(`❌ ${failures} source(s) unreachable${blocks ? ` (${blocks} blocked at the edge)` : ''}.`);
    console.log('');
    if (blocks) {
      console.log('A BLOCK is not an outage and not an empty dataset — the same request works from');
      console.log('another network. On this laptop the tunnel is the fix:');
      console.log('  OUTSIDE_HTTP_PROXY=socks5://127.0.0.1:1080     # in .env');
      console.log('  OUTSIDE_HTTP_PROXY_SSH=user@host               # so it starts itself');
      console.log('  npm run enrich:doctor                          # re-run: it starts the tunnel');
      console.log('');
    }
    console.log('If DNS is the failure, on this host:');
    console.log('  resolvectl status                 # what is actually being used');
    console.log('  resolvectl query npiregistry.cms.hhs.gov');
    console.log('  dig +short @8.8.8.8 npiregistry.cms.hhs.gov   # does a public resolver work?');
    console.log('');
    console.log('On EC2, the usual causes are: enableDnsSupport off on the VPC, a security-group /');
    console.log('NACL rule blocking 443 egress, or a DHCP option set pointing at a resolver that');
    console.log('cannot answer for public zones. Adding a public resolver to /etc/resolv.conf is a');
    console.log('workaround, not a fix — systemd-resolved rewrites it on restart.');
    process.exitCode = 1;
    return;
  }

  console.log(
    `✅ All enrichment sources reachable from this host${proxied ? ' (through the proxy)' : ''}.`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('enrich:doctor crashed:', err);
    process.exitCode = 1;
  });
}

module.exports = { edgeBlocked, PROBES };
