import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY,          -- generated on the client (UUID) => idempotent creates
  category     TEXT NOT NULL,
  description  TEXT NOT NULL,
  location     TEXT NOT NULL,
  priority     TEXT NOT NULL,
  status       TEXT NOT NULL,
  reported_at  TEXT NOT NULL,             -- when the worker filed it (device clock)
  received_at  TEXT NOT NULL,             -- when the server first stored it
  updated_at   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1, -- bumped on every change; used for optimistic concurrency
  created_by   TEXT NOT NULL,
  fingerprint  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_fp ON reports(fingerprint);

-- Append-only. No foreign key on purpose: a rejected create is still worth recording.
CREATE TABLE IF NOT EXISTS history (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id  TEXT NOT NULL,
  at         TEXT NOT NULL,
  type       TEXT NOT NULL,   -- created | edited | status_changed | duplicate_retry | duplicate_suspected | error
  actor      TEXT NOT NULL,
  message    TEXT NOT NULL,
  detail     TEXT             -- JSON
);
CREATE INDEX IF NOT EXISTS idx_history_report ON history(report_id, seq);
`;

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const toReport = (r) =>
  r && {
    id: r.id,
    category: r.category,
    description: r.description,
    location: r.location,
    priority: r.priority,
    status: r.status,
    reportedAt: r.reported_at,
    receivedAt: r.received_at,
    updatedAt: r.updated_at,
    version: r.version,
    createdBy: r.created_by,
  };

export const toEvent = (h) => ({
  seq: h.seq,
  reportId: h.report_id,
  at: h.at,
  type: h.type,
  actor: h.actor,
  message: h.message,
  detail: h.detail ? JSON.parse(h.detail) : null,
});

export function addHistory(db, reportId, type, actor, message, detail = null, at = new Date().toISOString()) {
  db.prepare('INSERT INTO history (report_id, at, type, actor, message, detail) VALUES (?,?,?,?,?,?)').run(
    reportId,
    at,
    type,
    actor,
    String(message).slice(0, 500),
    detail ? JSON.stringify(detail) : null,
  );
}
