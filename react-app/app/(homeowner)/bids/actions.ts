'use client';

/**
 * Homeowner bids actions (D-211 P21) — thin wrappers over the singleton for the
 * writes + Edge Function calls the bids page performs.
 *
 * SECURITY (matches dashboard/actions.ts, post-Phase-19): every Edge Function is
 * invoked via supabase.functions.invoke, which attaches the caller's session JWT
 * automatically. The static bids.html called these EFs with a raw fetch carrying
 * the anon-key as bearer — that pattern is intentionally NOT reproduced here:
 *   • get-contractor-info  (verify_jwt=true) — JWT via invoke, not anon bearer.
 *   • get-hover-siding-data (JWT + claim-ownership gate, Phase 16 Unit 2) —
 *     called AS-IS; a missing/invalid JWT now returns 401/403. EF unchanged.
 *   • send-support-email   — invoked under the user's authenticated session.
 * These EFs are deployed and CALLED here unchanged (changing one is Tier-3).
 *
 * The select→award→contract handoff (bids.html:1960-1997) is ported faithfully:
 * the award (one accept_bid RPC, gh-2914) happens here; the
 * downstream contract-signing surface is a SEPARATE static page we redirect to.
 * No payment is charged here — D-127 charges post-signing via docusign-webhook.
 */

import { supabase } from '@/lib/supabase';
import { extractOwnerPhotoPath, mapAwardError, STATIC_ORIGIN } from './utils';
import { track } from '@/lib/track';
import { isTestEmail } from '@/lib/test-signal';
import type { BidRow, BidsClaim, ContractorProfile } from './types';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const OWNER_PHOTO_TTL_SECONDS = 3600; // bids.html:1091

/** Resolve a contractor owner-photo signed URL (bids.html:1084-1096). */
export async function resolveOwnerPhotoUrl(filePath: string | null | undefined): Promise<string | null> {
  const storagePath = extractOwnerPhotoPath(filePath);
  if (!storagePath) return null;
  try {
    const { data, error } = await supabase.storage
      .from('contractor-documents')
      .createSignedUrl(storagePath, OWNER_PHOTO_TTL_SECONDS);
    return !error && data?.signedUrl ? data.signedUrl : null;
  } catch {
    return null;
  }
}

export interface ContractorPaymentInfo {
  has_payment_method: boolean;
  user_id?: string | null;
}

/**
 * get-contractor-info (verify_jwt=true) — checks the winning contractor has a
 * payment method on file before award (bids.html:1910-1921). Returns null on
 * any error so the caller fails closed (treats as "no payment method").
 */
export async function checkContractorPaymentMethod(
  claimId: string,
  contractorId: string,
): Promise<ContractorPaymentInfo | null> {
  try {
    const { data, error } = await supabase.functions.invoke('get-contractor-info', {
      body: { claim_id: claimId, contractor_id: contractorId },
    });
    if (error || !data) return null;
    return data as ContractorPaymentInfo;
  } catch {
    return null;
  }
}

