// Only caches named with this prefix are spriteX's. Cache Storage belongs to
// the whole origin, and spriteX is not always alone on it (a host may serve it
// beside apps with caches of their own), so activate clears old spriteX
// caches and nothing else.
const CACHE_PREFIX = 'spritex-cache-';
const CACHE_NAME = `${CACHE_PREFIX}v10`;
const RESOURCES = [
  './',
  'index.html',
  'manifest.json',
  'assets/main.js',
  'gif.worker.js',
  'favicon.ico',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const resource of RESOURCES) {
        const resourceUrl = new URL(resource, self.registration.scope);
        try {
          await cache.add(resourceUrl);
        } catch (error) {
          console.warn(`Failed to cache ${resourceUrl}:`, error);
        }
      }
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) {
        return response;
      }
      return fetch(event.request);
    })
  );
});