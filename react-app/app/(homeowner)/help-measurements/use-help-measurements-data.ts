'use client';

/**
 * Homeowner help-measurements data layer — D-211 Phase 28, PR 2/2.
 *
 * ADR-009 useState/useEffect over the shared supabase singleton; RLS is the real gate.
 * Mirrors the H7 help-estimate / H5 color-selection data idiom: keep all reads, the
 * Edge-Function-backed mutations, and the claim write-back OUT of the render path. The
 * page is the thin side-effectful shell that calls these helpers and feeds the results
 * to the PR-1 pure builders (./utils) + locked copy (./copy).
 *
 * Faithful port of the static init (help-measurements.html:762-840) and the two flows:
 *   • loadClaimData (805-815)              → useHelpMeasurementsData: claims by user_id,
 *                                            created_at desc, limit 1, maybeSingle.
 *   • Auth.getProfile()                    → profiles by id = auth uid (the React-stack
 *                                            convention; mirrors H5/H7).
 *   • checkExistingEstimateRequest (826-840) → adjuster_email_requests where claim_id +
 *                                            request_type='both' → alreadySentBoth flag.
 *
 * Tier-3 boundary: the three Services.* calls hit the ALREADY-DEPLOYED Edge Functions
 * (create-payment-intent, create-hover-order, send-adjuster-email) with their contracts
 * UNCHANGED. No EF, SQL, price, or idempotency change is made here.
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  createHoverPaymentIntent,
  createHoverOrder,
  sendAdjusterEmail,
  type PaymentIntentResult,
  type CreateHoverOrderResult,
} from '@/lib/services';
import {
  buildHoverPaymentIntentParams,
  buildHoverOrderParams,
  buildAdjusterEmailParams,
  buildAdjusterClaimWriteback,
  type HomeownerProfile,
  type MeasurementsClaim,
  type MeasurementsUser,
} from './utils';

// ── Row shapes (supersets of the utils input shapes the page reads) ────────────────

/** Claim row: the utils MeasurementsClaim fields + the prefill/write-back adjuster fields. */
export interface HelpMeasurementsClaimRow extends MeasurementsClaim {
  adjuster_name?: string | null;
  adjuster_email?: string | null;
  adjuster_phone?: string | null;
}

/** Profile row — structurally the utils HomeownerProfile. */
export type HelpMeasurementsProfileRow = HomeownerProfile;

// ── Hook return shape ──────────────────────────────────────────────────────────────

export interface HelpMeasurementsData {
  claim: HelpMeasurementsClaimRow | null;
  profile: HelpMeasurementsProfileRow | null;
  /** True when help-estimate already sent a combined ('both') request for this claim. */
  alreadySentBoth: boolean;
  loading: boolean;
  error: string | null;
}

const EMPTY: HelpMeasurementsData = {
  claim: null,
  profile: null,
  alreadySentBoth: false,
  loading: true,
  error: null,
};

/**
 * Load the homeowner's latest claim + profile and run the already-sent ('both') check.
 * Fires once `ready` && a userId is present. Mirrors the static init order; failures
 * surface as `error` (the static showed 'Failed to load page.' on a thrown init).
 */
export function useHelpMeasurementsData(
  userId: string | null,
  ready: boolean,
): HelpMeasurementsData {
  const [data, setData] = useState<HelpMeasurementsData>(EMPTY);

  useEffect(() => {
    if (!ready) return;
    if (!userId) return;

    let active = true;
    setData((d) => ({ ...d, loading: true, error: null }));

    (async () => {
      try {
        // Profile (profiles.id = auth uid) — mirrors H5/H7.
        const { data: profile } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .maybeSingle();

        // Latest claim (static loadClaimData 805-815).
        const { data: claim } = await supabase
          .from('claims')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        // Already-sent 'both' check (static checkExistingEstimateRequest 826-840).
        let alreadySentBoth = false;
        if (claim?.id) {
          const { data: existing } = await supabase
            .from('adjuster_email_requests')
            .select('*')
            .eq('claim_id', claim.id)
            .eq('request_type', 'both')
            .limit(1)
            .maybeSingle();
          alreadySentBoth = !!existing;
        }

        if (!active) return;
        setData({
          claim: (claim as HelpMeasurementsClaimRow) ?? null,
          profile: (profile as HelpMeasurementsProfileRow) ?? null,
          alreadySentBoth,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (!active) return;
        setData({
          ...EMPTY,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load page. Please refresh.',
        });
      }
    })();

    return () => {
      active = false;
    };
  }, [userId, ready]);

  return data;
}

// ── Path A: Hover (paid) ────────────────────────────────────────────────────────────

/**
 * Step 1 — create the Stripe PaymentIntent for the $15 Hover fee (D-291, repricing D-205's
 * now-superseded $150) (NO charge yet).
 * Calls create-payment-intent via Services with its contract UNCHANGED. Returns the
 * PaymentIntentResult ({ client_secret }); the page mounts the card form only when a
 * client_secret comes back (static purchaseHover 885-907).
 */
export function requestHoverPaymentIntent(
  claim: MeasurementsClaim,
): Promise<PaymentIntentResult> {
  return createHoverPaymentIntent(buildHoverPaymentIntentParams(claim));
}

/**
 * Step 2 — create the Hover order AFTER the card payment has succeeded. Calls
 * create-hover-order via Services UNCHANGED; payment_intent_id is the D-181 guard the
 * EF re-validates server-side (static confirmHoverPayment 969-990).
 */
export function placeHoverOrder(args: {
  profile: HomeownerProfile | null;
  claim: MeasurementsClaim;
  user: MeasurementsUser | null;
  paymentIntentId: string;
}): Promise<CreateHoverOrderResult> {
  return createHoverOrder(buildHoverOrderParams(args));
}

// ── Path B: Ask Adjuster (free) ──────────────────────────────────────────────────────

/**
 * Send the measurement request to the adjuster, then write the entered adjuster details
 * back into the claim ONLY for fields currently empty (static sendMeasurementEmail
 * 1058-1078). Mirrors the static order: email first, then the write-back. The Edge
 * Function (send-adjuster-email) contract is UNCHANGED; it degrades gracefully when the
 * EF is pending (Services returns edge_function_pending without throwing).
 */
export async function sendMeasurementRequest(args: {
  claim: HelpMeasurementsClaimRow;
  profile: HomeownerProfile | null;
  adjusterName: string;
  adjusterEmail: string;
  adjusterPhone: string;
}): Promise<void> {
  const { claim, profile, adjusterName, adjusterEmail, adjusterPhone } = args;

  await sendAdjusterEmail(
    buildAdjusterEmailParams({ claim, profile, adjusterName, adjusterEmail, adjusterPhone }),
  );

  const updates = buildAdjusterClaimWriteback({ claim, adjusterName, adjusterEmail, adjusterPhone });
  if (Object.keys(updates).length > 0) {
    await supabase.from('claims').update(updates).eq('id', claim.id);
  }
}
