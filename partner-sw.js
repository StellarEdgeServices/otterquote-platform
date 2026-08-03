/* Otter Quotes Partner App — service worker (v1, 2026-08-03)
 *
 * Deliberately conservative: this worker ONLY manages the partner surface.
 * - Navigations to partner pages: network-first, cache fallback (offline support).
 * - Precached static shell assets: cache-first.
 * - Everything else (homeowner/contractor/admin pages, Supabase, Edge Functions,
 *   third-party scripts): NOT intercepted — the browser handles them natively.
 *
 * Served with Cache-Control: no-cache (netlify.toml) so updates roll out on
 * next load. Bump VERSION on any change to invalidate old caches.
 */

const VERSION = 'oq-partner-v1';
const CACHE_NAME = 'oq-partner-cache-' + VERSION;

const PARTNER_PAGES = [
  '/partner-app.html',
  '/partner-dashboard.html',
  '/partner-login.html',
  '/partner-re.html',
  '/partner-insurance.html',
  '/partner-inspectors.html',
  '/partner-adjusters.html',
  '/partner-other.html'
];

const SHELL_ASSETS = [
  '/css/design-system.css',
  '/css/nav.css',
  '/js/cookie-storage.js',
  '/js/config.js',
  '/js/auth.js',
  '/js/nav.js',
  '/js/vendor/qrcode-generator.js',
  '/img/app/partner-icon-192.png',
  '/img/app/apple-touch-icon-partner.png',
  '/img/brand-assets/favicon.png',
  '/img/otter-logo.svg'
];

const PRECACHE = PARTNER_PAGES.concat(SHELL_ASSETS);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Add items individually so one 404 can't fail the whole install.
      Promise.allSettled(PRECACHE.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.indexOf('oq-partner-cache-') === 0 && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return; // never touch cross-origin

  const path = url.pathname;

  // Partner page navigations: network-first with cache fallback.
  if (req.mode === 'navigate' && PARTNER_PAGES.indexOf(path) !== -1) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(path, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(path).then((hit) => hit || caches.match('/partner-app.html'))
        )
    );
    return;
  }

  // Precached shell assets: cache-first, refresh in background.
  if (SHELL_ASSETS.indexOf(path) !== -1) {
    event.respondWith(
      caches.match(path).then((hit) => {
        const refresh = fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(path, copy)).catch(() => {});
            return res;
          })
          .catch(() => hit);
        return hit || refresh;
      })
    );
    return;
  }

  // Everything else: default browser behavior (no respondWith).
});
