/* Otter Quotes Admin App — service worker (v1, 2026-09-02)
 *
 * Modeled directly on partner-sw.js (gh-1479) — same strategy, scoped to the
 * admin surface instead of the partner surface.
 *
 * Deliberately conservative: this worker ONLY manages the admin surface.
 * - Navigations to admin pages: network-first, cache fallback (offline support).
 * - js/auth.js and js/nav.js: network-first, cache fallback (same gh-831
 *   reasoning as partner-sw.js — these decide where a signed-in user lands,
 *   so they must never be served stale from an admin-scoped cache either).
 * - Precached static shell assets: cache-first.
 * - Everything else (homeowner/contractor/partner pages, Supabase, Edge
 *   Functions, third-party scripts): NOT intercepted -- the browser handles
 *   them natively.
 *
 * gh-1479 flag from the CTO, carried here rather than only in the PR
 * description: admin pages render every partner's payout state, every
 * contractor's record, and money. This worker precaches the shell ONLY --
 * it must never cache a data response (no Supabase/Edge Function URL is
 * ever in PRECACHE or matched by the fetch handler below). A phone is lost
 * more often than a laptop.
 *
 * Served with Cache-Control: no-cache (netlify.toml) so updates roll out on
 * next load.
 */

const VERSION = 'oq-admin-v1-9c1e0a2b';
const CACHE_NAME = 'oq-admin-cache-' + VERSION;

const ADMIN_PAGES = [
  '/admin-dashboard.html',
  '/admin-contractors.html',
  '/admin-payouts.html',
  '/admin-referrals.html',
  '/admin-measurements.html',
  '/admin-cert-verifications.html',
  '/admin-cpa.html',
  '/admin-fee-config.html',
  '/admin-incomplete-profiles.html',
  '/admin-template-review.html',
  '/admin-warranty-drift.html'
];

// Same gh-831 reasoning as partner-sw.js: auth-critical -- must never be
// served stale. Network-first, cache entry is a pure offline fallback.
const NETWORK_FIRST_ASSETS = [
  '/js/auth.js',
  '/js/nav.js'
];

const SHELL_ASSETS = [
  '/css/design-system.css',
  '/css/nav.css',
  '/img/app/admin-icon-192.png',
  '/img/app/apple-touch-icon-admin.png',
  '/img/brand-assets/favicon.png',
  '/img/otter-logo.svg'
];

const PRECACHE = ADMIN_PAGES.concat(NETWORK_FIRST_ASSETS).concat(SHELL_ASSETS);

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
          .filter((k) => k.indexOf('oq-admin-cache-') === 0 && k !== CACHE_NAME)
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

  // Admin page navigations: network-first with cache fallback.
  if (req.mode === 'navigate' && ADMIN_PAGES.indexOf(path) !== -1) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((c) => c.put(path, copy)).catch(() => {}));
          return res;
        })
        .catch(() =>
          caches.match(path).then((hit) => hit || caches.match('/admin-dashboard.html'))
        )
    );
    return;
  }

  // Auth-critical assets -- network-first, cache is an offline fallback
  // only. A stale js/auth.js here would silently defeat role-resolution on
  // the one surface that touches every partner's payout state and every
  // contractor's record, so this must never be cache-first/stale-while-revalidate.
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

  // Everything else (including all Supabase/Edge Function calls the admin
  // dashboard makes to fetch payout/contractor/business-line data): default
  // browser behavior (no respondWith) -- deliberately never cached.
});
