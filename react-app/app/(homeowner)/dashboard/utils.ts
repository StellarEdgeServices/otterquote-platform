/**
 * Pure, framework-free logic for the homeowner dashboard (D-211).
 *
 * Every card-state / stage-gating decision the static dashboard.html made inline
 * is extracted here as a pure function so it can be unit-tested for parity
 * against the static page without rendering React. The page component is a thin
 * shell over these.
 */

import type { HomeownerClaim, HoverRebateOrder } from './types';
import { claimHasFullMeasurements } from '@/lib/measurement-shape';

// ── D-178: State gate ───────────────────────────────────────────────────────

/**
 * D-178 — block non-IN homeowners. Mirrors dashboard.html:1507
 *   `currentClaim?.property_state && currentClaim.property_state !== 'IN'`
 * A null/absent property_state (e.g. an auto-created draft before intake) is NOT
 * gated — the static page deliberately does not pre-seed property_state on drafts.
 */
export function isStateGated(claim: HomeownerClaim | null | undefined): boolean {
  return !!claim?.property_state && claim.property_state !== 'IN';
}

// ── Progress checklist (estimate / measurements / material) ─────────────────

export interface ProgressState {
  completed: number;
  total: number;
  percent: number;
}

/** Mirrors updateProgressBar() — 3 steps, percent rounded. */
export function computeProgress(claim: HomeownerClaim | null | undefined): ProgressState {
  const total = 3;
  let completed = 0;
  if (claim?.has_estimate) completed++;
  if (claim?.has_measurements) completed++;
  if (claim?.has_material_selection) completed++;
  return { completed, total, percent: Math.round((completed / total) * 100) };
}

// ── D-178: Status banner ────────────────────────────────────────────────────

export type StatusBannerVariant = 'contract_signed' | 'has_bids' | 'live';

export interface StatusBanner {
  variant: StatusBannerVariant;
  icon: string;
  title: string;
  text: string;
}

/**
 * Derive the status banner shown above the dashboard. Mirrors updateStatusBanner():
 *   - The banner only shows when `ready_for_bids` is true (returns null otherwise;
 *     the pre-submission checklist UI shows instead).
 *   - `contract_signed` takes priority (celebration + switch/warranty actions).
 *   - Otherwise the copy is driven by the live bid count.
 */
export function deriveStatusBanner(
  claim: HomeownerClaim | null | undefined,
  bidCount: number,
): StatusBanner | null {
  if (!claim?.ready_for_bids) return null;

  if (claim.status === 'contract_signed') {
    return {
      variant: 'contract_signed',
      icon: '🎉',
      title: 'Contract signed!',
      text: 'Your contract is signed. Your contractor will be in touch to schedule your project.',
    };
  }

  if (bidCount > 0) {
    return {
      variant: 'has_bids',
      icon: '🏆',
      title: bidCount === 1 ? 'You have 1 bid!' : `You have ${bidCount} bids!`,
      text: 'Review the bids from contractors and select the best offer for your project.',
    };
  }

  return {
    variant: 'live',
    icon: '✓',
    title: 'Your project is live!',
    text: "Contractors are reviewing your details. You'll be notified of incoming bids.",
  };
}

// ── D-171: Switch contractor ─────────────────────────────────────────────────

export interface SwitchReason {
  value: string;
  label: string;
}

/** The survey reason options (dashboard.html:1346-1362). */
export const SWITCH_REASONS: SwitchReason[] = [
  { value: 'unresponsive', label: "Contractor is unresponsive" },
  { value: 'changed_scope', label: 'They changed the scope or price' },
  { value: 'pricing_disagreement', label: 'Disagreement about pricing' },
  { value: 'personality_fit', label: "Personality / communication fit" },
  { value: 'other', label: 'Something else' },
];

/**
 * 3-day switch cutoff. Mirrors dashboard.html:2333-2338 — switching is disabled
 * when the installation (estimated_start_date) is within the next 3 days.
 */
