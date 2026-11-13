import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { STATUSES, TRANSITIONS, allowedTransitions, checkTransition, validateReport, fingerprint } from '../shared/domain.js';

describe('transition rules', () => {
  test('every status has an entry and only points at known statuses', () => {
    for (const s of STATUSES) assert.ok(s in TRANSITIONS, s);
    for (const to of Object.values(TRANSITIONS).flat()) assert.ok(STATUSES.includes(to));
  });

  test('no status can transition to itself or skip ahead', () => {
    for (const s of STATUSES) assert.ok(!TRANSITIONS[s].includes(s));
    assert.ok(!TRANSITIONS.Submitted.includes('Resolved'));
    assert.ok(!TRANSITIONS.Draft.includes('Assigned'));
  });

  test('workers get a subset of what coordinators can do', () => {
    assert.deepEqual(allowedTransitions('Draft', 'worker'), ['Submitted']);
    assert.deepEqual(allowedTransitions('Submitted', 'worker'), []);
    assert.deepEqual(allowedTransitions('Rejected', 'worker'), ['Submitted']);
    assert.deepEqual(allowedTransitions('Resolved', 'coordinator'), ['In Progress']);
  });

  test('checkTransition explains why it refuses', () => {
    assert.equal(checkTransition('Submitted', 'Resolved', 'coordinator').code, 'invalid_transition');
    assert.equal(checkTransition('Submitted', 'Assigned', 'worker').code, 'forbidden_transition');
    assert.equal(checkTransition('Submitted', 'Rejected', 'coordinator', '  ').code, 'note_required');
    assert.equal(checkTransition('Submitted', 'Rejected', 'coordinator', 'Duplicate of #12').ok, true);
  });
});

describe('validation', () => {
  const ok = { id: 'abcdefgh-1', category: 'Safety concern', description: 'Loose wire', location: 'Gate 2', priority: 'Low', status: 'Submitted', reportedAt: '2026-01-01T10:00:00Z' };
  test('accepts a valid report and normalises the date', () => {
    const { errors, value } = validateReport(ok);
    assert.deepEqual(errors, {});
    assert.equal(value.reportedAt, '2026-01-01T10:00:00.000Z');
  });
  test('trims text and collapses whitespace in location', () => {
    assert.equal(validateReport({ ...ok, location: '  Gate    2 ' }).value.location, 'Gate 2');
  });
  test('rejects non-objects, control characters, and overly long text', () => {
    assert.ok(validateReport(null).errors._);
    assert.ok(validateReport([]).errors._);
    assert.ok(validateReport({ ...ok, description: 'bad\u0000text here' }).errors.description);
    assert.ok(validateReport({ ...ok, description: 'x'.repeat(2001) }).errors.description);
  });
  test('partial mode only checks fields that are present', () => {
    assert.deepEqual(validateReport({ priority: 'Low' }, { partial: true }).errors, {});
    assert.ok(validateReport({ priority: 'Meh' }, { partial: true }).errors.priority);
  });
  test('fingerprint ignores case, punctuation and spacing', () => {
    assert.equal(fingerprint({ category: 'A', location: 'Kebele 4!', description: 'Pump  broken.' }), fingerprint({ category: 'A', location: 'kebele 4', description: 'pump broken' }));
  });
});
