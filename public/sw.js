// Minimal service worker for PWA installability.
// Passes all fetches straight through (no offline caching yet).
// Bumping CACHE_VERSION forces clients to discard old caches if any are added later.
const CACHE_VERSION = 'midsouthwx-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', () => {
  // No-op: let the network handle it. Required for installability.
});
