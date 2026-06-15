/**
 * OtterQuote Cookie Storage Adapter v2 — D-212 cross-subdomain SSO fix.
 * ClickUp 86e1bpk7b — Bug fix May 12, 2026.
 *
 * TypeScript port of js/cookie-storage.js. See that file for the full design.
 *
 * Summary:
 *   - Two cookies (sb-otterquote-at, sb-otterquote-rt) at Domain=.otterquote.com
 *   - Token-only pattern: extract access + refresh from session JSON, reconstruct
 *     minimal session shape on read — well below Chrome's 4096-byte limit
 *   - Transparent migration from legacy keys (sb-{projectRef}-auth-token, sb_at)
 *   - Write-verification guard surfaces silent cookie drops as console warnings
 *   - SSR-safe: returns null / no-op when document or window are unavailable
 *
 * Both stacks (static js/ + React) MUST agree on storageKey + cookie names for
 * SSO to function. The constants exported here are the source of truth that
 * supabase.ts wires into createClient.
 */

interface CookieStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// Canonical storage key — must match window.OTTERQUOTE_AUTH_STORAGE_KEY in
// js/cookie-storage.js (static stack). Both stacks store sessions under this
// key so SSO across subdomains works.
export const OTTERQUOTE_AUTH_STORAGE_KEY = 'sb-otterquote-auth';

const COOKIE_ACCESS  = 'sb-otterquote-at';
const COOKIE_REFRESH = 'sb-otterquote-rt';

// Legacy keys consulted for transparent migration (read-only fallbacks).
const SUPABASE_PROJECT_REF: string = (() => {
  const url = (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_SUPABASE_URL) || '';
  const match = url.match(/https:\/\/([^.]+)/);
  return match ? match[1] : '';
})();

const LEGACY_KEYS: string[] = [];
if (SUPABASE_PROJECT_REF) LEGACY_KEYS.push(`sb-${SUPABASE_PROJECT_REF}-auth-token`);
LEGACY_KEYS.push('sb_at'); // React stack pre-fix key

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function getCookieDomain(): string {
  if (!isBrowser()) return '';
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return '';
  if (host.endsWith('.otterquote.com') || host === 'otterquote.com') {
    return '; Domain=.otterquote.com';
  }
  return ''; // Netlify preview URLs — no cross-domain
}

function getSecureFlag(): string {
  if (!isBrowser()) return '';
  return window.location.protocol === 'https:' ? '; Secure' : '';
}

