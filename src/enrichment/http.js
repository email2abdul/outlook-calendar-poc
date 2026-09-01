'use strict';

/**
 * Shared HTTP helper for the enrichment sources.
 *
 * Every external source in src/enrichment/sources/ is a public government API
 * with no key, no SDK and no uptime guarantee, so all of them need the same
 * three things: a hard timeout (Node's fetch has none by default and a stalled
 * socket would hang the request), retry with backoff on transport/5xx errors,
 * and a never-throw contract — a failing source must omit its section of the
 * profile, not fail the whole enrichment (the same degrade-don't-crash rule the
 * stores follow).
 *
 * NPPES additionally returns an empty result set transiently for a query that
 * does moments later, so callers can opt into ONE extra attempt on an
 * "empty but successful" response via `retryIfEmpty`.
 *
 * The never-throw contract has a sharp edge: a source that is DOWN and a source
 * that genuinely has no record both surface as an empty result. So every
 * transport-level failure is also reported to ./health, which `enrich()` reads
 * back to label such a result a lookup failure rather than an absence.
 */

const health = require('./health');

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RETRIES = 2; // total attempts = retries + 1
const USER_AGENT = 'outlook-calendar-poc/1.0 (BIS enrichment; +https://agentpoc.insightmonk.com)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build a URL with query params. Values that are null/undefined/'' are skipped
 * so callers can pass optional filters straight through.
 * @param {string} base
 * @param {Record<string, string|number|null|undefined>} params
 */
function buildUrl(base, params = {}) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * GET a JSON document.
 *
 * Resolves to `{ ok, status, body, error, kind }` — never rejects. `body` is
 * null when the response was not JSON or the request failed. `kind` says WHY it
 * failed ('dns' | 'network' | 'timeout' | 'tls' | 'upstream' | 'http' | null),
 * which is what lets a caller tell "no such provider" from "no such network".
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=20000]
 * @param {number} [opts.retries=2]        retries on transport error / 5xx / 429
 * @param {(body:any)=>boolean} [opts.retryIfEmpty]  extra single retry when the
 *        response was a valid 200 but the caller considers it empty
 * @param {string} [opts.label]            for log lines
 */
async function getJson(url, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryIfEmpty = null,
    label = 'http',
  } = opts;

  let emptyRetryUsed = false;
  let attempt = 0;
  let lastError = null;
  let lastKind = null;

  // `retries` covers hard failures; retryIfEmpty adds at most one more pass.
  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      });
      const text = await res.text();

      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null; // HTML error page, gateway timeout body, etc.
      }

      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        // A 5xx or a 429 is the upstream failing us; a plain 4xx is the upstream
        // answering us, and only the first sort makes the result untrustworthy.
        lastKind = res.status >= 500 || res.status === 429 ? 'upstream' : 'http';
        // 4xx (other than rate limiting) will not improve on a retry.
        if (res.status < 500 && res.status !== 429) {
          return { ok: false, status: res.status, body, error: lastError, kind: lastKind };
        }
      } else if (body !== null) {
        if (retryIfEmpty && !emptyRetryUsed && retryIfEmpty(body)) {
          // Successful-but-empty: give the upstream one more chance before
          // treating "no results" as the truth.
          emptyRetryUsed = true;
          await sleep(400);
          continue; // does not consume a retry
        }
        return { ok: true, status: res.status, body, error: null, kind: null };
      } else {
        // A gateway's HTML error page reaches us as a 200 with no JSON in it;
        // that is the upstream misbehaving, not an answer.
        lastError = 'response was not JSON';
        lastKind = 'upstream';
      }
    } catch (err) {
      const classified = health.classifyError(err);
      lastKind = classified.kind;
      lastError =
        classified.kind === 'timeout'
          ? `timeout after ${timeoutMs}ms`
          : `${classified.code ? `${classified.code}: ` : ''}${classified.message}`;
    } finally {
      clearTimeout(timer);
    }

    attempt++;
    if (attempt <= retries) await sleep(300 * 2 ** (attempt - 1)); // 300ms, 600ms
  }

  console.warn(
    `[enrichment:${label}] giving up after ${attempt} attempt(s): ${lastError}` +
      (lastKind === 'dns'
        ? ' — this is a DNS failure on this host, not an empty registry;' +
          ' check the box\'s resolver (npm run enrich:doctor)'
        : '')
  );
  health.record({ label, url, kind: lastKind, error: lastError });
  return { ok: false, status: 0, body: null, error: lastError, kind: lastKind };
}

module.exports = { getJson, buildUrl };
