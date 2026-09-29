/**
 * gh-1980 PR 3/3 (re-scoped: PKCE for Google OAuth ONLY; Dustin, #1980 comment
 * 5889011351). Emailed magic / recovery / confirmation links stay IMPLICIT
 * (`#access_token` fragments), so the shared client must stay implicit-flow.
 *
 * supabase-js 2.116.0 (auth-js GoTrueClient) picks the flow client-wide:
 *  - `_getSessionFromURL` throws "Not a valid implicit grant flow url." when a
 *    `?code=` return reaches an implicit client (and "Not a valid PKCE flow
 *    url." when a `#access_token` fragment reaches a pkce client);
 *  - `_isPKCECallback` only treats `?code=` as ours when a code-verifier is in
 *    storage (`<storageKey>-code-verifier`, or the `-flow-<id>-` slot when an
 *    `sb_flow_id` param is present).
 * So the shared client is built per page load: 'pkce' only when this very URL is
 * a verifier-backed `?code=` return (our own Google sign-in coming home), else
 * 'implicit'. Google INITIATION uses a dedicated pkce client (supabase-oauth.ts).
 */
import type { SupportedStorage } from '@supabase/supabase-js';

const FLOW_ID_PARAM = 'sb_flow_id';
// Canonical storageKey. Deliberately a literal (no import of ./cookie-storage): this module
// evaluates PAGE_LOAD_FLOW_TYPE at load, and pages' tests partially mock cookie-storage.
// gh1980-pr3-pkce-flow.test.ts asserts it equals OTTERQUOTE_AUTH_STORAGE_KEY.
const CANONICAL_STORAGE_KEY = 'sb-otterquote-auth';

export type OAuthFlowType = 'pkce' | 'implicit';

/** True for the auxiliary PKCE keys: `<key>-code-verifier` and `<key>-flow-<id>-code-verifier`. */
export function isCodeVerifierKey(key: unknown): key is string {
  return typeof key === 'string' && key.endsWith('-code-verifier');
}

/**
 * 'pkce' iff the current URL carries `?code=` AND a matching code-verifier is
 * stored (mirrors GoTrueClient._isPKCECallback); 'implicit' otherwise, including
 * every `#access_token` link, plain page load and server render.
 */
export function flowTypeForPageLoad(
  win: Pick<Window, 'location' | 'localStorage'> | undefined = typeof window === 'undefined' ? undefined : window,
  storageKey: string = CANONICAL_STORAGE_KEY,
): OAuthFlowType {
  try {
    if (!win) return 'implicit';
    const params = new URLSearchParams(win.location.search);
    if (!params.get('code')) return 'implicit';
    const flowId = params.get(FLOW_ID_PARAM);
    if (flowId && win.localStorage.getItem(`${storageKey}-flow-${flowId}-code-verifier`)) return 'pkce';
    return win.localStorage.getItem(`${storageKey}-code-verifier`) ? 'pkce' : 'implicit';
  } catch {
    return 'implicit';
  }
}

/**
 * Storage for the initiation-only pkce client: persists `*-code-verifier` keys
 * to the real (origin-scoped) storage so the callback's client can read them,
 * and is inert for everything else. The shared session (cookies) is never read,
 * written or cleared through it.
 */
export function createVerifierOnlyStorage(real: SupportedStorage): SupportedStorage {
  return {
    getItem: (key) => (isCodeVerifierKey(key) ? real.getItem(key) : null),
    setItem: (key, value) => {
      if (isCodeVerifierKey(key)) return real.setItem(key, value);
    },
    removeItem: (key) => {
      if (isCodeVerifierKey(key)) return real.removeItem(key);
    },
  };
}

/**
 * The flow the shared client was built with for THIS page load. Captured once at
 * module load, alongside app/lib/supabase.ts: a Google ?code= return stops looking
 * like one as soon as supabase-js exchanges the code and scrubs the URL.
 */
export const PAGE_LOAD_FLOW_TYPE: OAuthFlowType = flowTypeForPageLoad();
