// Offline-first core: local report lifecycle + the sync engine.
// No DOM and no globals, so it runs unchanged in the browser and in the Node tests.
import { validateReport } from '../../shared/domain.js';

export const SYNC = { LOCAL: 'local', PENDING: 'pending', SYNCING: 'syncing', SYNCED: 'synced', FAILED: 'failed' };
export const MAX_SERVER_ERROR_ATTEMPTS = 5;
const MAX_ACTIVITY = 100;

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function logActivity(report, type, message, at = new Date().toISOString()) {
  report.activity = [...(report.activity || []), { at, type, message }].slice(-MAX_ACTIVITY);
}

// What we send to the server. Never includes local-only bookkeeping.
export const toPayload = (r) => ({
  id: r.id, category: r.category, description: r.description, location: r.location,
  priority: r.priority, status: r.status, reportedAt: r.reportedAt,
});

// Create a report on the device. Throws {fields} if invalid. `submit:false` keeps it as a local draft.
export async function createLocalReport(store, form, { submit, now = () => new Date().toISOString(), id = newId() } = {}) {
  const at = now();
  const candidate = { ...form, id, status: submit ? 'Submitted' : 'Draft', reportedAt: at };
  const { errors, value } = validateReport(candidate, { now: Date.parse(at) });
  if (Object.keys(errors).length) throw Object.assign(new Error('Report is not valid.'), { fields: errors });
  const report = {
    ...value, version: 0, origin: 'local', updatedAt: at,
    syncState: submit ? SYNC.PENDING : SYNC.LOCAL, attempts: 0, lastError: null, activity: [],
  };
  logActivity(report, 'created', submit ? 'Saved on this device. Waiting to sync.' : 'Saved as a draft on this device.', at);
  await store.put(report);
  return report;
}

// Edit a report that the server has never accepted (draft / pending / failed).
export async function editUnsyncedReport(store, id, changes, { now = () => new Date().toISOString() } = {}) {
  const r = await store.get(id);
  if (!r) throw new Error('Report not found.');
  if (r.syncState === SYNC.SYNCED || r.syncState === SYNC.SYNCING) throw new Error('This report has already reached the server.');
  const picked = {};
  for (const k of ['category', 'description', 'location', 'priority']) if (changes[k] !== undefined) picked[k] = changes[k];
  const { errors, value } = validateReport(picked, { partial: true });
  if (Object.keys(errors).length) throw Object.assign(new Error('Report is not valid.'), { fields: errors });
  Object.assign(r, value, { updatedAt: now() });
  logActivity(r, 'edited', 'Edited on this device before syncing.', r.updatedAt);
  if (r.syncState === SYNC.FAILED) { r.syncState = SYNC.PENDING; r.attempts = 0; r.lastError = null; logActivity(r, 'retry', 'Fixed after a failure; queued to sync again.', r.updatedAt); }
  await store.put(r);
  return r;
}

export async function submitDraft(store, id, { now = () => new Date().toISOString() } = {}) {
  const r = await store.get(id);
  if (!r || r.syncState !== SYNC.LOCAL || r.status !== 'Draft') throw new Error('Only a local draft can be submitted.');
  const at = now();
  Object.assign(r, { status: 'Submitted', syncState: SYNC.PENDING, updatedAt: at, reportedAt: at });
  logActivity(r, 'status_changed', 'Draft submitted. Waiting to sync.', at);
  await store.put(r);
  return r;
}

// Fold the server's list into local storage without clobbering unsynced work.
export async function mergeServerReports(store, serverReports, { now = () => new Date().toISOString() } = {}) {
  const byId = new Map(serverReports.map((s) => [s.id, s]));
  const locals = new Map((await store.all()).map((r) => [r.id, r]));
  for (const s of serverReports) {
    const local = locals.get(s.id);
    if (local && local.syncState !== SYNC.SYNCED) continue; // unsynced local state wins until it syncs
    const merged = { ...(local || { activity: [], attempts: 0, lastError: null }), ...s, origin: local?.origin || 'server', syncState: SYNC.SYNCED };
    if (local && local.version !== s.version && local.status !== s.status) {
      logActivity(merged, 'status_changed', `Server update: now "${s.status}".`, now());
    }
    await store.put(merged);
  }
  // A report we created and believed was synced, but the server doesn't have: re-queue it
  // rather than let it vanish. Safe because creates are idempotent.
  for (const r of locals.values()) {
    if (r.syncState === SYNC.SYNCED && r.origin === 'local' && !byId.has(r.id)) {
      r.syncState = SYNC.PENDING;
      logActivity(r, 'retry', 'Not found on the server; queued to sync again.', now());
      await store.put(r);
    }
  }
}

