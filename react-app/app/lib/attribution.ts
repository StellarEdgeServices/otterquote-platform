/**
 * gh-1983 — first-touch ad attribution, browser side.
 *
 * The server sets the `oq_ft` cookie on a tagged landing (Netlify edge function
 * on otterquote.com, Next middleware on app.otterquote.com). This module is the
 * client fallback and the reader:
 *   - captureFirstTouch(): on every page load, if no first touch is stored yet
 *     and this URL is tagged, store it (localStorage + .otterquote.com cookie).
 *     If only the cookie exists, mirror it into localStorage (and vice versa),
 *     so either store surviving is enough.
 *   - readFirstTouch(): cookie first, then localStorage.
 *   - recordFirstTouch(): post-auth, hand it to the record_first_touch_attribution
 *     RPC, which writes the profile once and backfills the user's claims. With
 *     no browser value the RPC falls back to auth user_metadata (set at password
 *     signUp), which covers a confirmation link opened in another browser.
 *
 * Every function is non-throwing: attribution must never break sign-up.
 */

import {
  FT_COOKIE,
  FT_PARAM_KEYS,
  FT_STORAGE_KEY,
  buildFirstTouchCookie,
  deserializeFirstTouch,
  parseFirstTouch,
  readCookieValue,
  serializeFirstTouch,
  type FirstTouch,
} from './attribution-core';

export type { FirstTouch } from './attribution-core';

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function readStored(): { cookie: FirstTouch | null; local: FirstTouch | null } {
  let cookie: FirstTouch | null = null;
  let local: FirstTouch | null = null;
  try {
    cookie = deserializeFirstTouch(readCookieValue(document.cookie, FT_COOKIE));
  } catch {
    /* cookies blocked */
  }
  try {
    local = deserializeFirstTouch(localStorage.getItem(FT_STORAGE_KEY));
  } catch {
    /* storage blocked */
  }
  return { cookie, local };
}

function writeCookie(ft: FirstTouch): void {
  try {
    const c = buildFirstTouchCookie(ft, window.location.hostname, window.location.protocol === 'https:');
    if (c) document.cookie = c;
  } catch {
    /* cookies blocked */
  }
}

function writeLocal(ft: FirstTouch): void {
  try {
    localStorage.setItem(FT_STORAGE_KEY, serializeFirstTouch(ft));
  } catch {
    /* storage blocked */
  }
}

/** The stored first touch, or null. Cookie wins (it is the cross-subdomain store). */
export function readFirstTouch(): FirstTouch | null {
  if (!isBrowser()) return null;
  const { cookie, local } = readStored();
  return cookie || local;
}

/** Facebook / Instagram / Messenger in-app browsers (WebView user agents). */
export function isMetaInAppBrowser(ua: string | null | undefined): boolean {
  return /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Messenger/i.test(ua || '');
}

/**
 * Google refuses OAuth inside embedded WebViews, so a Facebook/Instagram
 * in-app user who picks "Continue with Google" is told to reopen the page in
 * Safari/Chrome — a different cookie jar, where oq_ft does not exist. The only
 * thing that crosses that hop is the URL, so on /get-started inside a Meta
 * in-app browser we put the stored touch's tracked params back into the
 * address bar (history.replaceState, no navigation). "Open in browser" then
 * lands tagged and the server/client capture records it again.
 * Returns true when the URL was changed.
 */
export function retagUrlForInAppBrowser(ft: FirstTouch | null): boolean {
  if (!isBrowser() || !ft) return false;
  try {
    if (!isMetaInAppBrowser(navigator.userAgent)) return false;
    if (!window.location.pathname.startsWith('/get-started')) return false;
    const url = new URL(window.location.href);
    if (FT_PARAM_KEYS.some((k) => url.searchParams.get(k))) return false;
    let changed = false;
    for (const k of FT_PARAM_KEYS) {
      const v = ft[k];
      if (v) {
        url.searchParams.set(k, v);
        changed = true;
      }
    }
    if (!changed) return false;
    window.history.replaceState(window.history.state, '', url.toString());
    return true;
  } catch {
    return false;
  }
}

/** Store this page's tagged touch if none is stored; heal a half-missing store. */
export function captureFirstTouch(): FirstTouch | null {
  if (!isBrowser()) return null;
  try {
    const { cookie, local } = readStored();
    const existing = cookie || local;
    if (existing) {
      if (!local) writeLocal(existing);
      if (!cookie) writeCookie(existing);
      retagUrlForInAppBrowser(existing);
      return existing;
    }
    const ft = parseFirstTouch(window.location.href, document.referrer);
    if (!ft) return null;
    writeLocal(ft);
    writeCookie(ft);
    return ft;
  } catch {
    return null;
  }
}

interface RpcClient {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * Post-auth: persist the first touch onto the signed-in user's profile (once)
 * and their claims. Resolves after the RPC returns or `timeoutMs`, whichever is
 * first; never rejects.
 */
export async function recordFirstTouch(client: RpcClient, timeoutMs = 2500): Promise<unknown> {
  try {
    const ft = readFirstTouch();
    const call = Promise.resolve(
      client.rpc('record_first_touch_attribution', { p_attr: ft }),
    ).then(
      (res) => {
        if (res && res.error) console.warn('[attribution] record failed (non-fatal):', res.error);
        return res ? res.data : null;
      },
      (err) => {
        console.warn('[attribution] record failed (non-fatal):', err);
        return null;
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      return await Promise.race([call, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
