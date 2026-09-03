'use strict';

const crypto = require('node:crypto');
const express = require('express');
const http = require('../enrichment/http');
const relay = require('../enrichment/relay');

/**
 * `GET /relay?url=…` — fetch a public registry URL on a developer's behalf.
 *
 * The server side of src/enrichment/relay.js. Read that file first: it explains
 * why this exists (an Indian network cannot reach data.cms.gov, and the ssh
 * tunnel that solves it is per-machine setup that does not survive being copied
 * between developers) and what contract the answer has to keep.
 *
 * This is deliberately NOT a general proxy. It is a keyhole:
 *   · GET only, https only, and only to hosts on ALLOWED_HOSTS;
 *   · a token is required, and no token configured means the route is off;
 *   · the upstream's status and body are returned verbatim, stamped with
 *     `X-Relay-Upstream` so the client can tell an upstream answer from this
 *     route refusing;
 *   · a per-token rate limit and a response size cap, because this runs on the
 *     production box and a developer's loop must not become its outage.
 *
 * SSRF is the risk that shapes all of it: an endpoint that fetches a
 * caller-supplied URL from inside the deployment is exactly what an attacker
 * wants pointed at 169.254.169.254 or a private address. The host allowlist is
 * an EXACT match against a fixed set of public registry hostnames — never a
 * suffix rule (`.cms.gov` would accept `evil-data.cms.gov`), never a redirect
 * followed off the list, and never a scheme other than https.
 */

const router = express.Router();

/** The five public registries the enrichment sources actually call. */
const DEFAULT_ALLOWED_HOSTS = [
  'data.cms.gov', // CMS Medicare physician & other practitioners + provider data
  'npiregistry.cms.hhs.gov', // NPPES NPI Registry
  'openpaymentsdata.cms.gov', // CMS Open Payments
  'eutils.ncbi.nlm.nih.gov', // PubMed
  'clinicaltrials.gov', // ClinicalTrials.gov
];

const MAX_TIMEOUT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_BYTES = 8 * 1024 * 1024; // a brief's worth of JSON, not a bulk export
const DEFAULT_RATE_PER_MIN = 120;

