import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../public/js/store.js';
import { ApiError } from '../public/js/api.js';
import { SYNC, createLocalReport, createSyncEngine, editUnsyncedReport, mergeServerReports, submitDraft } from '../public/js/core.js';

const form = (o = {}) => ({ category: 'Water point', description: 'Pump handle is broken.', location: 'Kebele 04', priority: 'High', ...o });

// A fake server that mimics the real one's idempotency, with switchable failure modes.
function fakeApi() {
  const db = new Map();
  const api = {
    mode: 'ok', calls: 0, db,
    async createReport(p) {
      api.calls += 1;
      if (api.mode === 'offline') throw new ApiError('Cannot reach the server.', { network: true });
      if (api.mode === '500') throw new ApiError('boom', { status: 500, code: 'internal_error' });
      if (api.mode === '422') throw new ApiError('Report failed validation.', { status: 422, fields: { location: 'bad location' } });
      if (api.mode === 'lost-response') { db.set(p.id, { ...p, version: 1 }); throw new ApiError('timeout', { network: true }); }
      const dup = db.has(p.id);
      if (!dup) db.set(p.id, { ...p, version: 1 });
      return { report: db.get(p.id), duplicate: dup };
    },
  };
  return api;
}
const setup = () => { const store = createMemoryStore(); const api = fakeApi(); return { store, api, sync: createSyncEngine({ store, api }) }; };

describe('local creation', () => {
  test('saves offline immediately as pending, with an activity entry', async () => {
    const { store } = setup();
    const r = await createLocalReport(store, form(), { submit: true });
    const saved = await store.get(r.id);
    assert.equal(saved.syncState, SYNC.PENDING);
    assert.equal(saved.status, 'Submitted');
    assert.equal(saved.activity[0].type, 'created');
  });

  test('drafts stay local and are never synced', async () => {
    const { store, api, sync } = setup();
    const d = await createLocalReport(store, form(), { submit: false });
    await sync.run();
    assert.equal(api.calls, 0);
    assert.equal((await store.get(d.id)).syncState, SYNC.LOCAL);
    await submitDraft(store, d.id);
    await sync.run();
    assert.equal((await store.get(d.id)).syncState, SYNC.SYNCED);
  });

  test('invalid input is rejected before anything is stored', async () => {
    const { store } = setup();
    await assert.rejects(createLocalReport(store, form({ description: 'no' }), { submit: true }), (e) => !!e.fields.description);
    assert.equal((await store.all()).length, 0);
  });
});

