/* Otter Quotes Partner App — service worker (v2, 2026-08-14)
 *
 * Deliberately conservative: this worker ONLY manages the partner surface.
 * - Navigations to partner pages: network-first, cache fallback (offline support).
 * - js/auth.js and js/nav.js: network-first, cache fallback (see gh-831 below).
 * - Precached static shell assets: cache-first.
 * - Everything else (homeowner/contractor/admin pages, Supabase, Edge Functions,
 *   third-party scripts): NOT intercepted — the browser handles them natively.
 *
 * Served with Cache-Control: no-cache (netlify.toml) so updates roll out on
 * next load.
 *
 * gh-831: js/auth.js and js/nav.js used to be cache-first SHELL_ASSETS whose
 * background revalidation was never passed to event.waitUntil() — on mobile
 * the SW can be killed once respondWith() settles, so the cache.put() never
 * lands and staleness becomes persistent, not just first-load. They decide
 * where a logged-in user lands (#817/#643) and must never be served stale,
 * so they now use the same network-first strategy as partner page
 * navigations, with every cache.put() wrapped in waitUntil().
 *
 * VERSION is derived from a hash of this file's own caching config (see
 * scripts/check-partner-sw-version.py, run in CI) rather than hand-bumped —
 * a stale VERSION was itself the root defect here (unchanged across at
 * least four auth PRs since 2026-08-03), so a forgotten bump is now a CI
 * failure instead of a silent one.
 */

const VERSION = 'oq-partner-v2-e25270e2';
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

// gh-831: auth-critical — must never be served stale. Network-first, same
// as partner page navigations; the cache entry is a pure offline fallback.
const NETWORK_FIRST_ASSETS = [
  '/js/auth.js',
  '/js/nav.js'
];

const SHELL_ASSETS = [
  '/css/design-system.css',
  '/css/nav.css',
  '/js/cookie-storage.js',
  '/js/config.js',
  '/js/vendor/qrcode-generator.js',
  '/img/app/partner-icon-192.png',
  '/img/app/apple-touch-icon-partner.png',
  '/img/brand-assets/favicon.png',
  '/img/otter-logo.svg'
];

const PRECACHE = PARTNER_PAGES.concat(NETWORK_FIRST_ASSETS).concat(SHELL_ASSETS);

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
          event.waitUntil(caches.open(CACHE_NAME).then((c) => c.put(path, copy)).catch(() => {}));
          return res;
        })
        .catch(() =>
          caches.match(path).then((hit) => hit || caches.match('/partner-app.html'))
        )
    );
    return;
  }

  // gh-831: auth-critical assets — network-first, cache is an offline
  // fallback only. A stale js/auth.js here silently defeats every
  // role-resolution fix (#817) on the one surface that reports partner
  // auth bugs, so this must never be cache-first/stale-while-revalidate.
  if (NETWORK_FIRST_ASSETS.indexOf(path) !== -1) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((c) => c.put(path, copy)).catch(() => {}));
          return res;
        })
        .catch(() => caches.match(path))
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
            event.waitUntil(caches.open(CACHE_NAME).then((c) => c.put(path, copy)).catch(() => {}));
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
