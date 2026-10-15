/**
 * gh-1759 — which Stripe dispute-evidence fields take TEXT and which take a FILE ID.
 *
 * Observed on production 2026-10-07 (issue #1759, comment 6049034304): a signed
 * test-mode `charge.dispute.created` for a charge that resolves to a claim took
 * the auto-submit route, and Stripe rejected the evidence call with
 *     No such file_upload: 'TRANSACTION RECORD — Otter Quotes Platform Fee ...'
 * because `evidence[service_documentation]`, `evidence[customer_communication]`
 * and `evidence[receipt]` are FILE fields (they want a `file_...` id from
 * POST /v1/files), and the handler was putting prose (and, for the receipt, a
 * URL) in them. No dispute could ever have been auto-answered.
 *
 * The text-bearing fields Stripe accepts are `product_description` (<= 20,000
 * chars) and `uncategorized_text` (<= 20,000 chars; 150,000 is the COMBINED limit
 * across all evidence fields, not a per-field limit). This module is the single
 * place that maps the handler's three prose blocks onto those two, so a test can
 * pin it without importing index.ts (which starts a server at import time).
 *
 * Source of the field types: Stripe API reference, "Update a dispute",
 * `evidence` hash. Re-check there before adding a key.
 */

/** Evidence keys Stripe types as FILE ids. Sending prose or a URL here is rejected. */
export const FILE_TYPED_EVIDENCE_FIELDS: ReadonlySet<string> = new Set([
  "cancellation_policy",
  "customer_communication",
  "customer_signature",
  "duplicate_charge_documentation",
  "receipt",
  "refund_policy",
  "service_documentation",
  "shipping_documentation",
  "uncategorized_file",
]);

export const PRODUCT_DESCRIPTION_MAX = 20_000;
export const UNCATEGORIZED_TEXT_MAX = 20_000;

/**
 * Build the TEXT-ONLY evidence hash (form-encoded keys, as `stripeRequest` sends).
 * Never emits a file-typed key. `evidence[submit]` is NOT set here: that decision
 * stays with `maySubmitFinalEvidence` (gate 2) in index.ts.
 */
export function assembleTextEvidence(parts: {
  productDescription: string;
  serviceDocumentation: string;
  customerCommunication: string;
  invoiceUrl?: string | null;
}): Record<string, string> {
  const blocks = [
    "SERVICE DOCUMENTATION",
    parts.serviceDocumentation,
    "",
    "CUSTOMER COMMUNICATION",
    parts.customerCommunication,
  ];
  if (parts.invoiceUrl) {
    blocks.push("", `INVOICE URL (D-215 Layer 3): ${parts.invoiceUrl}`);
  }
  return {
    "evidence[product_description]": parts.productDescription.slice(0, PRODUCT_DESCRIPTION_MAX),
    "evidence[uncategorized_text]": blocks.join("\n").slice(0, UNCATEGORIZED_TEXT_MAX),
  };
}

/** Returns the offending keys (empty array = every key is text-safe). */
export function fileTypedKeysIn(evidence: Record<string, string>): string[] {
  return Object.keys(evidence).filter((k) => {
    const m = /^evidence\[(.+)\]$/.exec(k);
    return m !== null && FILE_TYPED_EVIDENCE_FIELDS.has(m[1]);
  });
}
