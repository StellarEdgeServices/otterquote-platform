'use client';

/**
 * Loop-proof guard for the contractor dashboard ⇄ /contractor/login redirect (D-211).
 *
 * ContractorShell bounces a not-yet-authenticated request to /contractor/login via
 * a CLIENT-SIDE router.replace. Next.js App Router client navigation does NOT set
 * document.referrer, so the old referrer-based guard could never detect a
 * dashboard → login bounce and could not break a same-origin dashboard ⇄ login
 * loop (postmortem 2026-06-16; PR #291 shipped then reverted via #292).
 *
 * Instead, the shell drops a one-shot marker in sessionStorage immediately before
 * it bounces. sessionStorage survives BOTH a client-side router.replace and a full
 * page navigation within the same tab. /contractor/login consumes the marker before
 * deciding whether to send an authenticated contractor back to the dashboard; a
 * FRESH marker means "you were just ejected from the dashboard gate — do NOT send
 * the user straight back", which breaks the loop.
 *
 * The marker is a timestamp, consumed (cleared) on read, so it suppresses at most
 * ONE redirect; a stale marker (older than the TTL) is ignored so a legitimate
 * later visit still redirects normally.
 */

export const CONTRACTOR_GATE_BOUNCE_KEY = 'oq_contractor_gate_bounce';

// Only treat a marker as a live loop signal if it was set very recently. A stale
// marker must never permanently suppress the legitimate already-authed → dashboard
// redirect.
export const CONTRACTOR_GATE_BOUNCE_TTL_MS = 10_000;

function safeSessionStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage;
  } catch {
    // sessionStorage access can throw (privacy mode / sandboxed iframe). Treat as
    // unavailable rather than crash the gate.
    return null;
  }
}

/**
 * Drop the one-shot bounce marker. Called by ContractorShell immediately before it
 * router.replace()s an unauthenticated/ineligible request to /contractor/login.
 */
export function markContractorGateBounce(now: number = Date.now()): void {
  const store = safeSessionStorage();
  if (!store) return;
  try {
    store.setItem(CONTRACTOR_GATE_BOUNCE_KEY, String(now));
  } catch {
    /* ignore write failures — the guard simply won't fire */
  }
}

/**
 * Consume the one-shot bounce marker. Returns true when a FRESH gate bounce was
 * recorded (the caller must NOT redirect back to the dashboard). Always clears the
 * marker, so it breaks at most one loop hop.
 */
export function consumeContractorGateBounce(now: number = Date.now()): boolean {
  const store = safeSessionStorage();
  if (!store) return false;
  let raw: string | null = null;
  try {
    raw = store.getItem(CONTRACTOR_GATE_BOUNCE_KEY);
    if (raw !== null) store.removeItem(CONTRACTOR_GATE_BOUNCE_KEY);
  } catch {
    return false;
  }
  if (raw === null) return false;
  const ts = Number(raw);
  if (!Number.isFinite(ts)) return false;
  const age = now - ts;
  return age >= 0 && age <= CONTRACTOR_GATE_BOUNCE_TTL_MS;
}
