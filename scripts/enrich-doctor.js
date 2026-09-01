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
 */

const dns = require('node:dns');
const net = require('node:net');
const { classifyError } = require('../src/enrichment/health');

const TIMEOUT_MS = 12000;

/**
 * One probe per source, hitting the same host the source module hits. The URLs
 * are the cheapest real request each API accepts; a 4xx still proves the host is
 * reachable, so only transport failures count as failures.
 */
const PROBES = [
  {
    name: 'NPPES NPI Registry',
    tier: 'T2 — identity (NPI). Without this, unknown attendees stay unknown.',
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

async function httpProbe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'outlook-calendar-poc/enrich-doctor' },
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { reached: true, status: res.status, body, ms: Date.now() - startedAt };
  } catch (err) {
    return { reached: false, ...classifyError(err), ms: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log('Enrichment connectivity check');
  console.log(`  node ${process.version}  ·  resolvers: ${dns.getServers().join(', ') || '(none)'}`);
  console.log(`  dns result order: ${dns.getDefaultResultOrder()}  ·  autoSelectFamily: ${net.getDefaultAutoSelectFamily()}`);
  console.log('');

  let failures = 0;
  const warnings = [];

  for (const probe of PROBES) {
    const host = hostOf(probe.url);
    console.log(`── ${probe.name}  (${host})`);
    console.log(`   ${probe.tier}`);

    const addrs = await resolveHost(host);
    if (addrs.error) {
      failures += 1;
      console.log(`   ❌ DNS: ${addrs.error.code || addrs.error.kind} — ${addrs.error.message}`);
      console.log('      The host was never contacted. Fix the resolver before reading anything');
      console.log('      into an empty enrichment result.');
      console.log('');
      continue;
    }
    console.log(
      `   ✅ DNS: ${addrs.v4.length} A, ${addrs.v6.length} AAAA` +
        `${addrs.v4.length ? ` (${addrs.v4[0]})` : ''}`
    );

    // A host that resolves ONLY to AAAA on a box with no IPv6 route is the
    // quietest version of this failure: name resolution "works", every request
    // stalls. Node's Happy Eyeballs usually rescues it — but only when
    // autoSelectFamily is on, so the trap is worth naming explicitly.
    if (addrs.v6.length && !addrs.v4.length) {
      const v6 = await tcpProbe(addrs.v6[0], 6);
      if (!v6.ok) {
        warnings.push(
          `${host} resolves to IPv6 only and IPv6 egress fails here (${v6.error}) — ` +
            'every request to it depends on a fallback that may not exist.'
        );
        console.log(`   ⚠️  IPv6-only DNS, but IPv6 connect failed (${v6.error})`);
      }
    } else if (addrs.v6.length) {
      const v6 = await tcpProbe(addrs.v6[0], 6);
      if (!v6.ok) console.log(`   ·  IPv6 connect fails (${v6.error}); IPv4 available, so requests still work`);
    }

    const res = await httpProbe(probe.url);
    if (!res.reached) {
      failures += 1;
      console.log(`   ❌ HTTPS: ${res.kind}${res.code ? ` (${res.code})` : ''} — ${res.message}`);
    } else if (probe.check) {
      const verdict = probe.check(res.body);
      if (verdict.ok) {
        console.log(`   ✅ HTTPS ${res.status} in ${res.ms}ms — ${verdict.detail}`);
      } else {
        failures += 1;
        console.log(`   ❌ HTTPS ${res.status} in ${res.ms}ms — ${verdict.detail}`);
      }
    } else {
      // No response shape to assert; any status proves reachability.
      console.log(`   ✅ HTTPS ${res.status} in ${res.ms}ms (any status = reachable)`);
    }
    console.log('');
  }

  for (const w of warnings) console.log(`⚠️  ${w}`);
  if (warnings.length) console.log('');

  if (failures) {
    console.log(`❌ ${failures} source(s) unreachable.`);
    console.log('');
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

  console.log('✅ All enrichment sources reachable from this host.');
}

main().catch((err) => {
  console.error('enrich:doctor crashed:', err);
  process.exitCode = 1;
});
