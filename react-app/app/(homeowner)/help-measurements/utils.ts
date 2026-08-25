/**
 * Homeowner help-measurements pure helpers — D-211 Phase 28, PR 1/2 (ADDITIVE).
 *
 * Every function here is pure, DOM-free, and network-free — ported 1:1 from the inline JS in
 * help-measurements.html. The eventual page (PR 2/2) is the only place that touches the DOM,
 * Supabase, Stripe.js, or the Services.* Edge-Function calls; it collects raw claim / profile /
 * user state and hands it to these helpers, which assemble the typed Services.* param objects.
 *
 * Param builders are typed against the EXISTING exported interfaces in app/lib/services.ts
 * (CreateHoverPaymentIntentParams, CreateHoverOrderParams, SendAdjusterEmailParams) so the
 * page (PR 2) can pass the results straight through.
 *
 * FAITHFUL-PORT NOTES:
 *   • TWO distinct homeowner-name resolutions coexist in the static and are BOTH preserved:
 *       – Hover order  (help-measurements.html:972-974) → resolveHomeownerName():
 *         full_name || `${first_name} ${last_name}`.trim() || 'Homeowner'.
 *       – Adjuster email (help-measurements.html:1064) → the SIMPLER full_name || 'Homeowner'
 *         (no first/last fallback). buildAdjusterEmailParams deliberately does NOT call
 *         resolveHomeownerName. Do not unify them.
 *   • amount (1500 cents) on the payment-intent params and amount_charged (15.00) on the
 *     order params are INFORMATIONAL — the create-hover-* Edge Functions enforce the price
 *     server-side (D-291, repricing D-205 / D-181's now-superseded $150). They are kept
 *     verbatim for parity, not as the source of truth. Tier-3 charge/price logic is untouched
 *     by this PR.
 *   • isAdjusterFormValid mirrors the static `checkReady` (help-measurements.html:1021-1024),
 *     which gates ONLY on the email (non-empty AND contains '@'). The static wires a listener
 *     on the name field too, but that listener calls the same email-only check — the name is
 *     never part of the predicate. adjusterName is accepted in the input shape for parity but
 *     is intentionally not gated on.
 *   • The param builders take a loaded claim/user (id: string) as a precondition — the same
 *     contract H5 used (caller resolves state first). The static read `currentClaim?.id`
 *     with no guard; the EF validates regardless. This declares that precondition in the type
 *     rather than passing a possibly-undefined id through (no behavior invented, no static fix).
 *
 * ⚠️ STATIC DISCREPANCY (carried to the PR body for the CTO to ticket — NOT fixed here):
 *   help-measurements.html calls TWO helpers that are never defined in the file:
 *     – updateEmailPreview()  (called at :822 and :791-flow) — no definition, and NO email
 *       preview template text exists anywhere in the file. The #emailPreview div is left at its
 *       'Loading...' default. Its evident intent is "render a preview of the adjuster email",
 *       but there is no source copy to port — fabricating a body would invent unverifiable copy
 *       (cf. the H2 fabricated-legal-copy STOP), so it is intentionally NOT implemented here.
 *     – validateForm()  (called at :823) — no definition. Its evident intent is the send-button
 *       readiness gate, which IS reproduced cleanly as isAdjusterFormValid (mirroring checkReady).
 *   Because prefillAdjusterInfo() (static:817-824) calls both undefined helpers inside the init
 *   try/catch, the static would throw a ReferenceError on load and surface 'Failed to load page.'
 *   This is a real static bug; PR 2 must supply working equivalents (it gets isAdjusterFormValid
 *   for free and simply should not call a non-existent updateEmailPreview).
 */

import type {
  CreateHoverPaymentIntentParams,
  CreateHoverOrderParams,
  SendAdjusterEmailParams,
} from '../../lib/services';

// ── D-291 / D-181 constants (informational — EF enforces server-side) ──────────────
// D-291 (2026-08-17) repriced the RoofScope/Hover measurement fee from D-205's $150 to $15.

