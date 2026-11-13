import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, sampleReport } from './helpers.js';

let s;
before(async () => { s = await startTestServer(); });
after(async () => { await s.close(); });

const historyOf = async (id) => (await s.call('GET', `/api/reports/${id}/history`)).body.history;

describe('create + idempotency', () => {
  test('creates a report and records a "created" history event', async () => {
    const r = sampleReport();
    const res = await s.call('POST', '/api/reports', r);
    assert.equal(res.status, 201);
    assert.equal(res.body.report.status, 'Submitted');
    assert.equal(res.body.report.version, 1);
    const h = await historyOf(r.id);
    assert.deepEqual(h.map((e) => e.type), ['created']);
  });

  test('retrying the same id never creates a second row (interrupted-sync safety)', async () => {
    const r = sampleReport();
    const first = await s.call('POST', '/api/reports', r);
    const retry = await s.call('POST', '/api/reports', r);
    const again = await s.call('POST', '/api/reports', r);
    assert.equal(first.status, 201);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.duplicate, true);
    assert.equal(again.body.duplicate, true);
    const { body } = await s.call('GET', '/api/reports');
    assert.equal(body.reports.filter((x) => x.id === r.id).length, 1);
    assert.equal(retry.body.report.version, 1);
  });

  test('a retry with edited content does not overwrite the stored report', async () => {
    const r = sampleReport();
    await s.call('POST', '/api/reports', r);
    const retry = await s.call('POST', '/api/reports', { ...r, description: 'Totally different text here.' });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.report.description, r.description);
  });

  test('similar content with a different id is kept but flagged as a possible duplicate', async () => {
    const a = sampleReport({ location: 'Kebele Dup', description: 'Pump is jammed, no water.' });
    const b = sampleReport({ location: 'kebele  dup!', description: 'pump is jammed -- no water' });
    await s.call('POST', '/api/reports', a);
    const res = await s.call('POST', '/api/reports', b);
    assert.equal(res.status, 201);
    assert.equal(res.body.possibleDuplicateOf, a.id);
    const h = await historyOf(b.id);
    assert.ok(h.some((e) => e.type === 'duplicate_suspected'));
  });
});

describe('validation and error handling', () => {
  test('rejects bad fields with 422 and field-level messages', async () => {
    const res = await s.call('POST', '/api/reports', sampleReport({ category: 'Nope', description: 'x', priority: 'Urgent', location: '' }));
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.deepEqual(Object.keys(res.body.error.fields).sort(), ['category', 'description', 'location', 'priority']);
  });

  test('rejects future reportedAt and bad ids', async () => {
    const future = await s.call('POST', '/api/reports', sampleReport({ reportedAt: new Date(Date.now() + 3600_000).toISOString() }));
    assert.equal(future.status, 422);
    assert.ok(future.body.error.fields.reportedAt);
    const badId = await s.call('POST', '/api/reports', sampleReport({ id: "x'; DROP TABLE reports;--" }));
    assert.equal(badId.status, 422);
    assert.ok(badId.body.error.fields.id);
  });

  test('drafts cannot be created on the server', async () => {
    const res = await s.call('POST', '/api/reports', sampleReport({ status: 'Draft' }));
    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields.status);
  });

  test('malformed JSON gives 400, oversized body gives 413, unknown route 404', async () => {
    assert.equal((await s.call('POST', '/api/reports', '{not json')).status, 400);
    assert.equal((await s.call('POST', '/api/reports', { id: 'a'.repeat(200 * 1024) })).status, 413);
    assert.equal((await s.call('GET', '/api/nope')).status, 404);
    assert.equal((await s.call('GET', '/api/reports/does-not-exist')).status, 404);
  });

  test('stores hostile text verbatim as data (no injection, no mutation of the string)', async () => {
    const r = sampleReport({ description: `<img src=x onerror=alert(1)> '); DROP TABLE reports;--` });
    const res = await s.call('POST', '/api/reports', r);
    assert.equal(res.status, 201);
    assert.equal(res.body.report.description, r.description);
    assert.equal((await s.call('GET', '/api/reports')).status, 200);
  });

  test('a failed create is recorded in history', async () => {
    const r = sampleReport({ description: 'no' });
    await s.call('POST', '/api/reports', r);
    const h = await historyOf(r.id);
    assert.equal(h[0].type, 'error');
  });
});

