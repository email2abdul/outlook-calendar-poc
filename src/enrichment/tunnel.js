'use strict';

const net = require('node:net');
const { execFile } = require('node:child_process');
const proxy = require('./proxy');

/**
 * Bring the local SOCKS tunnel up by itself, so nobody has to remember a command.
 *
 * ./proxy.js can USE a tunnel; this module makes sure one is actually there.
 * The reason is a real morning: `data.cms.gov` is geo-blocked from the
 * developer's network (Akamai 403 to an Indian IP — 200 from the deployment
 * box), so `OUTSIDE_HTTP_PROXY=socks5://127.0.0.1:1080` was added to `.env`.
 * That works right up to the moment the `ssh -D` behind port 1080 dies — a
 * laptop sleeping, Wi-Fi changing, a reboot — and then every outside lookup
 * fails again, silently as far as the rep is concerned, until somebody
 * remembers to run the ssh command by hand.
 *
 * So the server asks for it at boot (server.js) and `enrich:doctor` asks for it
 * too. Both get the same three answers and nothing else:
 *
 *   'off'          no LOCAL proxy is configured — nothing to manage. This is
 *                  the deployed server's state: it reaches CMS directly, and
 *                  a machine with no OUTSIDE_HTTP_PROXY must behave exactly as
 *                  it did before this file existed.
 *   'up'           the port already answers (usually the launchd agent, which
 *                  revives it in about a second on its own).
 *   'started'      it was down, and this module started it.
 *   'unavailable'  it is down and could not be started — reported as one line
 *                  saying what to set, never as a crash and never as silence.
 *
 * ── Two ways to start it, in this order ─────────────────────────────────────
 *   1. a launchd agent (macOS), when its label is loaded: kickstart it. This is
 *      preferred because that agent OWNS the port — it has KeepAlive, so
 *      spawning a competing ssh would take :1080 from under it and leave it
 *      retrying against ExitOnForwardFailure every 10 seconds, forever.
 *   2. `OUTSIDE_HTTP_PROXY_SSH=user@host` (or an ssh_config alias): spawn
 *      `ssh -f -N -D <port> <target>`. This is the portable path — a fresh
 *      clone on any machine with ssh access needs nothing but that one
 *      variable, no plist, no autossh.
 *
 * Deliberately NOT done here: writing a launchd plist, editing ~/.ssh/config,
 * or installing anything. A server process that quietly installs a background
 * agent is a surprise; this one only ever starts a tunnel the machine's owner
 * has already asked for by setting the variable.
 */

/** A proxy on one of these is ours to start; anything else belongs to someone else. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const DEFAULT_LABEL = 'com.bis.cms-tunnel';

/**
 * The tunnel this machine is configured to use, or null.
 *
 * Null covers three different situations that all mean "do nothing": no
 * OUTSIDE_HTTP_PROXY (the deployed server), a malformed one (proxy.js reports
 * that on the request itself — this module must not be the thing that crashes
 * a boot over a typo), and a proxy on a remote host, which is a shared piece
 * of infrastructure and not a process to be kickstarted from here.
 */
function local() {
  let parsed;
  try {
    parsed = proxy.parseProxy(process.env.OUTSIDE_HTTP_PROXY);
  } catch {
    return null;
  }
  if (!parsed) return null;
  if (!LOOPBACK.has(parsed.host)) return null;
  return { host: parsed.host, port: parsed.port, kind: parsed.kind };
}

/** Does something answer on the proxy port right now? */
function listening({ host, port }, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll the port until it answers, or give up. */
async function waitForPort(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  // The first check is immediate: a launchd kickstart is often done already.
  for (;;) {
    if (await listening(target, 1000)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

/** Run a command, resolving `{ ok, stdout, stderr }` — never rejecting. */
function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });
}

function launchdLabel() {
  return String(process.env.OUTSIDE_TUNNEL_LAUNCHD_LABEL || DEFAULT_LABEL).trim();
}

/** Is a launchd agent by that label loaded for this user? (macOS only.) */
async function launchdLoaded() {
  if (process.platform !== 'darwin') return false;
  const label = launchdLabel();
  if (!label) return false;
  const res = await run('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], 4000);
  return res.ok;
}

/** Ask launchd to (re)start its tunnel agent. */
async function kickstartLaunchd() {
  const res = await run(
    '/bin/launchctl',
    ['kickstart', '-k', `gui/${process.getuid()}/${launchdLabel()}`],
    6000
  );
  return res.ok;
}

/**
 * Start the tunnel ourselves.
 *
 * `-f` backgrounds ssh and exits, so there is no child process for this app to
 * babysit and no handle keeping `node --watch` alive; `ExitOnForwardFailure`
 * means a failure to bind the port is an ssh failure rather than a live
 * connection that forwards nothing; `BatchMode` means a machine with no usable
 * key fails in a second instead of hanging on a password prompt.
 */
async function startSsh(target, { host, port }) {
  const res = await run(
    '/usr/bin/ssh',
    [
      '-f', '-N', '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-D', `${host}:${port}`,
      target,
    ],
    15000
  );
  return res;
}

/** The one-line summary a log or the doctor prints. */
function line(result) {
  const { state, detail } = result;
  if (state === 'off') return null;
  const where = `${result.target.host}:${result.target.port}`;
  if (state === 'up') return `[tunnel] SOCKS proxy already up on ${where}`;
  if (state === 'started') return `[tunnel] started the SOCKS proxy on ${where} (${detail})`;
  return `[tunnel] ⚠️  no SOCKS proxy on ${where} — ${detail}`;
}

/**
 * Make sure the configured local tunnel is up, starting it if it is not.
 *
 * Never throws and never exits: an outside lookup with no tunnel already
 * reports "could not be read" rather than "this physician does not exist"
 * (src/enrichment/health.js), which is the honest failure. This function's job
 * is to make that case rare, not to make it fatal.
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000] how long to wait for the port
 * @returns {Promise<{state:'off'|'up'|'started'|'unavailable', detail:string|null,
 *                    target:{host,port}|null, line:string|null}>}
 */
async function ensure({ timeoutMs = 10000 } = {}) {
  const target = local();
  if (!target) return { state: 'off', detail: null, target: null, line: null };

  const finish = (state, detail) => {
    const result = { state, detail, target };
    return { ...result, line: line(result) };
  };

  try {
    if (await listening(target)) return finish('up', null);

    if (await launchdLoaded()) {
      await kickstartLaunchd();
      if (await waitForPort(target, timeoutMs)) return finish('started', `launchd ${launchdLabel()}`);
    }

    const sshTarget = String(process.env.OUTSIDE_HTTP_PROXY_SSH || '').trim();
    if (sshTarget) {
      const res = await startSsh(sshTarget, target);
      if (await waitForPort(target, timeoutMs)) return finish('started', `ssh -D ${sshTarget}`);
      const why = res.stderr.trim().split('\n').pop() || 'ssh did not open the port';
      return finish('unavailable', `ssh ${sshTarget} failed: ${why}`);
    }

    return finish(
      'unavailable',
      'set OUTSIDE_HTTP_PROXY_SSH=user@host in .env so it can be started automatically, ' +
        `or open it by hand: ssh -f -N -D ${target.port} user@host`
    );
  } catch (err) {
    // A broken launchctl, a missing ssh binary, an odd platform: all of it is a
    // tunnel that is not up, which the caller already knows how to say.
    return finish('unavailable', `could not be started (${err?.message || err})`);
  }
}

module.exports = {
  ensure,
  local,
  listening,
  waitForPort,
  launchdLabel,
  // exported for tests
  line,
  LOOPBACK,
  DEFAULT_LABEL,
};
