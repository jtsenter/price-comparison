// PriceWatch service worker — network-first with offline cache fallback.
// Network-first is deliberate: the site is deployed often, so online users must
// always get fresh HTML/CSS/JS (no stale-shell trap). The cache only serves when
// the network is unavailable, giving an instant offline view of last-known prices.

const CACHE = 'pricewatch-v38';
const SHELL = [
  'index.html',
  'hot-deals.html',
  'shopping-list.html',
  'style.css?v=38',
  'app.js?v=38',
  'utils.js?v=38',
  'name_map.js?v=38',
  'manifest.webmanifest',
  'favicon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})            // a missing shell entry must not block install
      .then(() => self.skipWaiting())
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
  if (new URL(req.url).origin !== location.origin) return; // let CDN/images go straight to network
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      // Offline fallback. ignoreSearch so a fresh `?t=` cache-bust still matches
      // the previously cached data file (e.g. latest.json?t=123 → cached ?t=456).
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
