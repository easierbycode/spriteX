const CACHE_NAME = 'spritex-cache-v1';
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