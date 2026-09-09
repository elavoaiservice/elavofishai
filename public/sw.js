/* ElavoFishAI — offline service worker
   Strategy: the app shell loads from cache first (works with zero signal),
   then refreshes the cache in the background. Live data (weather, lake
   level, map tiles) goes network-only; the app already degrades honestly
   when those are unreachable. */
const CACHE = 'elavofishai-v4';
const SHELL = ['/app', '/index.html', '/landing.html', '/', '/apple-touch-icon.png',
               '/icon-192.png', '/icon-512.png', '/favicon.png', '/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // API is live data + auth — never cache it
  if (url.pathname.startsWith('/api/')) return;

  // App shell + same-origin assets: cache first, refresh behind the scenes
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then(hit => {
        const refresh = fetch(e.request).then(res => {
          if (res && res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        }).catch(() => hit);
        return hit || refresh;
      })
    );
    return;
  }

  // Fonts + Leaflet from CDN: cache after first use so offline keeps the look
  if (/fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com/.test(url.host)) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        if (res && res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }))
    );
    return;
  }
  // Everything else (weather, USGS, map tiles): straight to network.
});
