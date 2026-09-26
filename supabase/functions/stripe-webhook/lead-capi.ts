/**
 * [gh-2121 / HO-3] Meta CAPI Purchase for the no-account, lead-keyed $15
 * measurement purchase, alongside meta-capi.ts's existing
 * handleMeasurementOrderCapiPurchase (claim-keyed, for a signed-in
 * homeowner). Deliberately a SEPARATE function/module rather than an
 * extension of MEASUREMENT_ORDER_PI_TYPES: that handler's person-resolution
 * path (decideCapiPerson / claims / profiles / auth.admin) assumes a
 * claim_id and a user account, neither of which a lead-keyed PaymentIntent
 * has. Extending it in place would mean every lead purchase gets skipped as
 * "no_claim_id" -- exactly the drop this module exists to avoid.
 *
 * Everything else about the design is intentionally IDENTICAL to the
 * claim-keyed path: same GPC-metadata check, same USD/$15 pin, same
 * suppression list, same test-traffic gate (leads.is_synthetic standing in
 * for claims.is_test -- Ben's Ruling 4: founder/test exclusions and
 * is_synthetic behave exactly as in Arm F), same PaymentIntent-scoped claim
 * dedupe. index.ts imports the shared primitives from ./meta-capi.ts and
 * calls handleLeadMeasurementCapiPurchase alongside (never instead of)
 * handleMeasurementOrderCapiPurchase.
 *
 * Pure decision logic lives here so it is unit-testable without a live
 * Supabase client or a real Meta call -- same convention as
 * payment-intent-checks.ts / meta-capi.ts itself.
 */

export const LEAD_MEASUREMENT_PI_TYPE = "lead_measurement_order";

// deno-lint-ignore no-explicit-any
type PaymentIntentLike = any;

/** Only a PI whose metadata.type is exactly this feature's own value is ever considered here -- never touches the claim-keyed types. */
export function isLeadMeasurementPurchase(pi: PaymentIntentLike): boolean {
  return pi?.metadata?.type === LEAD_MEASUREMENT_PI_TYPE;
}

/**
 * The lead-keyed counterpart to meta-capi.ts's decideCapiPerson. A lead IS
 * the person (there is no separate account/profile to resolve), so this is
 * simpler: skip only when the lead itself could not be resolved. An empty
 * email (phone-only leads store '' per leads.email NOT NULL) is not a skip
 * reason -- the Purchase is still sent, with reduced match quality, exactly
 * like the claim-keyed path's "no email resolvable" case.
 */
export function decideLeadCapiPerson(input: {
  leadId: string | null | undefined;
  leadLookupFailed: boolean;
}): { skip: boolean; reason: "lead_lookup_failed" | "no_lead_id" | null } {
  if (input.leadLookupFailed) return { skip: true, reason: "lead_lookup_failed" };
  if (!input.leadId) return { skip: true, reason: "no_lead_id" };
  return { skip: false, reason: null };
}

export interface LeadRow {
  id: string;
  email: string | null;
  is_synthetic: boolean | null;
}

/** Resolves the fields this handler needs from a `leads` row lookup, tolerating a missing/null email the same way the claim path tolerates a missing profile email. */
export function resolveLeadForCapi(lead: LeadRow | null): { email: string | null; isSynthetic: boolean } {
  return {
    email: lead?.email && lead.email.length > 0 ? lead.email : null,
    isSynthetic: lead?.is_synthetic === true,
  };
}
