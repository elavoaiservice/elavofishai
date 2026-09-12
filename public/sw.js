/* ElavoFishAI — offline service worker
   Strategy: the app shell loads from cache first (works with zero signal),
   then refreshes the cache in the background. Live data (weather, lake
   level, map tiles) goes network-only; the app already degrades honestly
   when those are unreachable. */
const CACHE = 'elavofishai-v42';
// NOTE: the planner (/app, index.html) is intentionally NOT cached — it's an
// account-gated page and must always hit the server so the auth gate runs. The
// public marketing/login pages + static assets are safe to cache.
const SHELL = ['/landing.html', '/', '/apple-touch-icon.png',
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

  // API is live data + auth — never cache it. The admin Command Center, the
  // account-gated planner (/app), and the login screen are always fetched fresh
  // so the server-side auth gate always runs (a cached /app would bypass it).
  if (url.pathname.startsWith('/api/') ||
      url.pathname === '/admin' || url.pathname.startsWith('/admin/') ||
      url.pathname === '/app' || url.pathname.startsWith('/app/') ||
      url.pathname === '/login' || url.pathname === '/signup') return;

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

/* ---- push ----
   The bell inside the app only works while the app is open, which is almost
   never. A push reaches the phone in the pocket.

   The payload is deliberately thin — a nudge, not the content. A lock screen
   is a public place, and none of this is worth showing to whoever is sitting
   next to you. */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  const title = d.title || 'ElavoFishAI';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // Same tag replaces an older one rather than stacking six buzzes.
    tag: d.tag || 'efa',
    data: { url: d.url || '/app' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/app';
  // Focus a tab that is already open rather than piling up new ones.
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.indexOf('/app') !== -1 && 'focus' in c) { c.navigate(url); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
