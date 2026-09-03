'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Recorded answers from the public sources, replayed from disk.
 *
 * The problem this solves is not speed. The registries these sources read are
 * unreachable from some networks (see ./proxy.js for the measurements), which
 * means the parts of this app that depend on them — the demo page, the probe
 * scripts, an end-to-end run of the panel — could only be exercised from the
 * deployment host. A recorded answer makes them runnable anywhere, and makes
 * them the SAME every time, which a live registry never is.
 *
 * Three env vars, and each one does exactly one thing:
 *
 *   OUTSIDE_HTTP_CACHE_DIR=data/cassettes   where recordings live; setting it
 *                                           turns replay ON
 *   OUTSIDE_HTTP_RECORD=1                   write new recordings as answers
 *                                           come back (needs the dir)
 *   OUTSIDE_HTTP_OFFLINE=1                  never touch the network; a URL with
 *                                           no recording is a failure, loudly
 *
 * Record once from a network (or tunnel) that can reach them:
 *
 *   OUTSIDE_HTTP_CACHE_DIR=data/cassettes OUTSIDE_HTTP_RECORD=1 \
 *   OUTSIDE_HTTP_PROXY=socks5://127.0.0.1:1080 npm run demo:page
 *
 * …then work offline for as long as you like:
 *
 *   OUTSIDE_HTTP_CACHE_DIR=data/cassettes OUTSIDE_HTTP_OFFLINE=1 npm run demo:page
 *
 * ── What is deliberately NOT recorded ───────────────────────────────────────
 * Failures. A cassette of "the registry could not be reached" would replay a
 * network problem as though it were a fact about a physician, which is the one
 * mistake this codebase keeps having to undo. Only a 2xx with a JSON body is
 * written; everything else stays a live question.
 */

/** The directory, or null when replay is off. */
function dir() {
  const raw = String(process.env.OUTSIDE_HTTP_CACHE_DIR || '').trim();
  return raw ? path.resolve(raw) : null;
}

function enabled() {
  return Boolean(dir());
}

function recording() {
  return enabled() && /^(1|true|yes)$/i.test(String(process.env.OUTSIDE_HTTP_RECORD || ''));
}

function offline() {
  return enabled() && /^(1|true|yes)$/i.test(String(process.env.OUTSIDE_HTTP_OFFLINE || ''));
}

/**
 * The file one URL is recorded in.
 *
 * A hash, because these URLs carry filters and 36-character dataset ids and are
 * far too long to be filenames — prefixed with the caller's label so a
 * directory listing still says what is in it ("cms-name-2024-3f9a…json").
 */
function fileFor(url, label = 'http') {
  const home = dir();
  if (!home) return null;
  const safe = String(label).replace(/[^a-z0-9._-]/gi, '-').slice(0, 40);
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
  return path.join(home, `${safe}-${hash}.json`);
}

/**
 * The recorded answer for a URL, or null.
 *
 * A recording that cannot be parsed is treated as absent rather than thrown:
 * a half-written file (an interrupted record run) must not break a replay run.
 */
function read(url, label) {
  const file = fileFor(url, label);
  if (!file) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // no recording for this URL
  }
  try {
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || saved.body === undefined) return null;
    return { status: saved.status || 200, body: saved.body, recordedAt: saved.recordedAt || null };
  } catch {
    console.warn(`[cassettes] ignoring unreadable recording ${path.basename(file)}`);
    return null;
  }
}

/** Record one successful answer. Best-effort: a failed write is not a failed request. */
function write(url, label, { status, body }) {
  const file = fileFor(url, label);
  if (!file || body === null || body === undefined) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify({ url, label, status, recordedAt: new Date().toISOString(), body }, null, 1)}\n`
    );
    return true;
  } catch (err) {
    console.warn(`[cassettes] could not record ${label}: ${err.message}`);
    return false;
  }
}

/** One line for a log: what mode the sources are in, if any. */
function describe() {
  if (!enabled()) return null;
  const mode = offline() ? 'offline replay' : recording() ? 'replay + record' : 'replay';
  return `${mode} from ${path.relative(process.cwd(), dir()) || dir()}`;
}

module.exports = { enabled, recording, offline, read, write, fileFor, dir, describe };