/** Notify a contractor they must add a payment method (bids.html:1940-1947). */
export async function notifyContractorPaymentNeeded(
  contractorUserId: string,
  claimId: string,
): Promise<ActionResult> {
  const { error } = await supabase.from('notifications').insert({
    user_id: contractorUserId,
    claim_id: claimId,
    notification_type: 'payment_method_needed',
    channel: 'dashboard',
    recipient: '',
    message_preview:
      "A homeowner wants to select you, but you don't have a payment method on file. Please add one in Settings.",
  });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export interface AwardResult extends ActionResult {
  /** Contract-signing handoff URL (the separate downstream surface). */
  href?: string;
}

/**
 * Award the claim to the winning contractor (bids.html:2019). One atomic
 * accept_bid() RPC (gh-2914): claim → 'awarded' with the winner + amount;
 * winning quote → 'selected'; other live quotes → 'declined'. On success returns the
 * contract-signing handoff URL — the page redirects there (it does NOT build the
 * Tier-3 contract/payment flow). No charge here (D-127, post-signing).
 */
export async function awardClaimToContractor(params: {
  claim: BidsClaim;
  bid: BidRow;
}): Promise<AwardResult> {
  const { claim, bid } = params;

  // gh-2914 (Refs #2819): the award is ONE atomic SECURITY DEFINER RPC, exactly
  // as bids.html does (bids.html ~2019). accept_bid() verifies the caller owns
  // the claim, refuses a not-awardable bid or claim, enforces the contractor
  // payment-method guard (gh-1532), flips the claim to 'awarded' with the winner
  // + amount, marks the winning quote 'selected' and declines the other live
  // bids -- all in one transaction. The direct claims/quotes writes this
  // function used to make are refused for a homeowner session after #2819, and
  // the RPC raises on any failure (never a silent zero-row success), so the
  // gh-2105 zero-row checks are no longer needed here.
  // gh-1532: the payment-method guard raises 'contractor_no_payment_method: ...'
  // (P0001). mapAwardError turns it (and the gh-2626 bid/claim not-awardable
  // sentinels) into homeowner-facing wording -- the internal identifier is
  // never shown to a customer.
  const { error: acceptErr } = await supabase.rpc('accept_bid', {
    p_claim_id: claim.id,
    p_quote_id: bid.id,
  });
  if (acceptErr) return { ok: false, error: mapAwardError(acceptErr.message) };

  // gh-1940: "bid accepted" funnel step — fired here, after the
  // accept_bid RPC has succeeded, not on the modal's confirm click. fix3 (CEO ruling,
  // PR #1979 comment 5698022815): no claim_id (a per-homeowner database
  // identifier must not reach GA4 remarketing); params now match #1988's
  // `bids.html` bid_accepted (bid_id/contractor_id/bid_amount/source/
  // test_account) — this page and that one are the same funnel step on two
  // surfaces, distinguished only by `source`. `test_account` is read fresh
  // here (this is a standalone action, not a component with hook access to
  // the current user) rather than threaded through `params`.
  const { data: userData } = await supabase.auth.getUser();
  track('bid_accepted', {
    bid_id: bid.id,
    contractor_id: bid.contractor_id,
    bid_amount: Number(bid.total_price) || 0,
    source: 'bids_react',
    test_account: isTestEmail(userData?.user?.email),
  });

  const qs = new URLSearchParams({
    claim_id: claim.id,
    contractor_id: bid.contractor_id,
    quote_id: bid.id,
  });
  return { ok: true, href: `${STATIC_ORIGIN}/contract-signing.html?${qs.toString()}` };
}

export interface RenewalResult {
  notifOk: boolean;
  emailOk: boolean;
}

/**
 * Request an updated bid on an expired bid (bids.html:1785-1864). Non-blocking,
 * two independent best-effort steps: (1) a dashboard notification to the
 * contractor; (2) a support email to ops via send-support-email. Either success
 * flips the button to "✓ Request Sent".
 */
export async function requestBidRenewal(params: {
  claim: BidsClaim | null;
  contractor: ContractorProfile;
  bidId: string;
}): Promise<RenewalResult> {
  const { claim, contractor, bidId } = params;
  const companyName = contractor.company_name || 'Contractor';
  const propertyAddress = claim?.property_address || (claim ? 'their project' : 'their project');
  let notifOk = false;
  let emailOk = false;

  // gh-3042: contractors come from get_contractors_public(), which deliberately omits
  // user_id (private column), so for a homeowner this dashboard notification is skipped --
  // same as static bids.html. The ops support email below is the live path; its wording
  // only claims a dashboard notification when one was actually sent.
  if (contractor.user_id) {
    try {
      const { error } = await supabase.from('notifications').insert({
        user_id: contractor.user_id,
        claim_id: claim ? claim.id : null,
        notification_type: 'bid_renewal_requested',
        channel: 'dashboard',
        recipient: '',
        message_preview: `A homeowner is requesting an updated bid on ${propertyAddress}.`,
      });
      if (!error) notifOk = true;
    } catch {
      /* non-fatal — surfaced via button text only */
    }
  }

  try {
    // gh-2477: send-support-email refuses a newline in subject; companyName/address are user data.
    const subject = `[Bid Renewal Requested] ${companyName} — ${claim ? claim.property_address || claim.id : 'Unknown Claim'}`.replace(
      /[\r\n]+/g,
      ' ',
    );
    const message = [
      'A homeowner has requested an updated bid from a contractor whose bid has expired.',
      '',
      'Contractor: ' + companyName,
      'Property: ' + (claim ? claim.property_address || 'N/A' : 'N/A'),
      'Job #' + (claim ? claim.id.slice(-8).toUpperCase() : 'N/A'),
      'Quote ID: ' + bidId,
      '',
      notifOk
        ? 'The contractor has been notified via their dashboard.'
        : 'No dashboard notification was sent to the contractor (contractor user id is not available to homeowners) — please follow up with them directly.',
    ].join('\n');

    const { error } = await supabase.functions.invoke('send-support-email', {
      // gh-2477: the function requires from_name/from_email/subject/message (it was sent only
      // subject + message, so every call was a 400). System sender; recipient is fixed server-side.
      body: { from_name: 'OtterQuote Platform', from_email: 'support@otterquote.com', subject, message },
    });
    if (!error) emailOk = true;
  } catch {
    /* non-fatal */
  }

  return { notifOk, emailOk };
}

/** Mark the unread bid_updated notifications read on banner dismiss (bids.html:641-656). */
export async function acknowledgeBidUpdatedNotifications(ids: string[]): Promise<ActionResult> {
  if (ids.length === 0) return { ok: true };
  const { error } = await supabase
    .from('notifications')
    // update-no-select-ok: gh-2105 decision b -- read receipt for the bid-updated banner; a zero-row match (notification already read, deleted, or not visible to this user) only leaves the unread badge stale until the next load; no money, consent or legal state hangs on read_at.
    .update({ read_at: new Date().toISOString() })
    .in('id', ids);
  return error ? { ok: false, error: error.message } : { ok: true };
}

// gh-1873: loadHoverSidingData() (the get-hover-siding-data caller) was removed with the measurement vendor.