export function isSwitchWithinCutoff(
  claim: HomeownerClaim | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!claim?.estimated_start_date) return false;
  const installDate = new Date(claim.estimated_start_date);
  if (Number.isNaN(installDate.getTime())) return false;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() + 3);
  return installDate <= cutoff;
}

/** Switch survey is offered only on a contract_signed claim. */
export function canSwitchContractor(claim: HomeownerClaim | null | undefined): boolean {
  return claim?.status === 'contract_signed';
}

/** Body of the support email sent for a switch request (dashboard.html:3101). */
export function buildSwitchSurveyMessage(
  claim: HomeownerClaim,
  reasons: string[],
  notes: string,
): string {
  const jobRef = claim.id.slice(-8).toUpperCase();
  const reasonText = reasons.join(', ');
  return `Job #${jobRef}\nReasons: ${reasonText}\nNotes: ${notes || '(none)'}`;
}

// ── W3-P4: Warranty document button ──────────────────────────────────────────

/**
 * Warranty button shows on a completed, contract_signed claim that has a warranty
 * document on its selected quote (dashboard.html:2368).
 */
export function shouldShowWarrantyButton(
  claim: HomeownerClaim | null | undefined,
  warrantyUrl: string | null | undefined,
): boolean {
  return claim?.status === 'contract_signed' && !!claim?.completion_date && !!warrantyUrl;
}

