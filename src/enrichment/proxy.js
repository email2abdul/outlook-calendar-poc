'use strict';

const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const http = require('node:http');

/**
 * Reach the public sources through a proxy — for the network that blocks them.
 *
 * This exists because of a measured fact rather than a preference. The CDN in
 * front of data.cms.gov refuses this developer's address outright — same URL,
 * two places, 2026-09-03:
 *
 *   from an Indian ISP (Jio, 47.31.80.104)   → 403 Access Denied (Akamai)
 *   from the deployment box (US, Ashburn)    → 200
 *   from the laptop THROUGH that box         → 200
 *
 * Every path on the host, IPv4 and IPv6 alike, browser User-Agent or not: it
 * is an IP/geo decision by the edge, not DNS, not the router, and not
 * something a request header can talk its way past. (An earlier note here
 * called it a middlebox on the path, on the strength of `/data.json` answering
 * while `/data-api/*` had its HTTP/2 stream killed. That was wrong: the edge
 * was denying both, one of them less politely.)
 *
 * `npiregistry.cms.hhs.gov` is a DIFFERENT problem on the same network and
 * needs no proxy at all: the router's resolver SERVFAILs the name, and with
 * 1.1.1.1 (or any public resolver) the registry answers from India perfectly
 * well — verified by bypassing the resolver and getting a 200.
 *
 * So the only thing that must travel out of the country is CMS, and an
 * `ssh -D 1080 <host>` tunnel through the deployment box does it:
 *
 *   OUTSIDE_HTTP_PROXY=socks5://127.0.0.1:1080
 *
 * Node's global `fetch` cannot be pointed at a SOCKS proxy without an undici
 * dispatcher, and adding a dependency for a dev-only workaround is a poor
 * trade — so a proxied request goes through `node:https` with a socket this
 * module builds: SOCKS5 (or HTTP CONNECT) first, TLS on top of it. Unproxied
 * requests never come near this file.
 */

const DEFAULT_PORTS = { 'socks5:': 1080, 'socks:': 1080, 'socks5h:': 1080, 'http:': 8080, 'https:': 443 };
const SOCKS_SCHEMES = new Set(['socks:', 'socks5:', 'socks5h:']);

/**
 * The configured proxy, or null.
 *
 * Deliberately its own variable rather than HTTPS_PROXY: this proxies the
 * outbound calls to the public registries only, and pointing the whole process
 * at a tunnel (Graph, Supabase, Anthropic included) is not what anybody wants
 * from a workaround for two government hosts.
 */
function parseProxy(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`OUTSIDE_HTTP_PROXY is not a URL: ${value}`);
  }
  if (!DEFAULT_PORTS[url.protocol]) {
    throw new Error(
      `OUTSIDE_HTTP_PROXY scheme ${url.protocol} is not supported — use socks5:// or http://`
    );
  }
  return {
    kind: SOCKS_SCHEMES.has(url.protocol) ? 'socks5' : 'connect',
    host: url.hostname,
    port: Number(url.port) || DEFAULT_PORTS[url.protocol],
    // A SOCKS5 username/password is accepted but not used: an ssh -D tunnel
    // takes no auth, and inventing a handshake this app cannot test would be
    // worse than saying so.
    auth: url.username ? { username: url.username, password: url.password } : null,
  };
}

function configured() {
  return parseProxy(process.env.OUTSIDE_HTTP_PROXY);
}

/** Is a proxy configured at all? Cheap enough to call per request. */
function enabled() {
  try {
    return Boolean(configured());
  } catch {
    return false; // a malformed value is reported by request(), not here
  }
}

// ── SOCKS5 ───────────────────────────────────────────────────────────────────

/** The client greeting: version 5, one method, "no authentication". */
function greeting() {
  return Buffer.from([0x05, 0x01, 0x00]);
}

/**
 * CONNECT to a DOMAIN (address type 3), never to an IP we resolved ourselves.
 *
 * Letting the proxy resolve the name is the whole point on this network — the
 * router's DNS is one of the two things that is broken.
 */
function connectRequest(host, port) {
  const name = Buffer.from(host, 'utf8');
  if (name.length > 255) throw new Error(`host too long for SOCKS5: ${host}`);
  return Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
    name,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]);
}

const SOCKS_ERRORS = {
  0x01: 'general SOCKS server failure',
  0x02: 'connection not allowed by ruleset',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported',
};

/**
 * How long a CONNECT reply is, given its address type — or 0 when the buffer
 * does not hold the whole thing yet.
 *
 * The reply is `VER REP RSV ATYP BND.ADDR BND.PORT`, and BND.ADDR is
 * variable-length, so this has to be counted rather than assumed.
 */
function replyLength(buf) {
  if (buf.length < 5) return 0;
  const atyp = buf[3];
  const addr = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? 1 + buf[4] : -1;
  if (addr < 0) return -1; // unknown address type: unrecoverable
  const total = 4 + addr + 2;
  return buf.length >= total ? total : 0;
}

