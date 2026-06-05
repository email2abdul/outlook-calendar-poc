'use strict';

const path = require('path');
const Database = require('better-sqlite3');

/**
 * Call notes (MOM) store — one row per note, keyed to a physician (NPI) and
 * the organizer who wrote it, so every salesperson keeps their own history
 * with each physician. SQLite keeps this dependency-free, same as the
 * session store.
 */

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

function rowToNote(r) {
  if (!r) return null;
  return {
    id: r.id,
    npi: r.physician_npi,
    eventId: r.event_id,
    meetingDate: r.meeting_date,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const insertStmt = db.prepare(`
  INSERT INTO call_notes
    (physician_npi, organizer_email, event_id, meeting_date, notes, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const byIdStmt = db.prepare('SELECT * FROM call_notes WHERE id = ?');

// Newest first; prefer the meeting's own date, fall back to when it was written.
const listStmt = db.prepare(`
  SELECT * FROM call_notes
  WHERE physician_npi = ? AND organizer_email = ?
  ORDER BY COALESCE(meeting_date, substr(created_at, 1, 10)) DESC, id DESC
  LIMIT ?
`);

/** Save a new note. Returns the stored note. */
function addNote({ npi, organizerEmail, eventId, meetingDate, notes }) {
  const now = new Date().toISOString();
  const info = insertStmt.run(
    String(npi),
    String(organizerEmail).toLowerCase(),
    eventId || null,
    meetingDate || null,
    notes,
    now,
    now
  );
  return rowToNote(byIdStmt.get(info.lastInsertRowid));
}

/** This organizer's notes for one physician, newest first. */
function getNotes(npi, organizerEmail, limit = 20) {
  if (!organizerEmail) return [];
  return listStmt.all(String(npi), String(organizerEmail).toLowerCase(), limit).map(rowToNote);
}

/** Most recent note for this organizer + physician, or null. */
function getLatestNote(npi, organizerEmail) {
  return getNotes(npi, organizerEmail, 1)[0] || null;
}

module.exports = { addNote, getNotes, getLatestNote };
