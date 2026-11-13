import { randomUUID } from 'node:crypto';
import { openDb, addHistory, tx } from './db.js';
import { fingerprint } from '../shared/domain.js';

const db = openDb(process.env.DB_PATH || 'data/tracker.sqlite');
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

const samples = [
  ['Water point', 'Hand pump at the borehole is jammed; villagers walking 3 km to the next source.', 'Kebele 04, Dessie Zuria', 'Critical', 'Submitted', 2],
  ['Equipment damage', 'Generator at the clinic has a cracked fuel line and leaks diesel.', 'Harbu Health Post', 'High', 'Assigned', 20],
  ['Service interruption', 'Solar pumping station has not delivered water since Tuesday.', 'Tita Water Scheme', 'High', 'In Progress', 40],
  ['Safety concern', 'Exposed live wires on the pole next to the school gate.', 'Wuchale Primary School', 'Critical', 'Resolved', 70],
  ['Maintenance', 'Tap stand platform is cracked and needs repointing.', 'Kutaber Market', 'Low', 'Submitted', 5],
  ['Other', 'Photo of a pipeline in someone\'s backyard (not ours).', 'Unknown', 'Low', 'Rejected', 30],
];

tx(db, () => {
  for (const [category, description, location, priority, status, h] of samples) {
    const id = randomUUID();
    const at = hoursAgo(h);
    db.prepare(`INSERT INTO reports (id, category, description, location, priority, status, reported_at, received_at, updated_at, version, created_by, fingerprint)
                VALUES (?,?,?,?,?,?,?,?,?,1,'seed-worker',?)`).run(id, category, description, location, priority, 'Submitted', at, at, at, fingerprint({ category, description, location }));
    addHistory(db, id, 'created', 'seed-worker', 'Report created (seed data).', null, at);
    const path = { Submitted: [], Assigned: ['Assigned'], 'In Progress': ['Assigned', 'In Progress'], Resolved: ['Assigned', 'In Progress', 'Resolved'], Rejected: ['Rejected'] }[status];
    let prev = 'Submitted';
    for (const next of path) {
      db.prepare('UPDATE reports SET status=?, version=version+1, updated_at=? WHERE id=?').run(next, hoursAgo(Math.max(h - 1, 0)), id);
      addHistory(db, id, 'status_changed', 'seed-coordinator', `Status: ${prev} -> ${next}${next === 'Rejected' ? ' ("Not our infrastructure.")' : ''}.`, { from: prev, to: next }, hoursAgo(Math.max(h - 1, 0)));
      prev = next;
    }
  }
});
console.log(`Seeded ${samples.length} demo reports.`);
db.close();