/** Hover fee in cents, sent on the PaymentIntent params (help-measurements.html:897). */
export const HOVER_AMOUNT_CENTS = 1500 as const;
/** Hover fee in dollars, sent as amount_charged on the order (help-measurements.html:987). */
export const HOVER_AMOUNT_DOLLARS = 15.0 as const;
/** D-205 deliverable: 3 = Complete (universal for full-replacement). help-measurements.html:988. */
export const HOVER_DELIVERABLE_TYPE_ID = 3 as const;
/** PaymentIntent description (help-measurements.html:898). */
export const HOVER_PAYMENT_DESCRIPTION = 'Complete Property Report' as const;
/** request_type sent to send-adjuster-email for this page (help-measurements.html:1067). */
export const MEASUREMENTS_REQUEST_TYPE = 'measurements' as const;

// ── Minimal input shapes (loaded state the PR-2 page supplies) ─────────────────────

/** Subset of the homeowner profile these helpers read. All fields optional/nullable. */
export interface HomeownerProfile {
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  address_city?: string | null;
  address_state?: string | null;
  address_zip?: string | null;
}

/** Subset of the claim these helpers read (id is a loaded-claim precondition). */
export interface MeasurementsClaim {
  id: string;
  property_address?: string | null;
  claim_number?: string | null;
}

/** Subset of the authed user these helpers read. */
export interface MeasurementsUser {
  id: string;
  email?: string | null;
}

// ── Homeowner name (help-measurements.html:972-974) ────────────────────────────────

/**
 * Resolve the homeowner's display name for the HOVER order: full_name, else first+last
 * trimmed, else 'Homeowner'. Mirrors the static's createHoverOrder name resolution.
 * NOTE: the adjuster-email path uses a simpler resolution (see buildAdjusterEmailParams).
 */
export function resolveHomeownerName(profile: HomeownerProfile | null | undefined): string {
  return (
    profile?.full_name ||
    `${profile?.first_name || ''} ${profile?.last_name || ''}`.trim() ||
    'Homeowner'
  );
}

// ── Address line 1 (help-measurements.html:979-980) ────────────────────────────────

/**
 * address_line_1 for the Hover order: profile.address_line1, else the first comma-segment of
 * the claim's property_address (trimmed), else ''. Mirrors the static expression exactly.
 */
export function resolveAddressLine1(
  profile: HomeownerProfile | null | undefined,
  claim: MeasurementsClaim | null | undefined,
): string {
  return (
    profile?.address_line1 ||
    claim?.property_address?.split(',')[0]?.trim() ||
    ''
  );
}

// ── Hover PaymentIntent params (help-measurements.html:895-899) ────────────────────

/**
 * Build the createHoverPaymentIntent params. amount is informational (the EF enforces the
 * $15 price server-side); kept at 1500 cents for parity. No charge is made here — this only
 * shapes the request the PR-2 page sends to create the PaymentIntent.
 */
export function buildHoverPaymentIntentParams(
  claim: MeasurementsClaim,
): CreateHoverPaymentIntentParams {
  return {
    claim_id: claim.id,
    amount: HOVER_AMOUNT_CENTS,
    description: HOVER_PAYMENT_DESCRIPTION,
  };
}

// ── PaymentIntent id from client_secret (gh-951 resume) ─────────────────────────────

/**
 * Extract the PaymentIntent id from a Stripe client_secret (`pi_XXX_secret_YYY` → `pi_XXX`).
 * Pure string parsing — no network, no Stripe.js. Used to persist a resume pointer the
 * moment the PaymentIntent is created (page.tsx), before the charge is initiated, so a
 * full-page reload during the charge→order window doesn't lose it (gh-951, see
 * ./hover-charge-storage.ts). Returns null for anything that doesn't look like a real
 * client_secret.
 */
export function paymentIntentIdFromClientSecret(
  clientSecret: string | null | undefined,
): string | null {
  if (!clientSecret) return null;
  const id = clientSecret.split('_secret_')[0];
  return id && id.startsWith('pi_') ? id : null;
}

// ── Hover order params (help-measurements.html:976-990) ────────────────────────────

/**
 * Assemble the createHoverOrder params from loaded profile/claim/user + the confirmed Stripe
 * PaymentIntent id. amount_charged (15.00) and deliverable_type_id (3) are the D-291/D-205
 * values; the EF re-validates them. payment_intent_id is the D-181 verification guard.
 */
