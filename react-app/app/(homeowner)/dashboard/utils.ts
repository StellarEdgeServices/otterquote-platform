/**
 * Pure, framework-free logic for the homeowner dashboard (D-211).
 *
 * Every card-state / stage-gating decision the static dashboard.html made inline
 * is extracted here as a pure function so it can be unit-tested for parity
 * against the static page without rendering React. The page component is a thin
 * shell over these.
 */

import type { HomeownerClaim, HoverRebateOrder } from './types';

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
      text: 'Review the bids from qualified contractors and select the best offer for your project.',
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
