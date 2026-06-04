/* sw.js v6 - キャッシュ無効版（デバッグ用） */
const CACHE = 'eq-pwa-v6';

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k))))
  );
  self.clients.claim();
});
/* fetch はすべてネットワークから取得（キャッシュしない） */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
