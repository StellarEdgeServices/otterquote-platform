/**
 * gh-3471 (D-419): the return flag. A signed-out click on a measurement link must come back to the measurement checkout
 * after sign-up, with no new customer wording.
 *
 * The flag is a TOKEN from the closed allowlist below, never a URL or a path. The only place a destination is built is
 * RETURN_TARGETS, so no query value, stored value or fragment can steer anyone anywhere else (no open redirect). It never
 * skips a step: sign-up, consent and the dashboard's state gate all still run, because the token only chooses what the
 * dashboard forwards to once they are done. Mirrored by js/auth.js (RETURN_TARGETS); tests/gh3471-return-flag-allowlist.mjs
 * fails if the two lists differ.
 */

export const RETURN_TARGETS = {
  measurements: 'https://otterquote.com/help-measurements.html',
} as const;

export type ReturnToken = keyof typeof RETURN_TARGETS;

export const RETURN_STORAGE_KEY = 'oq_return';

/** The token for a raw value, or null. Exact match on an own key only ('__proto__', 'constructor', 'MEASUREMENTS', URLs: null). */
export function parseReturnToken(value: unknown): ReturnToken | null {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RETURN_TARGETS, value)
    ? (value as ReturnToken)
    : null;
}

/** `url` with `return=<token>` added (query-safe), or `url` unchanged when there is no token. */
export function withReturn(url: string, token: ReturnToken | null): string {
  if (!token) return url;
  return url + (url.includes('?') ? '&' : '?') + 'return=' + encodeURIComponent(token);
}

/**
 * get-started: remember a valid ?return= for this tab until sign-up lands on /auth-callback (same origin, so it survives
 * Google's round trip). A page load with no valid token clears an old one, so a stale flag never outlives a new visit.
 */
export function captureReturnFromUrl(search: string): ReturnToken | null {
  let token: ReturnToken | null = null;
  try { token = parseReturnToken(new URLSearchParams(search).get('return')); } catch { /* malformed query */ }
  try {
    if (token) sessionStorage.setItem(RETURN_STORAGE_KEY, token);
    else sessionStorage.removeItem(RETURN_STORAGE_KEY);
  } catch { /* storage blocked: the flag is simply not kept */ }
  return token;
}

/** auth-callback: the remembered token (re-validated on read), cleared as it is taken. */
export function takeStoredReturn(): ReturnToken | null {
  try {
    const token = parseReturnToken(sessionStorage.getItem(RETURN_STORAGE_KEY));
    sessionStorage.removeItem(RETURN_STORAGE_KEY);
    return token;
  } catch {
    return null;
  }
}

/** trade-selector: the token on the current URL. */
export function readReturnFromUrl(search: string): ReturnToken | null {
  try { return parseReturnToken(new URLSearchParams(search).get('return')); } catch { return null; }
}
