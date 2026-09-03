'use strict';

/**
 * Reach the public registries through OUR OWN server instead of directly.
 *
 * The third escape hatch, and the only one that is the same on every machine.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * The registries are unreachable from an Indian network in two independent
 * ways, both measured: `data.cms.gov` answers an Akamai 403 to the IP, and some
 * routers SERVFAIL `npiregistry.cms.hhs.gov`. ./proxy.js + ./tunnel.js solve
 * both — but only for a developer who has an ssh key on the deployment box, an
 * `ssh_config` alias and (on macOS) a launchd agent. That is a per-machine
 * setup, and a `.env` copied from the machine that has it turns every lookup on
 * the machine that does not into `ECONNREFUSED 127.0.0.1:1080`.
 *
 * A relay moves the whole problem server-side. The deployed app already sits on
 * a host the registries answer, so a developer asks THAT host to fetch the URL:
 *
 *     dev laptop ──https──▶ /relay?url=… ──▶ data.cms.gov      (from the US IP)
 *
 * so the only thing a new machine needs is two lines of `.env` — no key, no
 * alias, no launchd, no OS-specific step, and nothing but port 443 outbound
 * (which the networks that block custom ports still allow). The DNS problem
 * goes with it: the registry hostname is resolved by the relay host.
 *
 * ── The invariant this must not break ───────────────────────────────────────
 * "The registry could not be reached" and "the registry has nobody" must stay
 * distinguishable (src/enrichment/health.js exists for that reason alone). So
 * the relay answers with the UPSTREAM's status and body verbatim and marks that
 * answer with an `X-Relay-Upstream` header; anything without that header is the
 * relay itself refusing (bad token, host not on the allowlist, upstream
 * unreachable) and is raised here as a transport error — which getJson
 * classifies and records as an outage, never as an empty registry.
 *
 * OFF unless OUTSIDE_HTTP_RELAY is set. When it is set it wins over
 * OUTSIDE_HTTP_PROXY, so a stale proxy line cannot poison a relayed machine.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Header the relay stamps on an answer it actually got from the upstream. */
const UPSTREAM_HEADER = 'x-relay-upstream';

/**
 * The configured relay, or null.
 *
 * @returns {{base:string, token:string|null, host:string}|null}
 */
function configured() {
  const raw = String(process.env.OUTSIDE_HTTP_RELAY || '').trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`OUTSIDE_HTTP_RELAY is not a URL: ${raw}`);
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    // The token travels in a header; plaintext is only ever acceptable to a
    // relay running on this same machine (stage-1 local testing).
    throw new Error(
      `OUTSIDE_HTTP_RELAY must be https:// (http:// is allowed only for localhost) — got ${raw}`
    );
  }

  return {
    base: url.toString().replace(/\/+$/, ''),
    token: String(process.env.OUTSIDE_HTTP_RELAY_TOKEN || '').trim() || null,
    host: url.host,
  };
}

/** Is a relay configured at all? Cheap enough to call per request. */
function enabled() {
  try {
    return Boolean(configured());
  } catch {
    // A malformed value must not take the app down at boot; the first request
    // reports it properly through getJson's error path.
    return false;
  }
}

/**
 * GET a URL through the relay.
 *
 * Returns the same three things the caller needs from a `fetch` Response —
 * `{ ok, status, text }` — where all three describe the UPSTREAM's answer, and
 * rejects on anything else, exactly like proxy.request.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.headers]
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 */
async function request(url, { headers = {}, timeoutMs = 20000, signal = null } = {}) {
  const relay = configured();
  if (!relay) throw new Error('no OUTSIDE_HTTP_RELAY is configured');

  const target = new URL(url);
  if (target.protocol !== 'https:') {
    throw new Error(`OUTSIDE_HTTP_RELAY only relays https URLs (got ${target.protocol})`);
  }

  const relayUrl = new URL(relay.base);
  relayUrl.searchParams.set('url', url);
  relayUrl.searchParams.set('timeoutMs', String(timeoutMs));

  let res;
  try {
    res = await fetch(relayUrl.toString(), {
      signal,
      headers: {
        ...headers,
        ...(relay.token ? { Authorization: `Bearer ${relay.token}` } : {}),
      },
    });
  } catch (err) {
    // The relay host itself is unreachable — a transport failure like any
    // other, but say WHERE it happened or the log reads as a CMS outage.
    err.message = `relay ${relay.host} unreachable — ${err.message}`;
    throw err;
  }

  const text = await res.text();

  // No stamp → the relay refused or could not reach the upstream. This is an
  // outage on our side of the wire and must never look like an answer.
  if (!res.headers.get(UPSTREAM_HEADER)) {
    let detail = text.slice(0, 200);
    try {
      const body = JSON.parse(text);
      detail = body.message || body.error || detail;
    } catch {
      /* not JSON — use the raw prefix */
    }
    throw new Error(`relay ${relay.host} refused (HTTP ${res.status}): ${detail}`);
  }

  return { ok: res.ok, status: res.status, text };
}

/** One line for a log: what the sources are going through, if anything. */
function describe() {
  let relay;
  try {
    relay = configured();
  } catch (err) {
    return `relay MISCONFIGURED (${err.message})`;
  }
  if (!relay) return null;
  return `relay ${relay.base}${relay.token ? '' : ' (no token set!)'}`;
}

module.exports = {
  enabled,
  request,
  describe,
  configured,
  UPSTREAM_HEADER,
};
