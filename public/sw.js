// App-shell service worker: the built app opens offline, API calls always
// go to the network (the app keeps its own local copy of the data).
const CACHE = 'habits-v2';
const STATIC = ['/manifest.webmanifest', '/icons/icon.svg', '/icons/apple-touch-icon.png'];

/** The page plus the hashed bundles it references, so a first offline launch works. */
async function precache() {
  const cache = await caches.open(CACHE);
  const res = await fetch('/', {cache: 'no-cache'});
  if (!res.ok) throw new Error(`shell ${res.status}`);
  const html = await res.clone().text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1]);
  await cache.put('/', res);
  await cache.addAll([...STATIC, ...assets]);
}

self.addEventListener('install', event => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
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

  // Hashed assets and icons: cache first.
  event.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    })),
  );
});
