/**
 * Lead-capture bridge — gh-2121 (LRS HO-1 S16), fix for PR #2163 REVIEW: FAIL
 * (comment 5821864061, M1).
 *
 * The gh-2046 strip script in app/layout.tsx captures `?lead=<uuid>` off the
 * URL on /get-started, /help-measurements and /help-estimate (Arm F's three
 * landing paths — js/router-variant-f.js:115-116,592-595) and, in addition
 * to the same-page-load `window.__oqRouterLeadId` bridge it always set,
 * NOW also persists it to sessionStorage under LEAD_STORAGE_KEY with a
 * short TTL marker, so it survives a later page load once
 * `window.__oqRouterLeadId` (a plain in-memory JS global) is gone.
 *
 * Why sessionStorage and not just the window global: a signed-out Arm F
 * visitor on /help-measurements or /help-estimate is bounced by
 * HomeownerShell to the static get-started page (a *different* React
 * mount, i.e. a fresh page load — the window global does not survive
 * that), and that bounce is itself a hop through otterquote.com before
 * landing back on /get-started (see HomeownerShell.tsx's redirect
 * comment). sessionStorage on app.otterquote.com does not read across that
 * origin change either, so HomeownerShell ALSO appends `?lead=` onto the
 * redirect target it builds from this module's read helper — belt and
 * suspenders: whichever mechanism survives a given browser's handling of
 * the round trip, the arriving page's own capture script (this same
 * multi-path script) re-captures it from the query string.
 *
 * TTL: 30 minutes — matches the existing get_lead_prefill/set_lead_role
 * RPC guard window documented in
 * supabase/migrations/20260916132127_gh1994_router_leads_columns.sql.
 * An expired or malformed entry is silently discarded (read returns null;
 * the negative control in the test suite covers this).
 */

export const LEAD_STORAGE_KEY = 'oq_pending_lead';
export const LEAD_CAPTURE_PATHS = ['/get-started', '/help-measurements', '/help-estimate'] as const;
export const LEAD_TTL_MS = 30 * 60 * 1000;

interface StoredLead {
  id: string;
  exp: number;
}

/**
 * Read the pending lead id, preferring the same-page-load
 * `window.__oqRouterLeadId` bridge (set moments ago by the beforeInteractive
 * strip script) and falling back to the sessionStorage marker for a later
 * page load. Returns null (and clears a stale entry) once past LEAD_TTL_MS,
 * or if nothing was ever captured — including a forged/garbage
 * sessionStorage value, which fails the JSON/shape check below rather than
 * being trusted.
 */
export function readPendingLeadId(): string | null {
  if (typeof window !== 'undefined' && window.__oqRouterLeadId) {
    return window.__oqRouterLeadId;
  }
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(LEAD_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredLead>;
    if (
      typeof parsed?.id !== 'string' ||
      !parsed.id ||
      typeof parsed.exp !== 'number' ||
      Date.now() > parsed.exp
    ) {
      sessionStorage.removeItem(LEAD_STORAGE_KEY);
      return null;
    }
    return parsed.id;
  } catch {
    return null;
  }
}

/** Clear the captured lead — called once it has been consumed (attempted),
 * successfully or not, so a given capture is only ever handed to
 * set_lead_converted once per module documented above. */
export function clearPendingLeadId(): void {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(LEAD_STORAGE_KEY);
  } catch {
    // non-fatal
  }
  if (typeof window !== 'undefined') {
    delete window.__oqRouterLeadId;
  }
}

interface SupabaseRpcClient {
  // PromiseLike, not Promise: the real supabase-js client's rpc() returns a
  // thenable PostgrestFilterBuilder (awaitable, but not a Promise instance),
  // and the test doubles used across this repo return a plain Promise —
  // both satisfy PromiseLike.
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ error: unknown }>;
}

/**
 * Fire-and-forget: if a pending lead is captured, link it to the now-
 * authenticated caller via the set_lead_converted RPC (this PR's
 * migration — auth.uid()-scoped server-side per S1, no user id is passed
 * from the client) and consume the capture so it is never retried. Never
 * throws; a failure (anon caller, expired lead, already-converted lead) is
 * logged and swallowed — this never blocks or fails whatever auth flow
 * called it.
 *
 * Called from: get-started/page.tsx (password sign-up), auth-callback/
 * page.tsx (Google OAuth landing — S4), and help-measurements/page.tsx +
 * help-estimate/page.tsx (an already-signed-in Arm F visitor reaching the
 * help page directly with a live `?lead=` — the third M1 scenario).
 */
export async function linkPendingLeadOnce(supabase: SupabaseRpcClient): Promise<void> {
  const leadId = readPendingLeadId();
  if (!leadId) return;
  clearPendingLeadId();
  try {
    const { error } = await supabase.rpc('set_lead_converted', { p_lead_id: leadId });
    if (error) {
      console.warn('[lead-capture] set_lead_converted failed (non-fatal):', error);
    }
  } catch (err) {
    console.warn('[lead-capture] set_lead_converted threw (non-fatal):', err);
  }
}
