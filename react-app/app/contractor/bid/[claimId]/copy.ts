'use client';

/**
 * Contractor Bid Form — UI copy + verbatim legal/fee strings
 * (D-211 Phase 7, port of contractor-bid-form.html).
 *
 * ⚠️ Tier-3 VERBATIM copy lives here and is ported BYTE-FOR-BYTE from the static
 * page. Any wording change is Tier-3 → STOP and gate to Dustin (D-220; mirrors
 * D-214/D-215/D-230/D-244):
 *   - buildFeeDisclosureText      : D-214/D-215 UETA fee-acceptance disclosure
 *                                   (contractor-bid-form.html:5035 generateExactFeeText)
 *   - BID_COPY.fee.feeInfo*       : flat-5% fee-basis notes
 *                                   (contractor-bid-form.html:4368/4370)
 *   - CUSTOM_WARRANTY_TAIL        : D-204 "not verified / not the warrantor" tail
 *                                   (contractor-bid-form.html:4683)
 * The remaining strings are non-legal UX copy (gate prompts, rescind status,
 * the bid-updated homeowner notification preview) ported as-is for parity.
 *
 * No DB-/user-sourced value is interpolated into HTML here — the page renders
 * everything as JSX text (no innerHTML), closing the static page's innerHTML
 * surfaces.
 */

// ── React route the bid form migrates to (PR 2 flips the static
//    contractor-bid-form.html in-app links to these). Dynamic-segment route
//    app/contractor/bid/[claimId]; modes carried as query params, matching the
//    static page (?renew=true, ?action=rescind). ──
export const BID_ROUTE_BASE = '/contractor/bid';

/** Canonical React bid-route path for a claim (replaces contractor-bid-form.html?claim_id=). */
export function bidRoutePath(claimId: string): string {
  return `${BID_ROUTE_BASE}/${encodeURIComponent(claimId)}`;
}

/** Renew an expired bid (D-150). Mirrors the static ?renew=true link. */
export function renewBidRoutePath(claimId: string): string {
  return `${bidRoutePath(claimId)}?renew=true`;
}

/** Rescind entry (email "Rescind My Bid"). Mirrors the static ?action=rescind link. */
export function rescindBidRoutePath(claimId: string): string {
  return `${bidRoutePath(claimId)}?action=rescind`;
}

export const BID_COPY = {
  pageTitleSubmit: 'Submit Your Bid',
  pageTitleChange: 'Change Your Bid',
  pageTitleRenew: 'Renew Your Bid',

  submitBtnSubmit: 'Submit Bid',
  submitBtnChange: 'Update Bid',
  submitBtnRenew: 'Renew Bid',

  // ── D-214/D-215 fee framework (VERBATIM — Tier-3) ──────────────────────────
  fee: {
    // Flat-5% basis notes (contractor-bid-form.html:4368/4370). `rcvFormatted` is
    // the already-formatted RCV currency string; the page passes it in.
    feeInfoInsurance: (rcvFormatted: string): string =>
      `ℹ A flat 5% platform fee based on the RCV (${rcvFormatted}) applies upon contract signing.`,
    feeInfoRetail: 'ℹ A flat 5% platform fee applies to all projects upon contract signing.',
  },

  // ── D-199 bid-time validation gate prompts (contractor-bid-form.html) ──────
  gate: {
    // checkBidCanSubmitGate fallbacks (:4714/:4724/:4729)
    cannotDetermineIdentity:
      'Cannot determine contractor identity. Please refresh and try again.',
    couldNotVerifyTemplate:
      'Could not verify your contract template status. Please refresh and try again.',
    networkError:
      'Network error verifying contract template. Please retry.',
    // Default RPC reason when the RPC returns no reason (:5117)
    notValidatedDefault:
      'Your contract template has not been validated for this trade and funding type.',
    // Appended to the reason in the confirm() dialog (:5118)
    uploadAndValidateSuffix:
      '\n\nUpload and validate it on your profile before bidding.',
    // Appended again before the confirm prompt (:5119)
    clickOkSuffix: '\n\nClick OK to go to your profile.',
  },

  // ── Rescind mode (contractor-bid-form.html initRescindMode) ────────────────
  rescind: {
    notLoggedIn: 'You must be logged in to rescind your bid.',
    couldNotLoadClaim: 'Could not load claim details. Please contact support.',
    noActiveBid:
      'No active bid found for this project. It may have already been withdrawn or does not exist.',
    // Shown when bid_status is not one of RESCINDABLE_STATUSES (:5748-5749).
    // `status` is the bid_status; rendered as JSX text, not innerHTML.
    notRescindable: (status: string): string =>
      `Bid status: ${status} — This bid cannot be withdrawn at its current stage. Only submitted, pending, or under-review bids can be rescinded.`,
    confirmBtn: 'Yes, Rescind My Bid',
    rescinding: 'Rescinding…',
    genericError: 'Failed to rescind bid. Please try again or contact support.',
  },

  // ── Change-bid homeowner notification preview (contractor-bid-form.html:5366) ──
  //    `company` falls back to 'A contractor' (matches the static `|| 'A contractor'`).
  bidUpdatedPreview: (company: string | null | undefined): string =>
    `${company || 'A contractor'} has updated their bid for your project. Please review the new figures.`,
} as const;

/**
 * D-214/D-215 fee-acceptance disclosure — VERBATIM (Tier-3).
 * Byte-for-byte port of contractor-bid-form.html:5035 (generateExactFeeText),
 * including the `.toFixed(2)` percentage and `toLocaleString('en-US', currency)`
 * formatting, which are part of the legally-displayed string captured in
 * fee_acceptances.fee_text_displayed (UETA Layer 1 evidence).
 *
 * @param feePct    platform fee percentage (e.g. 5)
 * @param feeAmount fee dollar amount
 * @param bidAmount the contractor's bid amount (net = bid − fee)
 */
export function buildFeeDisclosureText(
  feePct: number,
  feeAmount: number,
  bidAmount: number,
): string {
  const netAmount = bidAmount - feeAmount;
  const pct = feePct.toFixed(2);
  const fee = feeAmount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const net = netAmount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  return `By submitting this bid, you agree to pay Otter Quotes a platform fee of ${pct}% (${fee}) upon contract execution. This fee is deducted from your bid amount before disbursement. You will receive ${net} upon completion. I understand and agree to the platform fee of ${pct}% (${fee})`;
}

/**
 * D-204 custom-warranty legal tail — VERBATIM (Tier-3). Appended to the custom
 * warranty snapshot string when a contractor enters a free-text ("Other")
 * warranty. Byte-for-byte from contractor-bid-form.html:4683.
 */
export const CUSTOM_WARRANTY_TAIL =
  '. Administered by manufacturer; not verified by Otter Quotes per D-204. Otter Quotes is not the warrantor.';
