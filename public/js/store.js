// Local persistence. IndexedDB in the browser; an in-memory twin with the same
// interface is used by the automated tests.

const DB_NAME = 'field-issue-tracker';
const STORE = 'reports';

function wrap(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function openIndexedDbStore() {
  const db = await new Promise((res, rej) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: 'id' });
    open.onsuccess = () => res(open.result);
    open.onerror = () => rej(open.error);
  });
  const os = (mode) => db.transaction(STORE, mode).objectStore(STORE);
  return {
    all: () => wrap(os('readonly').getAll()),
    get: (id) => wrap(os('readonly').get(id)),
    // put() resolves only after the transaction commits, so "saved" really means durable.
    put: (report) =>
      new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(structuredClone(report));
        tx.oncomplete = () => res(report);
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error || new Error('Local save was aborted.'));
      }),
  };
}

export function createMemoryStore(initial = []) {
  const m = new Map(initial.map((r) => [r.id, structuredClone(r)]));
  return {
    all: async () => [...m.values()].map((r) => structuredClone(r)),
    get: async (id) => (m.has(id) ? structuredClone(m.get(id)) : undefined),
    put: async (r) => { m.set(r.id, structuredClone(r)); return r; },
    _map: m,
  };
}
