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
 * the authorized homeowner writes (claims/quotes status) happen here; the
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
 * Award the claim to the winning contractor (bids.html:1964-1997). Authorized
 * homeowner writes: claim → 'awarded' with the winner + amount; winning quote →
 * 'selected'; all other quotes → 'declined'. On success returns the
 * contract-signing handoff URL — the page redirects there (it does NOT build the
 * Tier-3 contract/payment flow). No charge here (D-127, post-signing).
 */
export async function awardClaimToContractor(params: {
  claim: BidsClaim;
  bid: BidRow;
}): Promise<AwardResult> {
  const { claim, bid } = params;

  const { data: claimRows, error: claimErr } = await supabase
    .from('claims')
    .update({
      selected_contractor_id: bid.contractor_id,
      selected_bid_amount: bid.total_price,
      status: 'awarded',
    })
    .eq('id', claim.id)
    .select('id');
  // gh-1532: the accept-award payment-method guard raises
  // 'contractor_no_payment_method: ...'. Map it to homeowner-facing wording --
  // the internal identifier is never shown to a customer.
  if (claimErr) return { ok: false, error: mapAwardError(claimErr.message) };
  // gh-2105 (#2103 pattern, decision a): `.update()` without `.select()`
  // resolves `{ error: null }` even when RLS or the `.eq()` filter matches
  // ZERO rows -- PostgREST/Supabase do not treat a zero-row match as an
  // error. Without this check a homeowner could see "awarded" while
  // claims.status never actually changed -- the highest-value write on this
  // page. "Awarded" now means a row was actually written, not merely that
  // the call did not complain.
  if (!Array.isArray(claimRows) || claimRows.length === 0) {
    return { ok: false, error: mapAwardError('claim_award_zero_rows: no matching claim row was updated') };
  }

  const { data: winRows, error: winErr } = await supabase
    .from('quotes')
    .update({ status: 'selected' })
    .eq('id', bid.id)
    .select('id');
  if (winErr) return { ok: false, error: winErr.message };
  // gh-2105 (decision a): same zero-row-silent-success gap as the claim
  // write above -- the winning bid must actually flip to 'selected'.
  if (!Array.isArray(winRows) || winRows.length === 0) {
    // gh-2105 REVIEW FAIL nit: route through mapAwardError for the same
    // reason :122/:131 do, even though today's only mapped sentinel
    // (NO_PAYMENT_METHOD) can't appear here -- mapAwardError is a no-op
    // passthrough for any other string, so this costs nothing and keeps
    // every error this function returns on one consistent path.
    return { ok: false, error: mapAwardError('winning_bid_zero_rows: no matching quote row was updated') };
  }

  const { data: rejectRows, error: rejectErr } = await supabase
    .from('quotes')
    .update({ status: 'declined' })
    .eq('claim_id', claim.id)
    .neq('id', bid.id)
    .select('id');
  if (rejectErr) return { ok: false, error: rejectErr.message };
  // gh-2105 (decision b, NOT an error): a claim can legitimately have only
  // one bid (the winner), so there may be nothing left to decline -- zero
  // rows here is an expected outcome, not a silent-failure signal. `.select()`
  // is still added so this site is provably audited/considered, not merely
  // untouched (rejectRows intentionally unused beyond that intent).
  void rejectRows;

  // gh-1940: "bid accepted" funnel step — fired here, after every write
  // above has succeeded, not on the modal's confirm click. fix3 (CEO ruling,
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
    const subject = `[Bid Renewal Requested] ${companyName} — ${claim ? claim.property_address || claim.id : 'Unknown Claim'}`;
    const message = [
      'A homeowner has requested an updated bid from a contractor whose bid has expired.',
      '',
      'Contractor: ' + companyName,
      'Property: ' + (claim ? claim.property_address || 'N/A' : 'N/A'),
      'Job #' + (claim ? claim.id.slice(-8).toUpperCase() : 'N/A'),
      'Quote ID: ' + bidId,
      '',
      'The contractor has been notified via their dashboard' +
        (notifOk ? '.' : ' (notification may have failed — check manually).'),
    ].join('\n');

    const { error } = await supabase.functions.invoke('send-support-email', {
      body: { subject, message },
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
    .update({ read_at: new Date().toISOString() })
    .in('id', ids);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export interface HoverSidingData {
  hover_job_id?: string | null;
  job_address?: string | null;
  design_images?: string[];
  wall_squares?: number | null;
  wall_sqft?: number | null;
  siding_materials?: unknown[];
  message?: string | null;
  [key: string]: unknown;
}

/**
 * get-hover-siding-data (bids.html:970-979) — siding design/material data for a
 * siding job with measurements. EF is JWT + claim-ownership hardened (Phase 16
 * Unit 2); called AS-IS via invoke. Returns null on error.
 */
export async function loadHoverSidingData(claimId: string): Promise<HoverSidingData | null> {
  try {
    const { data, error } = await supabase.functions.invoke('get-hover-siding-data', {
      body: { claim_id: claimId },
    });
    if (error || !data) return null;
    return data as HoverSidingData;
  } catch {
    return null;
  }
}