function readCookie(key: string): string | null {
  if (!isBrowser() || !document.cookie) return null;
  const pairs = document.cookie.split('; ');
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    if (pair.substring(0, eqIdx) === key) {
      try {
        return decodeURIComponent(pair.substring(eqIdx + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function writeCookie(key: string, value: string, maxAge: number): void {
  if (!isBrowser()) return;
  const domain = getCookieDomain();
  const secure = getSecureFlag();
  document.cookie = `${key}=${encodeURIComponent(value)}; Path=/${domain}; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}

function deleteCookie(key: string): void {
  if (!isBrowser()) return;
  const domain = getCookieDomain();
  document.cookie = `${key}=; Path=/${domain}; Max-Age=0; SameSite=Lax`;
  document.cookie = `${key}=; Path=/; Max-Age=0; SameSite=Lax`;
}

interface ParsedSession {
  access: string;
  refresh: string;
  expSec: number | null;
}

function parseSession(jsonStr: string): ParsedSession | null {
  if (typeof jsonStr !== 'string' || !jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.access_token || !parsed.refresh_token) return null;
    let expSec: number | null = parsed.expires_at || null;
    if (!expSec) {
      const parts = parsed.access_token.split('.');
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(atob(parts[1]));
          if (payload && payload.exp) expSec = payload.exp;
        } catch { /* invalid JWT */ }
      }
    }
    return { access: parsed.access_token, refresh: parsed.refresh_token, expSec };
  } catch {
    return null;
  }
}

/**
 * Reconstruct a Supabase session JSON string from access + refresh tokens.
 *
 * D-212 fix (ported from js/cookie-storage.js, May 13 2026): populate the user
 * object from JWT claims at reconstruction time. The previous TS port set
 * user:null on the assumption Supabase would auto-fetch via getUser(); in
 * practice, pages/providers reading session.user on init (e.g. AuthProvider's
 * resolveSession, contractor pages) got null and treated the user as logged-out
 * — breaking cross-subdomain SSO into the React app and warm reloads that
 * survive only as the sb-otterquote-at/rt cookies. Decoding the JWT payload
 * locally fills the same fields Supabase would have written.
 *
 * The payload segment is base64url; normalize to base64 before atob() (mirrors
 * auth-provider.tsx + middleware.ts). Without this, atob() throws on tokens
 * whose base64 contains '-' or '_' and user/expiry silently fall back to null.
 */
function reconstructSession(accessToken: string, refreshToken: string): string {
  let expSec: number | null = null;
  let expiresIn: number | null = null;
  let user: Record<string, unknown> | null = null;
  try {
    const parts = accessToken.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload) {
        if (payload.exp) {
          expSec = payload.exp;
          expiresIn = Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
        }
        if (payload.sub) {
          const iatIso = payload.iat ? new Date(payload.iat * 1000).toISOString() : null;
          user = {
            id: payload.sub,
            email: payload.email || null,
            aud: payload.aud || 'authenticated',
            role: payload.role || 'authenticated',
            app_metadata: payload.app_metadata || {},
            user_metadata: payload.user_metadata || {},
            email_confirmed_at: payload.email_verified ? iatIso : null,
            phone: payload.phone || '',
            confirmed_at: payload.email_verified ? iatIso : null,
            last_sign_in_at: iatIso,
            created_at: iatIso,
            updated_at: iatIso,
            identities: payload.user_metadata && payload.user_metadata.identities ? payload.user_metadata.identities : [],
          };
        }
      }
    }
  } catch { /* invalid JWT — leave nulls */ }
  return JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expSec,
    expires_in: expiresIn,
    token_type: 'bearer',
    user,
  });
}

function getCookieMaxAge(expSec: number | null): number {
  const defaultSec = 7 * 24 * 3600;
  if (!expSec) return defaultSec;
  const remaining = expSec - Math.floor(Date.now() / 1000);
  return Math.max(3600, Math.max(remaining, defaultSec));
}

function readLegacy(callerKey: string): string | null {
  if (!isBrowser()) return null;
  try {
    const direct = window.localStorage.getItem(callerKey);
    if (direct) return direct;
    for (const k of LEGACY_KEYS) {
      const v = window.localStorage.getItem(k);
      if (v) return v;
    }
  } catch { /* localStorage blocked */ }
  return null;
}

function verifyWrite(key: string, expected: string, label: string): boolean {
  const actual = readCookie(key);
  if (actual === null) {
    try {
      // eslint-disable-next-line no-console
      console.warn(
        `[OtterQuoteCookieStorage] write verification FAILED for ${key} ` +
        `(${label}). Cookie was silently dropped by the browser. ` +
        `Likely cause: size > 4096 bytes, blocked cookie, or browser policy. ` +
        `Token length: ${expected.length} chars. Cross-subdomain SSO will fail.`
      );
    } catch { /* ignore */ }
    return false;
  }
  return true;
}

export const otterquoteCookieStorage: CookieStorage = {
  getItem(key: string): string | null {
    if (!isBrowser()) return null;

    // 1. Canonical two-cookie format
    const at = readCookie(COOKIE_ACCESS);
    const rt = readCookie(COOKIE_REFRESH);
    if (at && rt) return reconstructSession(at, rt);

    // 2. Same-key localStorage (recent same-origin write)
    let stored: string | null = null;
    try { stored = window.localStorage.getItem(key); } catch { /* ignore */ }
    if (stored) {
      this.setItem(key, stored); // proactive migration
      return stored;
    }

    // 3. Legacy keys — transparent migration
    const legacy = readLegacy(key);
    if (legacy) {
      this.setItem(key, legacy);
      return legacy;
    }
    return null;
  },

  setItem(key: string, value: string): void {
    if (!isBrowser()) return;
    if (value === null || value === undefined || value === '') {
      this.removeItem(key);
      return;
    }
    const session = parseSession(value);
    if (!session) {
      try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
      return;
    }
    const maxAge = getCookieMaxAge(session.expSec);

    writeCookie(COOKIE_ACCESS,  session.access,  maxAge);
    writeCookie(COOKIE_REFRESH, session.refresh, maxAge);
    verifyWrite(COOKIE_ACCESS,  session.access,  'access_token');
    verifyWrite(COOKIE_REFRESH, session.refresh, 'refresh_token');

    try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
  },

  removeItem(key: string): void {
    if (!isBrowser()) return;
    deleteCookie(COOKIE_ACCESS);
    deleteCookie(COOKIE_REFRESH);
    try { window.localStorage.removeItem(key); } catch { /* ignore */ }
    try {
      for (const k of LEGACY_KEYS) window.localStorage.removeItem(k);
    } catch { /* ignore */ }
  },
};

// Diagnostics + contract-test exports
export const _COOKIE_ACCESS  = COOKIE_ACCESS;
export const _COOKIE_REFRESH = COOKIE_REFRESH;
