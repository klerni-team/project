// App-shell service worker, generated per build by the plugin in
// vite.config.ts, which fills in the build hash and the list of emitted files. Every deploy therefore installs a new
// cache holding all bundles (lazy chunks included) and drops the old one.
// API calls always go to the network; the app keeps its own data copy.
const CACHE = 'habits-__VERSION__';
const PRECACHE = __PRECACHE__;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(['/', ...PRECACHE]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Pages: the shell is served from cache, so the app opens instantly even
  // on a weak connection. A deploy changes this file, which installs a new
  // worker with a fresh shell; the next launch picks it up.
  if (req.mode === 'navigate') {
    event.respondWith(caches.match('/').then(hit => hit || fetch(req)));
    return;
  }

  // Everything else this build emitted is precached; fall back to network.
  event.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