describe('status workflow', () => {
  const create = async () => { const r = sampleReport(); await s.call('POST', '/api/reports', r); return r.id; };
  const move = (id, status, extra = {}, headers = s.coordinator) => s.call('POST', `/api/reports/${id}/status`, { status, ...extra }, headers);

  test('walks the full happy path and logs each change', async () => {
    const id = await create();
    for (const st of ['Assigned', 'In Progress', 'Resolved']) {
      const res = await move(id, st);
      assert.equal(res.status, 200, st);
      assert.equal(res.body.report.status, st);
    }
    const h = await historyOf(id);
    assert.equal(h.filter((e) => e.type === 'status_changed').length, 3);
    assert.equal(h.at(-1).actor, 'Coordinator Tigist');
  });

  test('rejects invalid transitions with 409 and lists the allowed ones', async () => {
    const id = await create();
    const res = await move(id, 'Resolved');
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'invalid_transition');
    assert.deepEqual(res.body.error.allowed, ['Assigned', 'Rejected']);
    assert.equal((await s.call('GET', `/api/reports/${id}`)).body.report.status, 'Submitted');
    assert.ok((await historyOf(id)).some((e) => e.type === 'error'));
  });

  test('field workers cannot triage (403) but can resubmit a rejected report', async () => {
    const id = await create();
    const denied = await move(id, 'Assigned', {}, { 'X-Role': 'worker' });
    assert.equal(denied.status, 403);
    assert.equal((await move(id, 'Rejected', { note: 'Not enough detail.' })).status, 200);
    const resub = await move(id, 'Submitted', {}, { 'X-Role': 'worker' });
    assert.equal(resub.status, 200);
  });

  test('reject and reopen require a note', async () => {
    const id = await create();
    const noNote = await move(id, 'Rejected');
    assert.equal(noNote.status, 422);
    assert.equal(noNote.body.error.code, 'note_required');
    for (const st of ['Assigned', 'In Progress', 'Resolved']) await move(id, st);
    assert.equal((await move(id, 'In Progress')).status, 422);
    const reopen = await move(id, 'In Progress', { note: 'Leak is back.' });
    assert.equal(reopen.status, 200);
  });

  test('stale expectedStatus is a 409 conflict, not a silent overwrite', async () => {
    const id = await create();
    await move(id, 'Assigned');
    const res = await move(id, 'Assigned', { expectedStatus: 'Submitted' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'stale_status');
  });

  test('unknown status is a 422', async () => {
    const id = await create();
    assert.equal((await move(id, 'Banana')).status, 422);
  });
});

describe('editing after submission', () => {
  test('edit with the current version succeeds, bumps version, and logs before/after', async () => {
    const r = sampleReport();
    const created = await s.call('POST', '/api/reports', r);
    const res = await s.call('PATCH', `/api/reports/${r.id}`, { baseVersion: created.body.report.version, priority: 'Critical' });
    assert.equal(res.status, 200);
    assert.equal(res.body.report.priority, 'Critical');
    assert.equal(res.body.report.version, 2);
    const ev = (await historyOf(r.id)).find((e) => e.type === 'edited');
    assert.deepEqual(ev.detail.before, { priority: 'High' });
    assert.deepEqual(ev.detail.after, { priority: 'Critical' });
  });

  test('stale baseVersion returns 409 with the current server copy', async () => {
    const r = sampleReport();
    await s.call('POST', '/api/reports', r);
    await s.call('PATCH', `/api/reports/${r.id}`, { baseVersion: 1, priority: 'Low' });
    const res = await s.call('PATCH', `/api/reports/${r.id}`, { baseVersion: 1, priority: 'Critical' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'version_conflict');
    assert.equal(res.body.error.current.priority, 'Low');
  });

  test('content is locked once the report is Assigned; status/id/reportedAt are never editable', async () => {
    const r = sampleReport();
    await s.call('POST', '/api/reports', r);
    const bad = await s.call('PATCH', `/api/reports/${r.id}`, { baseVersion: 1, status: 'Resolved' });
    assert.equal(bad.status, 422);
    await s.call('POST', `/api/reports/${r.id}/status`, { status: 'Assigned' }, s.coordinator);
    const locked = await s.call('PATCH', `/api/reports/${r.id}`, { baseVersion: 2, description: 'New text here ok.' });
    assert.equal(locked.status, 409);
    assert.equal(locked.body.error.code, 'not_editable');
  });
});

describe('static serving', () => {
  test('serves the app shell and blocks path traversal', async () => {
    const ok = await fetch(s.base + '/shared/domain.js');
    assert.equal(ok.status, 200);
    const evil = await fetch(s.base + '/shared/..%2Fserver%2Fdb.js');
    assert.notEqual(evil.status, 200);
  });
});
