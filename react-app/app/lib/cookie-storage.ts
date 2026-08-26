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
  // gh-867: Supabase imposes no session time-box on this project (0 of
  // 26,396 session rows carry a not_after value) and refresh-token rotation
  // is healthy well past a week — the prior 7-day default was a
  // self-imposed cap with no backend requirement behind it, forcing weekly
  // magic-link re-auth. 400 days is Chrome's Max-Age ceiling (anything
  // larger is silently clamped); this does not invalidate existing
  // sessions — they pick up the longer window on their next token refresh.
  const defaultSec = 400 * 24 * 3600; // 400 days — Chrome's Max-Age ceiling
  if (!expSec) return defaultSec;
  const remaining = expSec - Math.floor(Date.now() / 1000);
  return Math.max(3600, Math.max(remaining, defaultSec));
}

/**
 * Pull { sub, exp } from a stored session JSON string (or a bare access-token JWT)
 * by decoding the access token's payload. Returns null when the input is absent or
 * unparseable. Used to compare the per-origin localStorage copy against the shared
 * cookie session so a stale/cross-user copy can be detected (D-212 precedence).
 */
function extractSubExp(value: string | null): { sub: string | null; exp: number | null } | null {
  if (!value) return null;
  let token = value;
  if (value.charAt(0) === '{') {
    try {
      const parsed = JSON.parse(value);
      token = parsed && typeof parsed.access_token === 'string' ? parsed.access_token : '';
    } catch {
      return null;
    }
  }
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!payload || typeof payload !== 'object') return null;
    return {
      sub: typeof payload.sub === 'string' ? payload.sub : null,
      exp: typeof payload.exp === 'number' ? payload.exp : null,
    };
  } catch {
    return null;
  }
}

/**
 * Align the per-origin localStorage copy with the shared cookie session. Writes the
 * reconstructed cookie session to localStorage ONLY when the local copy is missing,
 * malformed, expired, or belongs to a different user (sub) than the cookie — so a
 * stale/cross-user value can never shadow the cookie on a subsequent read, while
 * avoiding needless writes when the two already agree. Best-effort: localStorage may
 * be unavailable/blocked, in which case the cookie return value is still correct.
 */