describe('synchronization', () => {
  test('syncs pending reports and records the outcome', async () => {
    const { store, api, sync } = setup();
    const r = await createLocalReport(store, form(), { submit: true });
    const out = await sync.run();
    assert.equal(out.synced, 1);
    const s = await store.get(r.id);
    assert.equal(s.syncState, SYNC.SYNCED);
    assert.equal(s.version, 1);
    assert.ok(s.activity.some((a) => a.type === 'synced'));
    assert.equal(api.db.size, 1);
  });

  test('offline keeps reports pending (never failed, never lost) and stops early', async () => {
    const { store, api, sync } = setup();
    await createLocalReport(store, form(), { submit: true });
    await createLocalReport(store, form({ location: 'Kebele 05' }), { submit: true });
    api.mode = 'offline';
    const out = await sync.run();
    assert.equal(out.offline, true);
    assert.equal(api.calls, 1, 'stops after the first network failure');
    assert.ok((await store.all()).every((r) => r.syncState === SYNC.PENDING));
    api.mode = 'ok';
    assert.equal((await sync.run()).synced, 2);
  });

  test('a lost response does not create a duplicate when retried', async () => {
    const { store, api, sync } = setup();
    const r = await createLocalReport(store, form(), { submit: true });
    api.mode = 'lost-response';
    await sync.run();
    assert.equal((await store.get(r.id)).syncState, SYNC.PENDING);
    api.mode = 'ok';
    await sync.run();
    assert.equal(api.db.size, 1);
    const s = await store.get(r.id);
    assert.equal(s.syncState, SYNC.SYNCED);
    assert.match(s.activity.at(-1).message, /deduplicated/);
  });

  test('a validation rejection becomes Failed with the reason, and can be fixed and retried', async () => {
    const { store, api, sync } = setup();
    const r = await createLocalReport(store, form(), { submit: true });
    api.mode = '422';
    const out = await sync.run();
    assert.equal(out.failed, 1);
    let s = await store.get(r.id);
    assert.equal(s.syncState, SYNC.FAILED);
    assert.match(s.lastError, /bad location/);
    await sync.run();
    assert.equal(api.calls, 1, 'failed reports are not retried automatically');
    api.mode = 'ok';
    await editUnsyncedReport(store, r.id, { location: 'Kebele 09' });
    s = await store.get(r.id);
    assert.equal(s.syncState, SYNC.PENDING);
    await sync.run();
    assert.equal((await store.get(r.id)).syncState, SYNC.SYNCED);
  });

  test('server errors retry a few times, then fail visibly', async () => {
    const { store, api, sync } = setup();
    const r = await createLocalReport(store, form(), { submit: true });
    api.mode = '500';
    for (let i = 0; i < 4; i++) { await sync.run(); assert.equal((await store.get(r.id)).syncState, SYNC.PENDING); }
    await sync.run();
    assert.equal((await store.get(r.id)).syncState, SYNC.FAILED);
    api.mode = 'ok';
    await sync.retry(r.id);
    assert.equal((await store.get(r.id)).syncState, SYNC.SYNCED);
  });

  test('reports stuck in "syncing" after a crash are recovered on startup', async () => {
    const { store, api, sync } = setup();
    const r = await createLocalReport(store, form(), { submit: true });
    const stuck = await store.get(r.id);
    stuck.syncState = SYNC.SYNCING;
    await store.put(stuck);
    assert.equal(await sync.recoverInterrupted(), 1);
    assert.equal((await store.get(r.id)).syncState, SYNC.PENDING);
    await sync.run();
    assert.equal(api.db.size, 1);
  });

  test('overlapping triggers share one run (no double sends)', async () => {
    const { store, api, sync } = setup();
    await createLocalReport(store, form(), { submit: true });
    const [a, b, c] = await Promise.all([sync.run(), sync.run(), sync.run()]);
    assert.equal(api.calls, 1);
    assert.equal(a, b);
    assert.equal(b, c);
  });

  test('a synced report cannot be edited locally', async () => {
    const { store, sync } = setup();
    const r = await createLocalReport(store, form(), { submit: true });
    await sync.run();
    await assert.rejects(editUnsyncedReport(store, r.id, { priority: 'Low' }), /already reached the server/);
  });
});

describe('merging server data', () => {
  test('adds server reports and never overwrites unsynced local work', async () => {
    const { store } = setup();
    const mine = await createLocalReport(store, form({ description: 'My local edit stays.' }), { submit: true });
    await mergeServerReports(store, [
      { id: mine.id, ...form(), description: 'server copy', status: 'Submitted', reportedAt: mine.reportedAt, version: 1 },
      { id: 'server-report-0001', ...form(), status: 'Assigned', reportedAt: new Date().toISOString(), version: 3 },
    ]);
    assert.equal((await store.get(mine.id)).description, 'My local edit stays.');
    const other = await store.get('server-report-0001');
    assert.equal(other.syncState, SYNC.SYNCED);
    assert.equal(other.status, 'Assigned');
  });

  test('status changes made by a coordinator show up and are logged locally', async () => {
    const { store, sync } = setup();
    const r = await createLocalReport(store, form(), { submit: true });
    await sync.run();
    const synced = await store.get(r.id);
    await mergeServerReports(store, [{ ...synced, status: 'Assigned', version: 2 }]);
    const after = await store.get(r.id);
    assert.equal(after.status, 'Assigned');
    assert.ok(after.activity.some((a) => /now "Assigned"/.test(a.message)));
  });

  test('a report the server lost is re-queued, not forgotten', async () => {
    const { store, api, sync } = setup();
    const r = await createLocalReport(store, form(), { submit: true });
    await sync.run();
    api.db.clear();
    await mergeServerReports(store, []);
    assert.equal((await store.get(r.id)).syncState, SYNC.PENDING);
    await sync.run();
    assert.equal(api.db.size, 1);
  });
});

test('repeated offline retries do not flood the activity log', async () => {
  const store = createMemoryStore(); const api = fakeApi(); const sync = createSyncEngine({ store, api });
  const r = await createLocalReport(store, form(), { submit: true });
  api.mode = 'offline';
  for (let i = 0; i < 6; i++) await sync.run();
  assert.equal((await store.get(r.id)).activity.filter((a) => a.type === 'error').length, 1);
});
