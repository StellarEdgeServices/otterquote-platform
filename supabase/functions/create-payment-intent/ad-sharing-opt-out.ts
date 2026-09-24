/**
 * [gh-2107 / D-330 half 2] Record a Global Privacy Control (GPC) advertising-sharing opt-out at PaymentIntent creation.
 *
 * WHY HERE. Dustin's ruling "b." on the Section 12 opt-out gap (#2078 comment 5801822166, scope item 2): "The client reads
 * navigator.globalPrivacyControl, and the server honours the Sec-GPC header, setting the flag." The server-side Meta CAPI
 * Purchase is sent from the Stripe webhook, which has no browser context (Stripe calls it), so the only server code the
 * buyer's own browser reaches before paying is create-payment-intent. It already authenticates the caller, so the flag can
 * be written to THAT person's profile row (profiles.ad_sharing_opt_out, migration 20260924003805) before any Purchase exists.
 * The webhook then reads the flag and skips the CAPI send (a separate PR).
 *
 * EITHER SIGNAL SETS THE FLAG:
 *   - the request header `Sec-GPC: 1` (the browser sets it on every request when GPC is on; source `gpc_header`), or
 *   - a `gpc: true` field in the request body, which the page fills from `navigator.globalPrivacyControl` (source
 *     `gpc_client`; a belt for any path where a proxy strips the header).
 *
 * WHAT IT NEVER DOES:
 *   - It never CLEARS the flag. No GPC signal, or `Sec-GPC: 0`, leaves the profile as it is: an opt-out recorded earlier
 *     (by GPC on another day, or by an admin from a support email) must not be undone by a later request without the signal.
 *   - It never blocks or fails the payment. Any failure is swallowed and logged with a FIXED message plus an error code
 *     that passes a strict shape check, never the database's own message (which can quote a value).
 *   - It never runs for a non-measurement PaymentIntent, or without an authenticated caller.
 *
 * Pure and dependency-injected so it is unit-tested without a network or a database (ad-sharing-opt-out.test.ts).
 */

/** The PaymentIntent types whose purchase produces a Meta CAPI Purchase (same set as stripe-webhook's MEASUREMENT_ORDER_PI_TYPES). */
export const OPT_OUT_PI_TYPES: ReadonlySet<string> = new Set([
  "measurement_order",
  "hover_measurement", // the value the checkout pages send today
]);

export type OptOutSource = "gpc_header" | "gpc_client";

export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * Which GPC signal, if any, this request carries. Per the GPC spec the only meaningful value of Sec-GPC is "1"; anything
 * else (absent, "0", garbage) is no signal. The header wins over the body when both are present.
 */
export function detectGpcSignal(headers: HeaderReader, body: unknown): OptOutSource | null {
  const h = headers.get("sec-gpc");
  if (h !== null && h.trim() === "1") return "gpc_header";
  if (body && typeof body === "object" && (body as Record<string, unknown>).gpc === true) return "gpc_client";
  return null;
}

/** The write the caller injects. Returns null on success, or `{ code }` on failure. Must set the flag TRUE and never clear it. */
export interface OptOutStore {
  markOptedOut(userId: string, source: OptOutSource, atIso: string): Promise<{ code?: string } | null>;
}

export type OptOutOutcome = "recorded" | "no_signal" | "not_applicable" | "failed";

export interface RecordArgs {
  callerId: string | null;
  piType: unknown;
  headers: HeaderReader;
  body: unknown;
  store: OptOutStore;
  now?: () => Date;
  log?: (message: string) => void;
}

/** SQLSTATE-style codes only: short, alphanumeric. Anything else is dropped so a message can never ride along in the "code". */
function safeCode(code: unknown): string {
  return typeof code === "string" && /^[A-Za-z0-9_]{1,20}$/.test(code) ? ` (code ${code})` : "";
}

export async function recordGpcOptOut(a: RecordArgs): Promise<OptOutOutcome> {
  const log = a.log ?? ((m: string) => console.error(m));
  if (!a.callerId) return "not_applicable";
  if (typeof a.piType !== "string" || !OPT_OUT_PI_TYPES.has(a.piType)) return "not_applicable";
  const source = detectGpcSignal(a.headers, a.body);
  if (!source) return "no_signal";
  try {
    const failure = await a.store.markOptedOut(a.callerId, source, (a.now ?? (() => new Date()))().toISOString());
    if (failure) {
      log(`[create-payment-intent] gh-2107: recording the GPC ad-sharing opt-out failed${safeCode(failure.code)}; payment unaffected`);
      return "failed";
    }
    return "recorded";
  } catch {
    // Never forward the thrown error: it can carry database text. The payment proceeds.
    log("[create-payment-intent] gh-2107: recording the GPC ad-sharing opt-out threw; payment unaffected");
    return "failed";
  }
}
