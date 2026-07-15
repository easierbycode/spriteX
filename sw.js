const CACHE_NAME = 'spritex-cache-v2';
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
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
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