/** Read from a socket until `isDone(buffer)` says the frame is complete. */
function readFrame(socket, isDone) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let verdict;
      try {
        verdict = isDone(buf);
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      if (verdict > 0) {
        cleanup();
        resolve(buf.subarray(0, verdict));
      } else if (verdict < 0) {
        cleanup();
        reject(new Error('proxy sent a reply this client cannot read'));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('proxy closed the connection during the handshake'));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    function cleanup() {
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('error', onError);
    }
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
  });
}

/** A raw TCP socket to `host:port`, tunnelled through a SOCKS5 proxy. */
async function socks5Socket(proxy, host, port) {
  const socket = net.connect({ host: proxy.host, port: proxy.port });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  socket.write(greeting());
  const method = await readFrame(socket, (b) => (b.length >= 2 ? 2 : 0));
  if (method[0] !== 0x05 || method[1] !== 0x00) {
    socket.destroy();
    throw new Error(
      method[1] === 0xff
        ? 'SOCKS5 proxy rejected "no authentication" — this client cannot log in'
        : `SOCKS5 proxy answered an unexpected method (${method[1]})`
    );
  }

  socket.write(connectRequest(host, port));
  const reply = await readFrame(socket, replyLength);
  if (reply[1] !== 0x00) {
    socket.destroy();
    throw new Error(
      `SOCKS5 proxy could not reach ${host}:${port} — ${SOCKS_ERRORS[reply[1]] || `code ${reply[1]}`}`
    );
  }
  return socket;
}

// ── HTTP CONNECT ─────────────────────────────────────────────────────────────

/** A raw TCP socket to `host:port` through an HTTP proxy's CONNECT method. */
function connectSocket(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
      ...(proxy.auth
        ? {
            headers: {
              Host: `${host}:${port}`,
              'Proxy-Authorization':
                'Basic ' +
                Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`).toString('base64'),
            },
          }
        : {}),
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy refused CONNECT ${host}:${port} — HTTP ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.once('error', reject);
    req.end();
  });
}

// ── The request itself ───────────────────────────────────────────────────────

/**
 * An https.Agent that hands back a socket somebody else built.
 *
 * `https.Agent#createConnection` is expected to return a TLS socket, so the
 * TLS handshake happens here, on top of the tunnel, with `servername` set from
 * the request — without it the CDN in front of these datasets answers a
 * different site's certificate.
 */
class TunnelAgent extends https.Agent {
  constructor(proxy) {
    super({ keepAlive: false, maxSockets: 1 });
    this.proxy = proxy;
  }

  createConnection(options, callback) {
    const host = options.host;
    const port = Number(options.port) || 443;
    const tunnel =
      this.proxy.kind === 'socks5'
        ? socks5Socket(this.proxy, host, port)
        : connectSocket(this.proxy, host, port);

    tunnel.then((socket) => {
      const secure = tls.connect({
        socket,
        servername: host,
        ALPNProtocols: ['http/1.1'],
      });
      secure.once('secureConnect', () => callback(null, secure));
      secure.once('error', (err) => callback(err));
    }, callback);
  }
}

/**
 * GET a URL through the configured proxy.
 *
 * Returns the same three things the caller needs from a `fetch` Response —
 * `{ ok, status, text }` — and rejects on a transport failure, so
 * http.js can classify it exactly as it classifies fetch's.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.headers]
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 */
function request(url, { headers = {}, timeoutMs = 20000, signal = null } = {}) {
  const proxy = configured();
  if (!proxy) throw new Error('no OUTSIDE_HTTP_PROXY is configured');

  const target = new URL(url);
  if (target.protocol !== 'https:') {
    throw new Error(`OUTSIDE_HTTP_PROXY only proxies https URLs (got ${target.protocol})`);
  }

  return new Promise((resolve, reject) => {
    const agent = new TunnelAgent(proxy);
    const req = https.request(
      {
        agent,
        host: target.hostname,
        port: Number(target.port) || 443,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { Host: target.hostname, ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          agent.destroy();
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text,
          });
        });
      }
    );

    const fail = (err) => {
      agent.destroy();
      req.destroy();
      reject(err);
    };
    req.once('error', fail);
    req.once('timeout', () => fail(Object.assign(new Error('proxied request timed out'), { name: 'TimeoutError' })));
    if (signal) {
      if (signal.aborted) return fail(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      signal.addEventListener(
        'abort',
        () => fail(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true }
      );
    }
    req.end();
  });
}

/** One line for a log: what the sources are going through, if anything. */
function describe() {
  const proxy = configured();
  if (!proxy) return null;
  return `${proxy.kind === 'socks5' ? 'SOCKS5' : 'HTTP CONNECT'} proxy ${proxy.host}:${proxy.port}`;
}

module.exports = {
  enabled,
  request,
  describe,
  // exported for tests / tuning
  parseProxy,
  greeting,
  connectRequest,
  replyLength,
  SOCKS_ERRORS,
};
