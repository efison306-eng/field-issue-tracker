import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';

// Starts the real HTTP server on a random port with an in-memory database.
export async function startTestServer() {
  const db = openDb(':memory:');
  const server = createServer(createApp(db));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Role': 'worker', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }
  const coordinator = { 'X-Role': 'coordinator', 'X-Actor': 'Coordinator Tigist' };

  return {
    base,
    db,
    call,
    coordinator,
    close: () => new Promise((r) => server.close(() => { db.close(); r(); })),
  };
}

let n = 0;
export function sampleReport(over = {}) {
  n += 1;
  return {
    id: `report-${String(n).padStart(4, '0')}-abcdef`,
    category: 'Water point',
    description: `Pump handle is broken (case ${n}).`,
    location: `Kebele ${n}`,
    priority: 'High',
    status: 'Submitted',
    reportedAt: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
}
