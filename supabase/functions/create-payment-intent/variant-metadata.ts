/**
 * [gh-2078c / D-330] Attach the router variant to a measurement PaymentIntent AFTER it is created.
 *
 * WHY NOT IN THE CREATE. The create call carries `Idempotency-Key: <type>-<claim_id>`: one key per claim, reused on every
 * Purchase click and every retry. Stripe compares a reused key's parameters with the first request's and answers HTTP 400
 * `idempotency_error` (and creates nothing) when they differ, for at least 24 hours. Every create parameter was fixed per
 * claim until `metadata[variant]` was added to it; the variant is the browser's stored router arm, so a retry from another
 * device, a second ad visit through a different ?v= link, or the static versus the React checkout would send a different
 * value and the homeowner could not pay (REVIEW: FAIL 5805531419, B1). So the create stays byte-identical to main and the
 * variant is set here, in a separate best-effort update that sends only `metadata[variant]`.
 *
 * The client confirms the card only after it has received `client_secret` from this function, so the metadata is in place
 * before `payment_intent.succeeded` fires and the server-side Meta CAPI Purchase (PR #2107) reads it.
 *
 * NEVER FAILS THE PAYMENT: any failure is swallowed and logged with a fixed message plus the HTTP status, never Stripe's body,
 * the URL, or the error's text.
 */

const VARIANT_SHAPE_RE = /^[a-z0-9]{1,8}$/;

/** Same bounded shape rule as the webhook's sanitizeCapiVariant: never forward an unbounded string into Stripe metadata. */
export function sanitizeVariantForMetadata(value: unknown): string {
  return typeof value === "string" && VARIANT_SHAPE_RE.test(value) ? value : "unknown";
}

export type AttachOutcome = "attached" | "skipped_status" | "failed";

export interface AttachArgs {
  fetchFn: typeof fetch;
  /** e.g. https://api.stripe.com/v1 */
  apiBase: string;
  /** Base64 of `<secret key>:` for HTTP Basic auth. */
  basicAuth: string;
  paymentIntentId: string;
  /** The status the create returned; a finished PaymentIntent is left alone. */
  status: string;
  variant: unknown;
  log?: (message: string) => void;
}

export async function attachVariantMetadata(a: AttachArgs): Promise<AttachOutcome> {
  const log = a.log ?? ((m: string) => console.error(m));
  if (a.status === "succeeded" || a.status === "canceled") return "skipped_status";
  try {
    const body = new URLSearchParams();
    body.append("metadata[variant]", sanitizeVariantForMetadata(a.variant));
    const res = await a.fetchFn(`${a.apiBase}/payment_intents/${a.paymentIntentId}`, {
      method: "POST",
      headers: { Authorization: `Basic ${a.basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      log(`[create-payment-intent] gh-2078c: attaching the variant to the PaymentIntent failed (HTTP ${res.status}); payment unaffected`);
      return "failed";
    }
    return "attached";
  } catch {
    // Never forward the thrown error: its text can carry the request URL.
    log("[create-payment-intent] gh-2078c: attaching the variant to the PaymentIntent threw; payment unaffected");
    return "failed";
  }
}