function hydrateFromCookie(key: string, cookieSession: string): void {
  try {
    const local = extractSubExp(window.localStorage.getItem(key));
    const cookie = extractSubExp(cookieSession);
    const nowSec = Math.floor(Date.now() / 1000);
    const localStale =
      !local ||
      local.sub !== (cookie ? cookie.sub : null) ||
      (local.exp !== null && local.exp <= nowSec);
    if (localStale) window.localStorage.setItem(key, cookieSession);
  } catch {
    /* localStorage blocked — cookie return value is still correct */
  }
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

// #488 — cookie-usability probe (memoized per page load). When cookies are
// blocked entirely the cookie cannot be canonical and localStorage remains
// the only viable store; everywhere else, absent cookies mean signed out.
let _cookiesUsable: boolean | null = null;
function cookiesUsable(): boolean {
  if (_cookiesUsable !== null) return _cookiesUsable;
  try {
    document.cookie = 'oq-cookie-probe=1; Path=/; Max-Age=60; SameSite=Lax';
    _cookiesUsable = document.cookie.indexOf('oq-cookie-probe=') !== -1;
    document.cookie = 'oq-cookie-probe=; Path=/; Max-Age=0; SameSite=Lax';
  } catch {
    _cookiesUsable = false;
  }
  return _cookiesUsable;
}

export const otterquoteCookieStorage: CookieStorage = {
  getItem(key: string): string | null {
    if (!isBrowser()) return null;

    // 1. Canonical two-cookie format — the cross-subdomain source of truth.
    // A valid shared cookie session ALWAYS wins over the per-origin localStorage
    // copy. localStorage is per-origin: the magic-link login runs on otterquote.com
    // and never populates app.otterquote.com's copy, so that copy may be empty,
    // expired, or left over from a previously-signed-in DIFFERENT user. Reconstruct
    // from the cookie and rehydrate localStorage whenever its copy is missing,
    // expired, or cross-user so a stale value can never shadow the cookie on a later
    // read (D-212 session-precedence fix).
    const at = readCookie(COOKIE_ACCESS);
    const rt = readCookie(COOKIE_REFRESH);
    if (at && rt) {
      const cookieSession = reconstructSession(at, rt);
      hydrateFromCookie(key, cookieSession);
      return cookieSession;
    }

    // 2. Cookies are canonical (#488). If BOTH cookies are absent the user is
    // signed out — the per-origin localStorage copy must never resurrect the
    // session (or rewrite the domain-wide cookies): that silently signed users
    // back in as the previous account after a sign-out on the other subdomain.
    // Purge local copies so sign-out sticks everywhere. Only a browser that
    // cannot hold cookies at all falls back to localStorage.
    if (cookiesUsable()) {
      try { window.localStorage.removeItem(key); } catch { /* ignore */ }
      try {
        for (const k of LEGACY_KEYS) window.localStorage.removeItem(k);
      } catch { /* ignore */ }
      return null;
    }

    // 3. Cookie-less browser fallback — localStorage is the only store left.
    let stored: string | null = null;
    try { stored = window.localStorage.getItem(key); } catch { /* ignore */ }
    if (stored) return stored;
    return readLegacy(key);
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

/**
 * The minimal session shape reconstructed from the two cross-subdomain cookies.
 * Mirrors what getItem() returns (and what supabase-js persists), parsed.
 */
export interface ReconstructedCookieSession {
  access_token: string;
  refresh_token: string;
  expires_at: number | null;
  expires_in: number | null;
  token_type: string;
  user: Record<string, unknown> | null;
}

/**
 * Reconstruct the shared cookie session and return it as a parsed object IFF the
 * cookie carries a structurally valid, NON-EXPIRED access token with a hydrated
 * user. Returns null otherwise (no cookie, malformed, no user, or expired).
 *
 * This lets the auth layer recover a known-good session WITHOUT going through a
 * possibly-slow-or-hung supabase getSession(): a stuck auth init must not
 * fail-close an authenticated contractor to /contractor/login when the valid
 * shared session is sitting right here in the cookie (D-212 session-precedence).
 * `now` (ms) is injectable for deterministic tests. SSR-safe: null off-browser.
 */
export function readValidCookieSession(now: number = Date.now()): ReconstructedCookieSession | null {
  if (!isBrowser()) return null;
  const at = readCookie(COOKIE_ACCESS);
  const rt = readCookie(COOKIE_REFRESH);
  if (!at || !rt) return null;
  let session: ReconstructedCookieSession;
  try {
    session = JSON.parse(reconstructSession(at, rt)) as ReconstructedCookieSession;
  } catch {
    return null;
  }
  // Treat as a live session only with a hydrated user and a future expiry. An
  // expired access token is intentionally rejected here — refreshing it is
  // supabase-js's job, not this fail-safe recovery path's.
  if (!session.user) return null;
  if (typeof session.expires_at !== 'number') return null;
  if (session.expires_at <= Math.floor(now / 1000)) return null;
  return session;
}

// Diagnostics + contract-test exports
export const _COOKIE_ACCESS  = COOKIE_ACCESS;
export const _COOKIE_REFRESH = COOKIE_REFRESH;
export { getCookieMaxAge as _getCookieMaxAge }; // gh-867 test hook

/* ───────────────────────────────────────────────────────────────────────────
 * Referral attribution bridge — Bridge 2026-08-26 (P0)
 *
 * TypeScript port of window.OtterQuoteReferral in js/cookie-storage.js.
 * Must stay byte-compatible with it: the static stack writes the cookie on
 * otterquote.com and this stack reads it on app.otterquote.com.
 *
 * Why it exists: ref.html wrote oq_referral_id / _agent_id / _code to
 * localStorage, then the funnel hopped to app.otterquote.com. localStorage is
 * ORIGIN-scoped, so every read here came back null and claims.referral_id was
 * never written — the one column apply_referral_commission() walks. No partner
 * could be paid for a referral that converted, and nothing surfaced it.
 * ─────────────────────────────────────────────────────────────────────────── */

export const REFERRAL_COOKIE = 'oq-ref';
const REFERRAL_KEYS = ['oq_referral_id', 'oq_referral_agent_id', 'oq_referral_code'] as const;
const REFERRAL_MAX_AGE = 60 * 60 * 24 * 90; // 90 days

export type ReferralIds = Partial<Record<(typeof REFERRAL_KEYS)[number], string>>;

/** Read referral ids, cookie FIRST so a cross-origin hop still resolves. */
export function readReferralIds(): ReferralIds {
  const out: ReferralIds = {};
  if (typeof document === 'undefined') return out;
  try {
    const raw = readCookie(REFERRAL_COOKIE);
    if (raw) Object.assign(out, JSON.parse(raw) as ReferralIds);
  } catch { /* malformed cookie — fall through to same-origin storage */ }
  for (const key of REFERRAL_KEYS) {
    if (out[key]) continue;
    try {
      const v = sessionStorage.getItem(key) || localStorage.getItem(key);
      if (v) out[key] = v;
    } catch { /* storage blocked */ }
  }
  return out;
}

/** Persist referral ids to storage AND the .otterquote.com cookie. */
export function writeReferralIds(ids: ReferralIds): void {
  if (typeof document === 'undefined' || !ids) return;
  const payload: Record<string, string> = {};
  for (const key of REFERRAL_KEYS) {
    const v = ids[key];
    if (!v) continue;
    payload[key] = String(v);
    try { localStorage.setItem(key, String(v)); } catch { /* storage blocked */ }
    try { sessionStorage.setItem(key, String(v)); } catch { /* storage blocked */ }
  }
  if (!Object.keys(payload).length) return;
  try { writeCookie(REFERRAL_COOKIE, JSON.stringify(payload), REFERRAL_MAX_AGE); } catch { /* cookie blocked */ }
}

/** Clear attribution once it has been stamped onto a claim. */
export function clearReferralIds(): void {
  if (typeof document === 'undefined') return;
  for (const key of REFERRAL_KEYS) {
    try { localStorage.removeItem(key); } catch { /* storage blocked */ }
    try { sessionStorage.removeItem(key); } catch { /* storage blocked */ }
  }
  try { deleteCookie(REFERRAL_COOKIE); } catch { /* cookie blocked */ }
}
