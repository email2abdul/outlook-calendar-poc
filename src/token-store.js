'use strict';

const path = require('path');
const redis = require('./redis');

/**
 * Per-user persistence that powers background work (the pre-meeting reminder
 * engine):
 *  - each signed-in salesperson's MSAL token cache, keyed by homeAccountId,
 *    so the server can silently refresh tokens and read their calendar / send
 *    mail on their behalf OUTSIDE a request;
 *  - a reminder sent-log, so each meeting gets exactly one reminder.
 *
 * SQLite by default; Redis when REDIS_URL/KV_URL is set — same pattern as the
 * session and notes stores.
 */

const REMINDER_LOG_TTL_DAYS = 14;

function createSqliteStore() {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(__dirname, '..', 'data', 'users.db'));

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      home_account_id TEXT PRIMARY KEY,
      email TEXT,
      name TEXT,
      msal_cache TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reminders_sent (
      user_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (user_id, event_id)
    );
  `);

  const upsert = db.prepare(`
    INSERT INTO users (home_account_id, email, name, msal_cache, updated_at)
    VALUES (@homeAccountId, @email, @name, @msalCache, @now)
    ON CONFLICT(home_account_id) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      msal_cache = excluded.msal_cache,
      updated_at = excluded.updated_at
  `);
  const setCache = db.prepare(
    'UPDATE users SET msal_cache = ?, updated_at = ? WHERE home_account_id = ?'
  );
  const list = db.prepare(
    'SELECT home_account_id AS homeAccountId, email, name, msal_cache AS msalCache FROM users'
  );
  const remGet = db.prepare('SELECT 1 FROM reminders_sent WHERE user_id = ? AND event_id = ?');
  const remPut = db.prepare(
    'INSERT OR IGNORE INTO reminders_sent (user_id, event_id, sent_at) VALUES (?, ?, ?)'
  );
  const remPurge = db.prepare('DELETE FROM reminders_sent WHERE sent_at < ?');

  return {
    async saveUser({ homeAccountId, email, name, msalCache }) {
      upsert.run({
        homeAccountId,
        email: email || null,
        name: name || null,
        msalCache: msalCache || null,
        now: new Date().toISOString(),
      });
    },
    async updateCache(homeAccountId, msalCache) {
      setCache.run(msalCache || null, new Date().toISOString(), homeAccountId);
    },
    async listUsers() {
      return list.all();
    },
    async wasReminderSent(userId, eventId) {
      return Boolean(remGet.get(userId, eventId));
    },
    async markReminderSent(userId, eventId) {
      remPut.run(userId, eventId, new Date().toISOString());
      remPurge.run(new Date(Date.now() - REMINDER_LOG_TTL_DAYS * 86400000).toISOString());
    },
  };
}

function createRedisStore(client) {
  const ukey = (id) => `bisuser:${id}`;
  const rkey = (uid, eid) => `remsent:${uid}:${eid}`;

  return {
    async saveUser({ homeAccountId, email, name, msalCache }) {
      await client.hSet(ukey(homeAccountId), {
        homeAccountId,
        email: email || '',
        name: name || '',
        msalCache: msalCache || '',
      });
      await client.sAdd('bisusers', homeAccountId);
    },
    async updateCache(homeAccountId, msalCache) {
      await client.hSet(ukey(homeAccountId), { msalCache: msalCache || '' });
    },
    async listUsers() {
      const ids = await client.sMembers('bisusers');
      const out = [];
      for (const id of ids) {
        const h = await client.hGetAll(ukey(id));
        if (h?.homeAccountId) out.push(h);
      }
      return out;
    },
    async wasReminderSent(userId, eventId) {
      return Boolean(await client.exists(rkey(userId, eventId)));
    },
    async markReminderSent(userId, eventId) {
      await client.set(rkey(userId, eventId), '1', { EX: REMINDER_LOG_TTL_DAYS * 86400 });
    },
  };
}

module.exports = redis ? createRedisStore(redis) : createSqliteStore();
