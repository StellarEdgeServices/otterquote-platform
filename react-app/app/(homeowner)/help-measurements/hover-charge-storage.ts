/**
 * Client-side persistence for the Hover charge→order handoff (gh-951).
 *
 * gh-416's post-charge retry-safety (HoverPaymentForm's paidIntentId/orderFailed state)
 * lives ONLY in React component state. The #416 closure comment flagged the residual
 * this file closes: a full-page reload (browser refresh, HomeownerShell's own auth-gate
 * bounce via window.location.href, a mobile tab reclaim, etc.) between the Stripe charge
 * completing and the Hover order being created wipes that in-memory record. On remount
 * the page starts fresh at path-selection; if the homeowner buys Hover again, purchaseHover()
 * (page.tsx) creates a NEW PaymentIntent — the same double-charge shape gh-416 closed, via
 * a different vector.
 *
 * Fix shape: persist a minimal pointer to sessionStorage the moment the PaymentIntent is
 * created (page.tsx's purchaseHover, BEFORE the card form even mounts — i.e. before the
 * charge is initiated), and read it back on the next mount. The persisted record carries
 * only the claim id + PaymentIntent id — no card data, no amounts (the EF re-derives and
 * re-verifies those server-side, D-181/D-205).
 *
 * Idempotency is NOT reinvented here: create-hover-order
 * (supabase/functions/create-hover-order/index.ts:241-253) already dedupes on
 * `homeowner_stripe_payment_intent_id` and returns the existing order rather than creating
 * a second one, and its D-181 guard (same file:96-140) rejects any PaymentIntent that has
 * not reached status='succeeded' server-side. Resuming with a stale (never-charged) id is
 * therefore safe to attempt — see page.tsx's resume effect for how the result is still
 * interpreted defensively (a swallowed EF rejection must not read as a false success).
 *
 * sessionStorage (not localStorage): the record should not outlive the browser session,
 * and should not follow the homeowner to a different device/tab.
 */

const STORAGE_KEY = 'oq_hm_hover_charge_v1';

export interface PendingHoverCharge {
  claimId: string;
  paymentIntentId: string;
  /** Date.now() at write time — informational only, not used to expire the record. */
  ts: number;
}

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage;
  } catch {
    // Storage can throw in locked-down/private-browsing contexts — degrade to "no record".
    return null;
  }
}

/** Persist the pending charge pointer. Best-effort — a storage failure is non-fatal. */
export function saveHoverChargeRecord(record: PendingHoverCharge): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Non-fatal: worst case, a reload during this window loses resume-ability exactly
    // like it did before this fix — never worse than the pre-fix behaviour.
  }
}

/** Read the pending charge pointer, if any. Returns null on any parse/storage failure. */
export function readHoverChargeRecord(): PendingHoverCharge | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.claimId === 'string' &&
      typeof parsed.paymentIntentId === 'string' &&
      typeof parsed.ts === 'number'
    ) {
      return parsed as PendingHoverCharge;
    }
    return null;
  } catch {
    return null;
  }
}

/** Clear the pending charge pointer. Best-effort. */
export function clearHoverChargeRecord(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Non-fatal.
  }
}
