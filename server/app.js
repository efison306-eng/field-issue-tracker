import { readFile } from 'node:fs/promises';
import { join, normalize, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateReport,
  checkTransition,
  allowedTransitions,
  fingerprint,
  EDITABLE_STATUSES,
  STATUSES,
  ROLES,
} from '../shared/domain.js';
import { addHistory, toEvent, toReport, tx } from './db.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAX_BODY = 100 * 1024;
const DUP_WINDOW_MS = 24 * 60 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    // Keep draining an oversized body (discarding it) so the client receives a clean 413
    // instead of a reset connection.
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'payload_too_large', 'Request body is too large.'));
      if (!chunks.length) return resolveBody({});
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid_json', 'Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

// Roles are simulated (no authentication): the client sends X-Role and X-Actor.
// An unknown role falls back to the least-privileged one.
function identity(req) {
  const role = ROLES.includes(req.headers['x-role']) ? req.headers['x-role'] : 'worker';
  const raw = String(req.headers['x-actor'] || '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40);
  return { role, actor: raw || role };
}

export function createApp(db, { now = () => new Date(), publicDir = join(ROOT, 'public'), sharedDir = join(ROOT, 'shared') } = {}) {
  const iso = () => now().toISOString();
  const getRow = (id) => db.prepare('SELECT * FROM reports WHERE id = ?').get(id);

  function logError(reportId, actor, message, detail) {
    try {
      addHistory(db, reportId, 'error', actor, message, detail, iso());
    } catch {
      /* logging must never mask the real error */
    }
  }

  // POST /api/reports  — idempotent create keyed by the client-generated id.
  async function createReport(req) {
    const { actor } = identity(req);
    const body = await readJson(req);
    const { errors, value } = validateReport(body);
    if (value.status === 'Draft') errors.status = 'Drafts are local-only; submit the report before syncing.';
    else if (value.status && value.status !== 'Submitted') errors.status = 'A new report must be created as "Submitted".';
    if (Object.keys(errors).length) {
      if (typeof body?.id === 'string' && !errors.id) {
        logError(body.id, actor, 'Create rejected: validation failed', { errors });
      }
      throw new HttpError(422, 'validation_failed', 'Report failed validation.', { fields: errors });
    }

    const existing = getRow(value.id);
    if (existing) {
      // A retry of a request we already processed. Return what we stored; never create a second row.
      addHistory(db, value.id, 'duplicate_retry', actor, 'Sync retry received for an already-stored report; ignored.', null, iso());
      return { status: 200, body: { report: toReport(getRow(value.id)), duplicate: true } };
    }

    const fp = fingerprint(value);
    const t = Date.parse(value.reportedAt);
    const near = db
      .prepare('SELECT id, reported_at FROM reports WHERE fingerprint = ? ORDER BY reported_at DESC')
      .all(fp)
      .find((r) => Math.abs(Date.parse(r.reported_at) - t) <= DUP_WINDOW_MS);

    const stamp = iso();
    tx(db, () => {
      db.prepare(
        `INSERT INTO reports (id, category, description, location, priority, status, reported_at, received_at, updated_at, version, created_by, fingerprint)
         VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
      ).run(value.id, value.category, value.description, value.location, value.priority, 'Submitted', value.reportedAt, stamp, stamp, actor, fp);
      addHistory(db, value.id, 'created', actor, `Report created (filed ${value.reportedAt}, received ${stamp}).`, null, stamp);
      if (near) {
        addHistory(db, value.id, 'duplicate_suspected', 'system', `Looks similar to report ${near.id}. Kept as a separate record for a coordinator to review.`, { similarTo: near.id }, stamp);
      }
    });
    return { status: 201, body: { report: toReport(getRow(value.id)), duplicate: false, possibleDuplicateOf: near?.id ?? null } };
  }

  // PATCH /api/reports/:id — edit content after submission (optimistic concurrency).
  async function editReport(req, id) {
    const { actor } = identity(req);
    const body = await readJson(req);
    const row = getRow(id);
    if (!row) throw new HttpError(404, 'not_found', 'Report not found.');
    const { baseVersion, ...fields } = body;
    if (!Number.isInteger(baseVersion)) {
      throw new HttpError(422, 'validation_failed', 'baseVersion (integer) is required.', { fields: { baseVersion: 'required' } });
    }
    const allowedKeys = ['category', 'description', 'location', 'priority'];
    const unknown = Object.keys(fields).filter((k) => !allowedKeys.includes(k));
    const picked = Object.fromEntries(allowedKeys.filter((k) => fields[k] !== undefined).map((k) => [k, fields[k]]));
    const { errors, value } = validateReport(picked, { partial: true });
    if (unknown.length) errors._ = `Fields cannot be edited: ${unknown.join(', ')}.`;
    if (!Object.keys(picked).length && !unknown.length) errors._ = 'Nothing to update.';
    if (Object.keys(errors).length) throw new HttpError(422, 'validation_failed', 'Edit failed validation.', { fields: errors });

    if (!EDITABLE_STATUSES.includes(row.status)) {
      logError(id, actor, `Edit refused: report is "${row.status}"`);
      throw new HttpError(409, 'not_editable', `A report that is "${row.status}" can no longer be edited.`, { current: toReport(row) });
    }
    if (row.version !== baseVersion) {
      logError(id, actor, `Edit refused: stale version ${baseVersion} (current ${row.version})`);
      throw new HttpError(409, 'version_conflict', 'The report changed on the server since you loaded it.', { current: toReport(row) });
    }

    const changes = Object.keys(value).filter((k) => value[k] !== toReport(row)[k]);
    if (!changes.length) return { status: 200, body: { report: toReport(row), changed: [] } };

    const merged = { ...toReport(row), ...value };
    const stamp = iso();
    tx(db, () => {
      db.prepare('UPDATE reports SET category=?, description=?, location=?, priority=?, updated_at=?, version=version+1, fingerprint=? WHERE id=?')
        .run(merged.category, merged.description, merged.location, merged.priority, stamp, fingerprint(merged), id);
      const before = Object.fromEntries(changes.map((k) => [k, toReport(row)[k]]));
      const after = Object.fromEntries(changes.map((k) => [k, value[k]]));
      addHistory(db, id, 'edited', actor, `Edited: ${changes.join(', ')}.`, { before, after }, stamp);
    });
    return { status: 200, body: { report: toReport(getRow(id)), changed: changes } };
  }

  // POST /api/reports/:id/status — workflow transitions.
  async function changeStatus(req, id) {
    const { role, actor } = identity(req);
    const body = await readJson(req);
    const row = getRow(id);
    if (!row) throw new HttpError(404, 'not_found', 'Report not found.');
    const { status: to, note, expectedStatus } = body;
    if (typeof to !== 'string' || !STATUSES.includes(to)) {
      throw new HttpError(422, 'validation_failed', 'status is required and must be a known status.', { fields: { status: 'invalid' } });
    }
    if (note !== undefined && (typeof note !== 'string' || note.length > 500)) {
      throw new HttpError(422, 'validation_failed', 'note must be a string of at most 500 characters.', { fields: { note: 'invalid' } });
    }
    // The caller's view of the report is out of date (e.g. someone else already moved it).
    if (expectedStatus !== undefined && expectedStatus !== row.status) {
      logError(id, actor, `Status change to "${to}" refused: caller expected "${expectedStatus}" but report is "${row.status}"`);
      throw new HttpError(409, 'stale_status', `The report is now "${row.status}", not "${expectedStatus}".`, { current: toReport(row), allowed: allowedTransitions(row.status, role) });
    }
    const check = checkTransition(row.status, to, role, note);
    if (!check.ok) {
      logError(id, actor, `Status change "${row.status}" -> "${to}" refused: ${check.code}`, { role });
      const status = check.code === 'forbidden_transition' ? 403 : check.code === 'note_required' || check.code === 'invalid_status' ? 422 : 409;
      throw new HttpError(status, check.code, check.message, { allowed: check.allowed, current: toReport(row) });
    }
    const stamp = iso();
    tx(db, () => {
      db.prepare('UPDATE reports SET status=?, updated_at=?, version=version+1 WHERE id=?').run(to, stamp, id);
      addHistory(db, id, 'status_changed', actor, `Status: ${row.status} -> ${to}${note?.trim() ? ` ("${note.trim()}")` : ''}.`, { from: row.status, to, note: note?.trim() || null, role }, stamp);
    });
    return { status: 200, body: { report: toReport(getRow(id)) } };
  }

  async function serveStatic(req, res, pathname) {
    let base = publicDir;
    let rel = pathname;
    if (pathname.startsWith('/shared/')) {
      base = sharedDir;
      rel = pathname.slice('/shared'.length);
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = normalize(join(base, rel));
    if (full !== base && !full.startsWith(base + sep)) throw new HttpError(403, 'forbidden', 'Forbidden.');
    try {
      const data = await readFile(full);
      const ext = extname(full);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        // The service worker and shell must always revalidate so updates roll out.
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') throw new HttpError(404, 'not_found', 'Not found.');
      throw e;
    }
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const m = req.method;

      if (!path.startsWith('/api')) {
        if (m !== 'GET' && m !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
        return await serveStatic(req, res, decodeURIComponent(path));
      }

      if (path === '/api/health' && m === 'GET') return send(res, 200, { ok: true, time: iso() });

      if (path === '/api/reports' && m === 'GET') {
        const status = url.searchParams.get('status');
        if (status && !STATUSES.includes(status)) throw new HttpError(422, 'validation_failed', 'Unknown status filter.');
        const rows = status
          ? db.prepare('SELECT * FROM reports WHERE status = ? ORDER BY updated_at DESC').all(status)
          : db.prepare('SELECT * FROM reports ORDER BY updated_at DESC').all();
        return send(res, 200, { reports: rows.map(toReport) });
      }
      if (path === '/api/reports' && m === 'POST') {
        const out = await createReport(req);
        return send(res, out.status, out.body);
      }

      const one = path.match(/^\/api\/reports\/([A-Za-z0-9_-]{1,64})(\/history|\/status)?$/);
      if (one) {
        const [, id, sub] = one;
        if (!sub && m === 'GET') {
          const row = getRow(id);
          if (!row) throw new HttpError(404, 'not_found', 'Report not found.');
          return send(res, 200, { report: toReport(row) });
        }
        if (!sub && m === 'PATCH') {
          const out = await editReport(req, id);
          return send(res, out.status, out.body);
        }
        if (sub === '/status' && m === 'POST') {
          const out = await changeStatus(req, id);
          return send(res, out.status, out.body);
        }
        if (sub === '/history' && m === 'GET') {
          const rows = db.prepare('SELECT * FROM history WHERE report_id = ? ORDER BY seq').all(id);
          return send(res, 200, { history: rows.map(toEvent) });
        }
      }
      throw new HttpError(path.startsWith('/api/reports') ? 405 : 404, 'not_found', 'No such endpoint.');
    } catch (err) {
      if (err instanceof HttpError) {
        return send(res, err.status, { error: { code: err.code, message: err.message, ...err.extra } });
      }
      console.error(err);
      return send(res, 500, { error: { code: 'internal_error', message: 'Unexpected server error.' } });
    }
  };
}