export function buildHoverOrderParams({
  profile,
  claim,
  user,
  paymentIntentId,
}: {
  profile: HomeownerProfile | null | undefined;
  claim: MeasurementsClaim;
  user: MeasurementsUser | null | undefined;
  paymentIntentId: string;
}): CreateHoverOrderParams {
  return {
    claim_id: claim.id,
    user_id: user?.id || '',
    address_line_1: resolveAddressLine1(profile, claim),
    address_city: profile?.address_city || '',
    address_state: profile?.address_state || '',
    address_zip: profile?.address_zip || '',
    homeowner_name: resolveHomeownerName(profile),
    homeowner_email: user?.email || '',
    homeowner_phone: profile?.phone || '',
    amount_charged: HOVER_AMOUNT_DOLLARS,
    deliverable_type_id: HOVER_DELIVERABLE_TYPE_ID,
    payment_intent_id: paymentIntentId,
  };
}

// ── Adjuster email params (help-measurements.html:1060-1068) ───────────────────────

/**
 * Assemble the sendAdjusterEmail params for the measurements request. homeowner_name uses the
 * SIMPLER full_name || 'Homeowner' (static:1064) — deliberately NOT resolveHomeownerName.
 * homeowner_phone falls back profile.phone → adjusterPhone → '' (static:1065). claim_number is
 * null when absent. request_type is fixed to 'measurements'.
 */
export function buildAdjusterEmailParams({
  claim,
  profile,
  adjusterName,
  adjusterEmail,
  adjusterPhone,
}: {
  claim: MeasurementsClaim;
  profile: HomeownerProfile | null | undefined;
  adjusterName: string;
  adjusterEmail: string;
  adjusterPhone: string;
}): SendAdjusterEmailParams {
  return {
    claim_id: claim.id,
    adjuster_name: adjusterName || 'Adjuster',
    adjuster_email: adjusterEmail,
    homeowner_name: profile?.full_name || 'Homeowner',
    homeowner_phone: profile?.phone || adjusterPhone || '',
    claim_number: claim.claim_number || undefined,
    request_type: MEASUREMENTS_REQUEST_TYPE,
  };
}

// ── Adjuster info write-back (help-measurements.html:1071-1077) ────────────────────

/** Subset of the claim the write-back reads (the currently-stored adjuster fields). */
export interface AdjusterWritebackClaim {
  adjuster_name?: string | null;
  adjuster_email?: string | null;
  adjuster_phone?: string | null;
}

/** The partial claims update the page applies after a measurement request. */
export interface AdjusterClaimWriteback {
  adjuster_name?: string;
  adjuster_email?: string;
  adjuster_phone?: string;
}

/**
 * Build the partial claims update written back after the measurement request is sent.
 * Mirrors the static EXACTLY (help-measurements.html:1071-1077): include a field ONLY
 * when a value was entered AND the claim's existing field is empty/absent. Returns {}
 * when there is nothing to write (the page then skips the update, like the static).
 * Pure — the page performs the actual supabase update with the returned object.
 */
export function buildAdjusterClaimWriteback({
  claim,
  adjusterName,
  adjusterEmail,
  adjusterPhone,
}: {
  claim: AdjusterWritebackClaim;
  adjusterName: string;
  adjusterEmail: string;
  adjusterPhone: string;
}): AdjusterClaimWriteback {
  const updates: AdjusterClaimWriteback = {};
  if (adjusterName && !claim.adjuster_name) updates.adjuster_name = adjusterName;
  if (adjusterEmail && !claim.adjuster_email) updates.adjuster_email = adjusterEmail;
  if (adjusterPhone && !claim.adjuster_phone) updates.adjuster_phone = adjusterPhone;
  return updates;
}

// ── Adjuster form readiness (help-measurements.html:1021-1024) ─────────────────────

/**
 * Whether the "Send Request to Adjuster" button is enabled. Mirrors the static `checkReady`:
 * the email must be non-empty (after trim) AND contain '@'. The name is NOT part of the gate
 * (the static's name-field listener calls this same email-only check); adjusterName is accepted
 * for input parity but ignored by the predicate.
 */
export function isAdjusterFormValid({
  adjusterEmail,
}: {
  adjusterEmail: string;
  adjusterName?: string;
}): boolean {
  const email = (adjusterEmail || '').trim();
  return !!email && email.includes('@');
}

// ── Path selection (help-measurements.html:851-855) ────────────────────────────────

export type MeasurementPath = 'hover' | 'adjuster';

/**
 * Which flow the chosen path activates. The static branches on `path === 'hover'`: the Hover
 * section when true, the adjuster section otherwise. Mirrors that single decision.
 */
export function isHoverPath(path: string | null | undefined): boolean {
  return path === 'hover';
}