export function createSyncEngine({ store, api, now = () => new Date().toISOString(), onChange = () => {} }) {
  let running = null;

  // Called on startup: anything left "syncing" means the app closed mid-request.
  async function recoverInterrupted() {
    let n = 0;
    for (const r of await store.all()) {
      if (r.syncState === SYNC.SYNCING) {
        r.syncState = SYNC.PENDING;
        logActivity(r, 'retry', 'Sync was interrupted; will retry.', now());
        await store.put(r);
        n += 1;
      }
    }
    if (n) onChange();
    return n;
  }

  async function syncOne(r) {
    r.syncState = SYNC.SYNCING;
    r.lastAttemptAt = now();
    await store.put(r);
    onChange();
    try {
      const res = await api.createReport(toPayload(r));
      Object.assign(r, res.report, { syncState: SYNC.SYNCED, attempts: 0, lastError: null, origin: 'local' });
      logActivity(r, 'synced', res.duplicate ? 'Synchronized (server already had this report; retry was deduplicated).' : 'Synchronized with the server.', now());
      if (res.possibleDuplicateOf) logActivity(r, 'duplicate_suspected', `Server flagged it as similar to report ${res.possibleDuplicateOf}.`, now());
      await store.put(r);
      return 'synced';
    } catch (e) {
      r.attempts = (r.attempts || 0) + 1;
      r.lastError = e.message;
      if (e.network) {
        // No connectivity is not a failure of the report. Keep it pending and stop the run.
        r.syncState = SYNC.PENDING;
        r.attempts -= 1;
        // Repeated offline retries would flood the log; record the first one only.
        const msg = `Sync attempt did not reach the server: ${e.message}`;
        if ((r.activity || []).at(-1)?.message !== msg) logActivity(r, 'error', msg, now());
        await store.put(r);
        return 'offline';
      }
      const retryable = e.status >= 500 || e.status === 408 || e.status === 429;
      if (retryable && r.attempts < MAX_SERVER_ERROR_ATTEMPTS) {
        r.syncState = SYNC.PENDING;
        logActivity(r, 'error', `Server error (${e.status}); attempt ${r.attempts} of ${MAX_SERVER_ERROR_ATTEMPTS}.`, now());
        await store.put(r);
        return 'retry';
      }
      r.syncState = SYNC.FAILED;
      const detail = e.fields ? ' ' + Object.values(e.fields).join(' ') : '';
      r.lastError = e.message + detail;
      logActivity(r, 'error', `Sync failed: ${r.lastError}`, now());
      await store.put(r);
      return 'failed';
    } finally {
      onChange();
    }
  }

  // One run at a time: concurrent triggers (online event + timer + button) share the same promise.
  function run() {
    if (running) return running;
    running = (async () => {
      const summary = { synced: 0, failed: 0, retry: 0, offline: false };
      const queue = (await store.all()).filter((r) => r.syncState === SYNC.PENDING).sort((a, b) => a.reportedAt.localeCompare(b.reportedAt));
      for (const r of queue) {
        const out = await syncOne(r);
        if (out === 'synced') summary.synced += 1;
        else if (out === 'failed') summary.failed += 1;
        else if (out === 'retry') summary.retry += 1;
        else if (out === 'offline') { summary.offline = true; break; }
      }
      return summary;
    })().finally(() => { running = null; });
    return running;
  }

  async function retry(id) {
    const r = await store.get(id);
    if (!r || r.syncState !== SYNC.FAILED) return null;
    r.syncState = SYNC.PENDING;
    r.attempts = 0;
    logActivity(r, 'retry', 'Manual retry requested.', now());
    await store.put(r);
    onChange();
    return run();
  }

  return { run, retry, recoverInterrupted };
}
