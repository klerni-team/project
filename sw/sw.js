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

  // Pages: network first so a deploy shows up on next open. Only a good
  // response replaces the cached shell; errors (e.g. a 502 mid-deploy) fall
  // back to the last good copy.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(async res => {
          if (!res.ok) return (await caches.match('/')) ?? res;
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('/', copy));
          return res;
        })
        .catch(async () => (await caches.match('/')) ?? Response.error()),
    );
    return;
  }

  // Everything else this build emitted is precached; fall back to network.
  event.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
