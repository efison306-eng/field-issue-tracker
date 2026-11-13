// Caches the app shell so the app opens with no network. API calls are never cached:
// offline data lives in IndexedDB, not here.
const CACHE = 'fit-shell-v1';
const SHELL = ['/', '/index.html', '/styles.css', '/manifest.webmanifest', '/icon.svg',
  '/js/app.js', '/js/core.js', '/js/api.js', '/js/store.js', '/shared/domain.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Network first so deployments show up; fall back to the cache when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return res; })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html'))),
  );
});
