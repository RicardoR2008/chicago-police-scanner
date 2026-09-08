/* Service worker: caches the app shell so the PWA installs and launches offline.
   Never touches the OpenMHz API or audio - those must always hit the network. */
const CACHE = 'cpd-scanner-v9';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Let anything cross-origin (API calls, audio clips) go straight to the network.
  if (new URL(req.url).origin !== self.location.origin) return;

  // Network-first for the shell, cache only as the offline fallback.
  //
  // This was stale-while-revalidate, chosen for instant launch. That was the
  // wrong trade: the shell is a few KB, but it left users running old code with
  // no way to know or escape it - a shipped fix looked like it had never landed.
  // A ~100ms wait beats being a version behind.
  //
  // The network is raced against a timeout so a hung mobile connection falls
  // back to cache instead of stalling the launch indefinitely.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await Promise.race([
        fetch(req),
        new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 3000)),
      ]);
      if (fresh && fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    } catch (_) {
      const cached = await cache.match(req, { ignoreSearch: true });
      return cached || Response.error();
    }
  })());
});
