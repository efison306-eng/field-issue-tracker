import { createServer } from 'node:http';
import { openDb } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const dbPath = process.env.DB_PATH || 'data/tracker.sqlite';
const db = openDb(dbPath);
const server = createServer(createApp(db));
server.listen(port, () => console.log(`Field Issue Tracker on http://localhost:${port}  (db: ${dbPath})`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