/** Strip the bucket prefix before createSignedUrl (dashboard.html:3139). */
export function normalizeWarrantyBucketPath(url: string): string {
  return url.replace(/^contractor-documents\//, '');
}

export const WARRANTY_SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// ── D-231: Home profile prompt ───────────────────────────────────────────────

/** localStorage dismiss key, per claim (dashboard.html:3732). */
export function homeProfileDismissKey(claimId: string): string {
  return `oq_hp_dismissed_${claimId}`;
}

/**
 * D-231 — post-completion home-profile prompt. Shown when the job is complete on a
 * contract_signed claim, the homeowner has a profile, no home_profiles row exists
 * yet, and the card has not been dismissed (dashboard.html:2382 + initHomeProfilePrompt).
 */
export function shouldShowHomeProfilePrompt(params: {
  claim: HomeownerClaim | null | undefined;
  profileId: string | null | undefined;
  hasHomeProfile: boolean;
  dismissed: boolean;
}): boolean {
  const { claim, profileId, hasHomeProfile, dismissed } = params;
  return (
    claim?.status === 'contract_signed' &&
    !!claim?.completion_date &&
    !!profileId &&
    !hasHomeProfile &&
    !dismissed
  );
}

// ── D-181: Hover rebate card (display-only) ──────────────────────────────────

export type RebateVariant = 'rebated' | 'pending' | 'on_file';

export interface RebateCardModel {
  variant: RebateVariant;
  header: string;
  body: string;
  amountLabel: string;
}

/** Card only renders once a Hover fee payment is on file (dashboard.html:2171). */
export function shouldShowRebateCard(
  order: HoverRebateOrder | null | undefined,
): order is HoverRebateOrder {
  return !!order && !!order.homeowner_stripe_payment_intent_id;
}

/**
 * Render model for the display-only rebate card (dashboard.html:2171-2222). No
 * charge / payment logic — the real money movement happens downstream in
 * docusign-webhook/stripe-webhook (D-127).
 */
export function buildRebateCard(order: HoverRebateOrder): RebateCardModel {
  const amt = Number(order.homeowner_charge_amount || 0) / 100;
  const amountLabel = `$${amt.toFixed(0)}`;

  if (order.rebate_paid_at) {
    const dateStr = new Date(order.rebate_paid_at).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    return {
      variant: 'rebated',
      amountLabel,
      header: 'Measurement fee rebated',
      body: `Your ${amountLabel} measurement fee was rebated to your original payment method on ${dateStr}. Refunds typically show on your statement within 5–10 business days.`,
    };
  }

  if (order.rebate_due) {
    return {
      variant: 'pending',
      amountLabel,
      header: `Measurement fee paid — ${amountLabel} rebate pending`,
      body: `You've paid ${amountLabel} for your measurement report. When your project closes with an Otter Quotes contractor, the full ${amountLabel} is rebated to your original payment method automatically.`,
    };
  }

  return {
    variant: 'on_file',
    amountLabel,
    header: `Measurement fee paid — ${amountLabel}`,
    body: `Your ${amountLabel} measurement payment is on file.`,
  };
}

// -- gh-1411 / D-317 cl. 5-6: Shape-B 'detailed' badge -----------------------

export interface DetailedMeasurementBadgeModel {
  header: string;
  body: string;
}

/**
 * Card only renders once admin-measurements.html has flipped this claim to
 * the detailed shape (gh-1411's ONLY writer of claims.measurement_shape --
 * see react-app/app/lib/measurement-shape.ts and js/measurement-shape.js).
 * NULL / absent / any value other than the literal string 'full' all render
 * nothing here, matching the resolver's tolerant-default contract exactly.
 */
export function shouldShowDetailedMeasurementBadge(
  claim: HomeownerClaim | null | undefined,
): boolean {
  return claimHasFullMeasurements(claim);
}

/**
 * Render model for the display-only Shape-B badge (gh-1411 closes-on: "the
 * homeowner's screen renders Shape B with the 'detailed' mark"). No charge
 * logic -- the purchase already happened on the contractor's side; this is
 * purely the free upgrade D-317 cl. 5 promises the homeowner ("the
 * homeowner's copy is upgraded... at no charge").
 *
 * PLACEHOLDER COPY -- NOT APPROVED FOR PRODUCTION (gh-1411 PR #2236 review).
 * No existing byte-identical homeowner-facing string names this concept --
 * grepped contractor-opportunities.html (#1621), dashboard.html, and this
 * page's own copy; every hit is contractor-facing ("nothing to buy",
 * "every other contractor... will see it too") and none reads naturally as
 * first-person homeowner copy. Per the brief ("no new prices, promises or
 * copy"), the text below is a PLACEHOLDER only -- do not treat it as final,
 * and do not wire this into page.tsx until Sloane (CRO) drafts real copy and
 * it clears LEGAL-READ. This component is deliberately NOT rendered by
 * page.tsx yet for exactly that reason -- see the comment there.
 */
export const DETAILED_MEASUREMENT_BADGE_COPY_IS_PLACEHOLDER = true;

export function buildDetailedMeasurementBadge(): DetailedMeasurementBadgeModel {
  // LEGAL-READ FIX (PR #2236 comment 5850580181): the prior body carried two
  // clauses beyond the decided D-numbers -- "a contractor purchased..." (no
  // D-number covers disclosing that a contractor paid) and "every contractor
  // bidding on your project now has access..." (a new promise to the
  // homeowner about every future bidder, and one that conflicts with D-317
  // cl. 4 / provision 5's "every later upgrade on the same roof is margin"
  // -- an unresolved Tier C question, not this PR's to answer). Reduced to
  // ONLY the two clauses LEGAL-READ marked "covered": the receipt-text
  // concept (D-317 prov. 5, "Detailed roof measurement report") and the free
  // upgrade (D-317 cl. 5, "no charge"). Still a PLACEHOLDER -- Sloane owns
  // the final wording -- but nothing beyond what D-317 already decided.
  return {
    header: "[PLACEHOLDER COPY -- pending Sloane draft + LEGAL-READ, gh-1411] Detailed measurement report",
    body:
      "[PLACEHOLDER COPY -- pending Sloane draft + LEGAL-READ, gh-1411] " +
      "Your copy was upgraded to detailed measurements at no charge.",
  };
}
