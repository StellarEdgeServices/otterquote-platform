/**
 * Lead-capture bridge — gh-2121 (LRS HO-1 S16), fix for PR #2163 REVIEW: FAIL
 * (comment 5821864061, M1; and comment 5822978578, M2 — see
 * linkPendingLeadOnce() below for M2).
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

/** Clear the captured lead. Callers (linkPendingLeadOnce below) call this
 * only once the RPC has produced a DEFINITIVE outcome — an HTTP response
 * in the ordinary 200–499 range, success or a real server-side rejection
 * alike — never before the call is even made and never when no real HTTP
 * response came back (status 0: network error / aborted fetch, or a 5xx
 * server error), so a capture that never got a real answer survives to be
 * retried by the next call site (M2 fix, comment 5822978578; M3 fix,
 * comment 5823511418). */
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
  // both satisfy PromiseLike. `status` is required (not optional): the real
  // client always sets it, INCLUDING on a network error or an aborted
  // fetch, where it resolves `{ data: null, error, status: 0 }` instead of
  // throwing (M3 fix, comment 5823511418) — see linkPendingLeadOnce below.
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data?: unknown; error: unknown; status: number }>;
}

/**
 * Fire-and-forget: if a pending lead is captured, link it to the now-
 * authenticated caller via the set_lead_converted RPC (this PR's
 * migration — auth.uid()-scoped server-side per S1, no user id is passed
 * from the client) and consume the capture once — but ONLY once — the
 * call has produced a definitive outcome.
 *
 * M2 fix (comment 5822978578): the original version cleared the capture
 * BEFORE awaiting the RPC. On the password path, get-started navigates to
 * /auth-callback in the same tick as this call (email auto-confirm is on
 * in production, so this is the common case, not an edge case), and that
 * navigation cancels the in-flight fetch (`net::ERR_ABORTED`). The
 * capture was already gone by then, so auth-callback's own
 * linkPendingLeadOnce() call had nothing left to retry — a real
 * `?lead=` link was silently dropped on ~3 in 10 real-browser trials.
 *
 * M3 fix (comment 5823511418, PR #2163 REVIEW: FAIL against the M2 fix
 * above): the M2 fix's premise was wrong for the REAL supabase-js client.
 * supabase-js never throws on a network error or an aborted fetch — it
 * resolves `{ data: null, error, status: 0 }` instead (see
 * node_modules/@supabase/postgrest-js's fetch wrapper, which catches the
 * rejection and turns it into a resolved response with `status: 0`
 * whenever `throwOnError()` was not called, which this repo never does).
 * So the M2 fix's `catch` branch — the one meant to "keep the capture for
 * retry" — never ran on a real network failure or an aborted request; the
 * `try` branch's unconditional `clearPendingLeadId()` ran instead and threw
 * the lead id away with no answer ever received.
 *
 * The real fix: clear the capture only when the RPC's `status` is a real
 * HTTP response in the ordinary 200–499 range — a success (`error` null,
 * `data` true or false; false is not an error, e.g. an already-converted
 * or too-old lead) OR a real server-side rejection (`error` set with a
 * 4xx status, e.g. an anon caller or a permission error) — because either
 * way the server has already given its final answer and retrying would
 * just get the same one. `status === 0` (no HTTP response at all: a
 * network failure or the request aborted mid-flight by page navigation —
 * the M2/M3 failure mode) or a 5xx (the server errored, not our caller)
 * means no definitive answer arrived, so the capture is left in place for
 * the next call site to retry — first-write-wins on the server makes a
 * retry harmless. A thrown exception is handled the same way, defensively,
 * even though the real client does not throw here. Never throws either
 * way — this never blocks or fails whatever auth flow called it.
 *
 * Bounded to `timeoutMs` (default 2.5 s, matching lib/attribution.ts's
 * recordFirstTouch): the underlying RPC keeps running in the background,
 * but this function stops waiting on it after the bound so a caller that
 * awaits it (auth-callback/page.tsx, before navigating away — the M3
 * fix's other half) is never blocked indefinitely by a hung request. A
 * timeout is not a definitive answer either, so it does not clear the
 * capture — the underlying call may still resolve and clear it later, or
 * the capture survives for the next call site to retry.
 *
 * Called from: get-started/page.tsx (password sign-up, only when no
 * session exists yet — see that file's comment for why), auth-callback/
 * page.tsx (every path that lands there with a live session: Google
 * OAuth — S4 — AND the password path once a session exists, since
 * get-started defers to this call site precisely to dodge the M2 race —
 * AWAITED there, in parallel with recordFirstTouch, before any
 * navigation), and help-measurements/page.tsx + help-estimate/page.tsx
 * (an already-signed-in Arm F visitor reaching the help page directly
 * with a live `?lead=` — the third M1 scenario).
 */
export async function linkPendingLeadOnce(
  supabase: SupabaseRpcClient,
  timeoutMs = 2500,
): Promise<void> {
  const leadId = readPendingLeadId();
  if (!leadId) return;

  const attempt = (async () => {
    try {
      const { error, status } = await supabase.rpc('set_lead_converted', { p_lead_id: leadId });
      // A definitive answer is a real HTTP response in the ordinary
      // 200–499 range. status 0 (network error / aborted fetch — no HTTP
      // response was ever received) and 5xx (server error, not our
      // caller) are NOT definitive — see the function header (M3 fix).
      const isDefinitive = typeof status === 'number' && status >= 200 && status <= 499;
      if (isDefinitive) {
        clearPendingLeadId();
        if (error) {
          console.warn('[lead-capture] set_lead_converted failed (non-fatal):', error);
        }
      } else {
        console.warn(
          `[lead-capture] set_lead_converted got no definitive answer (status ${status}), keeping capture for retry:`,
          error,
        );
      }
    } catch (err) {
      // Defensive only: the real supabase-js client resolves rather than
      // throws here (see header). Treat a thrown error the same as
      // status 0 — no answer, keep the capture.
      console.warn('[lead-capture] set_lead_converted threw (non-fatal), keeping capture for retry:', err);
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => resolve(), timeoutMs);
  });
  try {
    await Promise.race([attempt, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
