/* Cairnline dashboard service worker.
   Cache the app shell, serve navigations network-first (so a new deploy is
   picked up), and keep static assets stale-while-revalidate. Data calls are
   never cached: the desk must show live or labelled-offline state, not a
   replay of yesterday's rows. */

const VERSION = 'cairnline-shell-v1';

const SHELL = [
  './',
  './index.html',
  './dashboard.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './js/main.js',
  './js/router.js',
  './js/ui.js',
  './js/data.js',
  './js/config.js',
  './js/supabase.js',
  './js/market.js',
  './js/vela-provider.js',
  './js/pages/overview.js',
  './js/pages/terminal.js',
  './js/pages/trading.js',
  './js/pages/account.js',
  './js/pages/content.js',
  './js/pages/research.js',
  './js/pages/tools.js',
  './js/pages/backtest.js',
  './js/pages/options.js',
  './js/pages/paper.js',
  './js/pages/marketplace.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/rest/v1/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put('./index.html', copy));
          return res;
        })
        .catch(async () => (await caches.match('./index.html')) || (await caches.match('./')) || Response.error())
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});
