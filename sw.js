/* Офлайн-режим: оболочка приложения из кэша, words.json — сначала из сети, без сети из кэша. */
const VERSION = 'mw-shell-v4';
const DATA = 'mw-data';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' — берём свежие файлы с сервера, а не из HTTP-кэша браузера
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('/words.json')) {
    e.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((r) => {
          if (r.ok) { const copy = r.clone(); caches.open(DATA).then((c) => c.put('words.json', copy)); }
          return r;
        })
        .catch(() => caches.open(DATA).then((c) => c.match('words.json')).then((hit) => {
          // Нет копии — пусть приложение работает со словами, сохранёнными на устройстве.
          if (!hit) return new Response('offline', { status: 503, headers: { 'X-From-Cache': '1' } });
          return hit.text().then((t) => new Response(t, { headers: { 'Content-Type': 'application/json', 'X-From-Cache': '1' } }));
        }))
    );
    return;
  }

  // Оболочка: отдаём из кэша сразу, в фоне обновляем копию (новая версия откроется при следующем запуске).
  e.respondWith(
    caches.open(VERSION).then((cache) =>
      cache.match(req, { ignoreSearch: true }).then((hit) => {
        const net = fetch(req).then((r) => {
          if (r.ok) { const copy = r.clone(); cache.put(req, copy); }
          return r;
        }).catch(() => null);
        if (hit) { e.waitUntil(net); return hit; }
        return net.then((r) => r || (req.mode === 'navigate' ? cache.match('./index.html') : Response.error()));
      })
    )
  );
});
