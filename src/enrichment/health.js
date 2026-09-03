'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * Source-health ledger — tells "we asked and the answer was no" apart from
 * "we never got to ask".
 *
 * Every source in src/enrichment/sources/ returns an empty array on failure
 * (http.js has a never-throw contract, deliberately: one dead registry must not
 * fail the whole enrichment). The cost of that is ambiguity. A DNS failure on
 * npiregistry.cms.hhs.gov made searchIndividuals() return `[]`, which walked
 * all the way up to `status: 'unresolved'` and the note "Could not resolve this
 * address from the free registries" — a confident statement that the physician
 * does not exist, produced by a resolver that never sent a packet. Observed on
 * a router that would not resolve the NPPES host at all (2026-09-01); the box
 * needed 8.8.8.8 forced before the tier worked again.
 *
 * So http.js records each transport-level failure here, `enrich()` reads them
 * back, and an empty result that coincided with an outage is reported as a
 * lookup failure instead of an absence.
 *
 * Scoped with AsyncLocalStorage because enrichments run concurrently (the
 * reminder engine briefs several meetings at once) and one meeting's outage
 * must not be attributed to another's result. Outside a `run()` — the CLI
 * scripts, a direct source call in a REPL — `record()` is a no-op, so nothing
 * has to know about this module to keep working.
 */

const storage = new AsyncLocalStorage();

/** getaddrinfo failed — the host was never contacted. */
const DNS_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'EAI_NONAME', 'EAI_SYSTEM',
]);

/** The name resolved but the socket did not survive. */
const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN',
  'EPIPE', 'ETIMEDOUT', 'EPROTO', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Classify a thrown fetch error. undici hides the OS error one level down, in
 * `err.cause`, so a bare `err.code` check misses every DNS failure.
 *
 * @returns {{kind:'dns'|'network'|'timeout'|'tls'|'error', code:string|null, message:string}}
 */
function classifyError(err) {
  if (!err) return { kind: 'error', code: null, message: 'unknown error' };
  if (err.name === 'AbortError' || err.name === 'TimeoutError') {
    return { kind: 'timeout', code: null, message: err.message || 'aborted' };
  }

  const code = err.cause?.code || err.code || null;
  const message = err.cause?.message || err.message || String(err);

  if (code && DNS_CODES.has(code)) return { kind: 'dns', code, message };
  if (code && NETWORK_CODES.has(code)) return { kind: 'network', code, message };
  if (code && String(code).startsWith('CERT_')) return { kind: 'tls', code, message };
  if (code && String(code).startsWith('ERR_TLS')) return { kind: 'tls', code, message };
  return { kind: 'error', code, message };
}

/**
 * Kinds that mean "no answer was obtained", as opposed to "the answer was no".
 *
 * `offline` is one of them: a replay run with no recording for a URL
 * (OUTSIDE_HTTP_OFFLINE=1, see ./cassettes.js) asked nothing at all, and
 * reading that as "this physician is not in the registry" is the exact
 * mistake this ledger exists to prevent.
 */
const BLIND_KINDS = new Set(['dns', 'network', 'timeout', 'tls', 'upstream', 'offline']);

/** Run `fn` with a fresh ledger. Returns whatever `fn` resolves to. */
function run(fn) {
  return storage.run({ outages: new Map() }, fn);
}

/**
 * Record one failed request. Repeat failures of the same source collapse into a
 * single entry with a count — three retries against a dead resolver are one
 * outage, not three.
 *
 * @param {object} entry
 * @param {string} entry.label   the source label passed to getJson ('nppes')
 * @param {string} entry.url     the URL that failed; only its host is kept
 * @param {string} entry.kind    from classifyError, or 'upstream' for a 5xx
 * @param {string} entry.error   human-readable reason
 */
function record(entry) {
  const ledger = storage.getStore();
  if (!ledger) return;

  const label = entry.label || 'http';
  const existing = ledger.outages.get(label);
  if (existing) {
    existing.attempts += 1;
    return;
  }

  let host = null;
  try {
    host = new URL(entry.url).host;
  } catch {
    host = null;
  }

  ledger.outages.set(label, {
    label,
    host,
    kind: entry.kind || 'error',
    error: entry.error || 'request failed',
    blind: BLIND_KINDS.has(entry.kind),
    attempts: 1,
  });
}

/** Everything recorded in the current run. Empty outside a `run()`. */
function outages() {
  const ledger = storage.getStore();
  return ledger ? [...ledger.outages.values()] : [];
}

/** True when at least one source could not be reached at all. */
function anyBlind() {
  return outages().some((o) => o.blind);
}

/** Outages for one label — "did NPPES specifically fail during this run?" */
function blindFor(...labels) {
  const wanted = new Set(labels);
  return outages().filter((o) => o.blind && wanted.has(o.label));
}

/**
 * One line a human can act on:
 *   "NPPES was unreachable (DNS lookup failed for npiregistry.cms.hhs.gov)"
 */
function describe(outage, sourceName) {
  const name = sourceName || outage.label;
  const where = outage.host ? ` for ${outage.host}` : '';
  switch (outage.kind) {
    case 'offline':
      return `${name} was not asked — no recorded answer for this request (OUTSIDE_HTTP_OFFLINE=1)`;
    case 'dns':
      return `${name} was unreachable — DNS lookup failed${where} (${outage.error})`;
    case 'timeout':
      return `${name} timed out${where}`;
    case 'tls':
      return `${name} was unreachable — TLS failure${where} (${outage.error})`;
    case 'upstream':
      return `${name} returned an error${where} (${outage.error})`;
    default:
      return `${name} was unreachable${where} (${outage.error})`;
  }
}

module.exports = { run, record, outages, anyBlind, blindFor, classifyError, describe };
