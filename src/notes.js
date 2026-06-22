'use strict';

const path = require('path');
const redis = require('./redis');

/**
 * Meeting notes store — one entry per note, keyed to a physician (NPI) and
 * the organizer who wrote it, so every salesperson keeps their own history
 * with each physician.
 *
 * Two interchangeable backends behind one async API:
 *  - SQLite (default) — dependency-free local file, same as the session store.
 *  - Redis — when REDIS_URL/KV_URL is set (serverless hosts like Vercel,
 *    where local files don't persist between invocations).
 *
 * Note shape (both backends): { id, npi, eventId, meetingDate, notes,
 * createdAt, updatedAt }.
 */

// Newest first; prefer the meeting's own date, fall back to when it was written.
const sortDate = (n) => n.meetingDate || (n.createdAt || '').slice(0, 10);

function createSqliteStore() {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(__dirname, '..', 'data', 'notes.db'));

  db.exec(`
    CREATE TABLE IF NOT EXISTS call_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      physician_npi TEXT NOT NULL,
      organizer_email TEXT NOT NULL,
      event_id TEXT,
      meeting_date TEXT,
      notes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_call_notes_npi_organizer
      ON call_notes (physician_npi, organizer_email);
  `);

  // 'human' (default) vs 'ai' (extracted from an email reply). Added via ALTER
  // so existing note databases upgrade in place.
  try {
    db.exec(`ALTER TABLE call_notes ADD COLUMN source TEXT NOT NULL DEFAULT 'human'`);
  } catch {
    /* column already exists */
  }

  function rowToNote(r) {
    if (!r) return null;
    return {
      id: r.id,
      npi: r.physician_npi,
      eventId: r.event_id,
      meetingDate: r.meeting_date,
      notes: r.notes,
      source: r.source || 'human',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  const insertStmt = db.prepare(`
    INSERT INTO call_notes
      (physician_npi, organizer_email, event_id, meeting_date, notes, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const byIdStmt = db.prepare('SELECT * FROM call_notes WHERE id = ?');

  const listStmt = db.prepare(`
    SELECT * FROM call_notes
    WHERE physician_npi = ? AND organizer_email = ?
    ORDER BY COALESCE(meeting_date, substr(created_at, 1, 10)) DESC, id DESC
    LIMIT ?
  `);

  return {
    async addNote({ npi, organizerEmail, eventId, meetingDate, notes, source }) {
      const now = new Date().toISOString();
      const info = insertStmt.run(
        String(npi),
        String(organizerEmail).toLowerCase(),
        eventId || null,
        meetingDate || null,
        notes,
        source || 'human',
        now,
        now
      );
      return rowToNote(byIdStmt.get(info.lastInsertRowid));
    },
    async getNotes(npi, organizerEmail, limit = 20) {
      if (!organizerEmail) return [];
      return listStmt.all(String(npi), String(organizerEmail).toLowerCase(), limit).map(rowToNote);
    },
  };
}

function createRedisStore(client) {
  // Append-only list per (physician, organizer); ids from a global counter.
  const key = (npi, email) => `notes:${npi}:${email}`;

  return {
    async addNote({ npi, organizerEmail, eventId, meetingDate, notes, source }) {
      const now = new Date().toISOString();
      const note = {
        id: await client.incr('notes:next-id'),
        npi: String(npi),
        eventId: eventId || null,
        meetingDate: meetingDate || null,
        notes,
        source: source || 'human',
        createdAt: now,
        updatedAt: now,
      };
      await client.rPush(key(note.npi, String(organizerEmail).toLowerCase()), JSON.stringify(note));
      return note;
    },
    async getNotes(npi, organizerEmail, limit = 20) {
      if (!organizerEmail) return [];
      const raw = await client.lRange(key(String(npi), String(organizerEmail).toLowerCase()), 0, -1);
      return raw
        .map((s) => JSON.parse(s))
        .sort((a, b) => sortDate(b).localeCompare(sortDate(a)) || b.id - a.id)
        .slice(0, limit);
    },
  };
}

const store = redis ? createRedisStore(redis) : createSqliteStore();

/** Save a new note. Returns the stored note. */
const addNote = (note) => store.addNote(note);

/** This organizer's notes for one physician, newest first. */
const getNotes = (npi, organizerEmail, limit) => store.getNotes(npi, organizerEmail, limit);

/** Most recent note for this organizer + physician, or null. */
async function getLatestNote(npi, organizerEmail) {
  return (await store.getNotes(npi, organizerEmail, 1))[0] || null;
}

module.exports = { addNote, getNotes, getLatestNote };