function allowedHosts() {
  const raw = String(process.env.RELAY_ALLOWED_HOSTS || '').trim();
  if (!raw) return DEFAULT_ALLOWED_HOSTS;
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Configured tokens as `name → token`.
 *
 * `RELAY_TOKENS=wajid:abc,dev2:def` gives each developer their own, so one can be
 * revoked without disturbing the others and the log can say who is calling.
 * `RELAY_TOKEN=abc` is the single-token shorthand.
 */
function tokens() {
  const map = new Map();
  const many = String(process.env.RELAY_TOKENS || '').trim();
  for (const entry of many.split(',')) {
    const pair = entry.trim();
    if (!pair) continue;
    const at = pair.indexOf(':');
    if (at <= 0) continue; // "name:token" or nothing
    const name = pair.slice(0, at).trim();
    const token = pair.slice(at + 1).trim();
    if (name && token) map.set(name, token);
  }
  const single = String(process.env.RELAY_TOKEN || '').trim();
  if (single) map.set('default', single);
  return map;
}

/** Constant-time compare that tolerates different lengths. */
function sameToken(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * Who is calling, or null. Bearer header first; `?token=` is accepted too so a
 * developer can verify the route with a plain browser or curl.
 */
function caller(req) {
  const header = String(req.get('authorization') || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  const presented = (bearer ? bearer[1] : String(req.query.token || '')).trim();
  if (!presented) return null;
  for (const [name, token] of tokens()) {
    if (sameToken(presented, token)) return name;
  }
  return null;
}

// ── Rate limit: a fixed window per token, in memory. Deliberately crude — this
//    guards the box against a runaway dev loop, it is not a security control,
//    and a restart clearing it is fine.
const hits = new Map(); // name → { windowStart, count }

function overRateLimit(name) {
  const perMin = Number(process.env.RELAY_RATE_PER_MIN) || DEFAULT_RATE_PER_MIN;
  const now = Date.now();
  const seen = hits.get(name);
  if (!seen || now - seen.windowStart >= 60000) {
    hits.set(name, { windowStart: now, count: 1 });
    return false;
  }
  seen.count += 1;
  return seen.count > perMin;
}

/**
 * Is this a URL we are willing to fetch?
 * @returns {{ok:true, url:URL}|{ok:false, reason:string}}
 */
function checkTarget(raw) {
  const value = String(raw || '').trim();
  if (!value) return { ok: false, reason: 'the "url" query parameter is required' };

  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'the "url" query parameter is not a URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'only https:// URLs are relayed' };

  const host = url.hostname.toLowerCase();
  if (!allowedHosts().includes(host)) {
    return { ok: false, reason: `host ${host} is not on this relay's allowlist` };
  }
  return { ok: true, url };
}

/** Every answer this route produces about ITSELF (never an upstream answer). */
function refuse(res, status, error, message) {
  // No X-Relay-Upstream header: the client turns this into a transport error,
  // which the health ledger records as an outage rather than as an empty
  // registry. Keeping that distinction is the whole point of the header.
  return res.status(status).json({ error, message });
}

router.get('/ping', (req, res) => {
  if (!tokens().size) return refuse(res, 503, 'relay_disabled', 'no RELAY_TOKEN is configured');
  const who = caller(req);
  if (!who) return refuse(res, 401, 'unauthorized', 'missing or unknown relay token');
  res.json({ ok: true, caller: who, allowedHosts: allowedHosts() });
});

router.get('/', async (req, res) => {
  if (!tokens().size) {
    return refuse(
      res,
      503,
      'relay_disabled',
      'no RELAY_TOKEN/RELAY_TOKENS is configured on this server'
    );
  }

  const who = caller(req);
  if (!who) return refuse(res, 401, 'unauthorized', 'missing or unknown relay token');
  if (overRateLimit(who)) {
    return refuse(res, 429, 'rate_limited', `more than ${process.env.RELAY_RATE_PER_MIN || DEFAULT_RATE_PER_MIN} relayed requests in a minute`);
  }

  const target = checkTarget(req.query.url);
  if (!target.ok) return refuse(res, 403, 'forbidden_target', target.reason);

  const asked = Number(req.query.timeoutMs);
  const timeoutMs = Math.min(
    Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  );

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // allowRelay:false — this server must go to the registry itself (through
    // its own proxy when it has one), not back into a relay.
    const upstream = await http.send(target.url.toString(), {
      allowRelay: false,
      timeoutMs,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'outlook-calendar-poc/1.0 (BIS enrichment relay)',
      },
    });

    if (upstream.text && upstream.text.length > MAX_BYTES) {
      return refuse(
        res,
        502,
        'response_too_large',
        `upstream returned ${upstream.text.length} bytes (cap ${MAX_BYTES})`
      );
    }

    console.log(
      `[relay] ${who} → ${target.url.hostname} ${upstream.status} ` +
        `(${Date.now() - started}ms, ${Math.round((upstream.text || '').length / 102.4) / 10}kb)`
    );

    // The upstream's own answer, verbatim and stamped. A 403 from CMS reaches
    // the developer as a 403 from CMS — the relay's job is transport, not
    // interpretation.
    res.set(relay.UPSTREAM_HEADER, String(upstream.status));
    res.status(upstream.status);
    res.type('application/json');
    return res.send(upstream.text ?? '');
  } catch (err) {
    const timedOut = err.name === 'AbortError' || /timed out/i.test(err.message || '');
    console.warn(`[relay] ${who} → ${target.url.hostname} FAILED: ${err.message}`);
    return refuse(
      res,
      502,
      timedOut ? 'upstream_timeout' : 'upstream_unreachable',
      timedOut ? `no answer within ${timeoutMs}ms` : err.message
    );
  } finally {
    clearTimeout(timer);
  }
});

module.exports = router;
module.exports.DEFAULT_ALLOWED_HOSTS = DEFAULT_ALLOWED_HOSTS;
module.exports.checkTarget = checkTarget;
module.exports.tokens = tokens;
