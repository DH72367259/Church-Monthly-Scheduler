/* ─── Church Schedule Service Worker ────────────────────────────────────── */
'use strict';

const CACHE = 'church-schedule-v20';

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './icons/icon.svg'
];

/* Install – pre-cache the app shell */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

/* Activate – remove old caches */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Fetch strategy:
   - data/*.json  → network-first (admin pushes updates, users always get fresh)
   - everything else → cache-first  (app shell loads instantly offline)
*/
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (url.pathname.includes('/data/')) {
    /* Network-first with cache fallback for JSON data */
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    /* Cache-first for app shell */
    event.respondWith(
      caches.match(event.request)
        .then(cached => cached || fetch(event.request))
    );
  }
});
