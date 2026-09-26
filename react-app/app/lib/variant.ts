'use client';

/**
 * Router-arm attribution bridge (gh-2078) -- /start persists the visitor's
 * assigned arm under localStorage/cookie key `oq_variant_v3` on
 * otterquote.com, and forwards it as `?v=<arm>` to this app's hand-off URL
 * (`app.otterquote.com/get-started?v=<arm>` -- see start.html's
 * `collectAttribution`/`redirectTo`). `otterquote.com` and
 * `app.otterquote.com` are different origins, so neither that localStorage
 * key nor that cookie (host-only -- start.html's write has no explicit
 * `Domain=` attribute) is readable from this app: the `?v=` query param on
 * the FIRST `/get-started` load is the only thing that actually reaches
 * here. This module captures it once, on that first load, into this app's
 * OWN (origin-scoped) localStorage, so it survives to later pages (e.g.
 * help-measurements' checkout, possibly days later) that carry no `?v=` of
 * their own.
 *
 * Source, in priority order:
 *   1. `?v=<arm>` on the CURRENT page load -- most reliable when present:
 *      it is the value start.html just assigned/persisted, forwarded
 *      same-request, before any storage read/write can go stale.
 *   2. This app's own persisted copy (localStorage, `oq_variant_v3`,
 *      written by #1 on an earlier load in this browser).
 *   3. `'unknown'` -- no `?v=` was ever captured (e.g. a direct visit to
 *      `/get-started`, third-party/first-party storage blocked, or a
 *      pre-attribution session).
 *
 * Deliberately permissive on shape (bounded, not a hardcoded closed set of
 * arm letters): this module has no visibility into start.html's
 * `LIVE_VARIANTS`/`KNOWN_ARMS` and must not need editing every time that
 * set changes on the marketing site.
 */

const STORAGE_KEY = 'oq_variant_v3';
const VARIANT_SHAPE_RE = /^[a-z0-9]{1,8}$/;

function sanitizeVariant(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return VARIANT_SHAPE_RE.test(v) ? v : null;
}

/**
 * Call once, early, on `/get-started` -- the only page in this app that can
 * ever see `?v=` on the URL (start.html only forwards it to that one
 * hand-off link). Best-effort: any storage failure is swallowed, matching
 * every other localStorage bridge in this app (e.g. persistSignupContext).
 */
export function captureVariantFromUrl(): void {
  if (typeof window === 'undefined') return;
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = sanitizeVariant(params.get('v'));
    if (fromUrl) localStorage.setItem(STORAGE_KEY, fromUrl);
  } catch {
    // best-effort only -- storage may be unavailable (private mode, blocked)
  }
}

/** Reads the persisted arm, falling back to `'unknown'`. Never throws. */
export function getVariant(): string {
  try {
    if (typeof window === 'undefined') return 'unknown';
    return sanitizeVariant(localStorage.getItem(STORAGE_KEY)) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
