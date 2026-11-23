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
 * Tier-3 boundary: the Services.* call hits the ALREADY-DEPLOYED send-adjuster-email Edge Function
 * with its contract UNCHANGED (the paid vendor path was removed in gh-1873). No EF, SQL, price, or idempotency change is made here.
 */

import { useEffect, useState } from 'react';
import * as Sentry from '@sentry/nextjs';
import { supabase } from '@/lib/supabase';
import {
  sendAdjusterEmail,
  createHoverPaymentIntent,
} from '@/lib/services';
import {
  buildAdjusterEmailParams,
  buildHoverPaymentIntentParams,
  buildAdjusterClaimWriteback,
  type HomeownerProfile,
  type MeasurementsClaim,
  type MeasurementsUser,
} from './utils';
import { CLAIM_PUBLIC_COLUMNS } from '@/lib/claim-columns';
import { measurementChargeEnabled } from '@/lib/measurement-charge-flag';

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
  /** gh-3858: the claim already has a paid measurement order. Read ONLY when the charge flag is on; always false otherwise. */
  existingOrder: boolean;
  loading: boolean;
  error: string | null;
}

const EMPTY: HelpMeasurementsData = {
  claim: null,
  profile: null,
  alreadySentBoth: false,
  existingOrder: false,
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
          .select(CLAIM_PUBLIC_COLUMNS)
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

        // gh-3858: with the charge flag ON, a claim that already has a paid order shows the confirmation, not a second start button.
        // The flag-OFF path runs no extra query. Homeowner RLS (hover_user_read) scopes this to the buyer's own rows. Non-fatal.
        let existingOrder = false;
        if (measurementChargeEnabled() && claim?.id) {
          try {
            const { data: order } = await supabase
              .from('hover_orders')
              .select('id')
              .eq('claim_id', claim.id)
              .not('homeowner_stripe_payment_intent_id', 'is', null)
              .neq('status', 'cancelled')
              .limit(1)
              .maybeSingle();
            existingOrder = !!order;
          } catch {
            /* non-fatal: the server still refuses a second payment (gh-3356) */
          }
        }

        if (!active) return;
        setData({
          claim: (claim as HelpMeasurementsClaimRow) ?? null,
          profile: (profile as HelpMeasurementsProfileRow) ?? null,
          alreadySentBoth,
          existingOrder,
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

// ── Path A: measurement charge (gh-3858, behind NEXT_PUBLIC_MEASUREMENT_CHARGE_ENABLED) ──────────────────────────────
// The vendor path (requestHoverPaymentIntent / placeHoverOrder -> create-hover-order) was removed with the measurement vendor
// (gh-1873) and is NOT restored. These two helpers are the replacement and are called only when the flag is ON:
//   1. requestMeasurementPaymentIntent: create-payment-intent for 2263 cents (the Edge Function enforces the real amount server-side).
//   2. recordMeasurementOrder: create-measurement-order with the SUCCEEDED PaymentIntent id; it re-reads the PaymentIntent from Stripe,
//      writes the hover_orders row in status 'awaiting_fulfillment' and contacts no vendor (a person fulfils it from the admin queue).

/** The SKU the homeowner buys: the condensed roof report (help-measurements.html MEASUREMENT_PRODUCT_CODE). Price lives server-side. */
export const MEASUREMENT_PRODUCT_CODE = 'roof_basic' as const;

/** Create the PaymentIntent for the measurement charge. Resolves with `client_secret: null` when it could not be created. */
export async function requestMeasurementPaymentIntent(
  claim: MeasurementsClaim,
  variant: string = 'unknown',
) {
  return createHoverPaymentIntent(buildHoverPaymentIntentParams(claim, variant));
}

export type MeasurementOrderError = Error & { paymentCaptured?: boolean; httpStatus?: number };

/**
 * Is this create-measurement-order failure a DEFINITE "this PaymentIntent was not charged / is not valid for this claim"?
 * Only then may a saved PaymentIntent id be cleared. Everything else (a captured payment whose row did not write, a 5xx, a network
 * error, a missing status) is NOT definite: the id is kept and the homeowner can retry the order write.
 * Definite = HTTP 402 and not payment_captured and not the "could not verify" outage message. Those 402s come from
 * supabase/functions/create-measurement-order/payment-intent-checks.ts:70-75 and :102-105 (PaymentIntent status is not 'succeeded'),
 * :82 (amount mismatch), :86 and :112 (not this claim), :90 and :116 (not a measurement charge), :60 (non-USD). The same 402 status
 * is also used at index.ts:245-250 when Stripe could not be reached to verify ("We could not verify your payment..."), which is
 * transient, so that message is excluded. payment_captured:true is sent by index.ts:545 (upgrade) and :587-590 / :829-832 (order insert failed).
 */
export function isDefiniteNotCharged(err: unknown): boolean {
  const e = err as MeasurementOrderError | null;
  if (!e || e.paymentCaptured === true || e.httpStatus !== 402) return false;
  return !/^We could not verify your payment/.test(e.message || '');
}

/**
 * Record the order for a charge Stripe confirmed. Throws on failure: HoverPaymentForm then parks in its post-charge
 * "retry order" state and re-runs ONLY this step with the same id (it never charges the card again). The thrown error carries
 * `paymentCaptured` when the server says the money moved but the row did not write.
 */
export async function recordMeasurementOrder(args: {
  claim: MeasurementsClaim;
  paymentIntentId: string;
}): Promise<{ order_id?: string; status?: string }> {
  const { data, error } = await supabase.functions.invoke('create-measurement-order', {
    body: {
      claim_id: args.claim.id,
      product_code: MEASUREMENT_PRODUCT_CODE,
      payment_intent_id: args.paymentIntentId, // D-181: verified server-side against the catalog price
      buyer_role: 'homeowner',
    },
  });
  if (error) {
    let payload: { error?: string; payment_captured?: boolean } = {};
    try {
      const ctx = (error as { context?: { json?: () => Promise<unknown> } }).context;
      if (ctx && typeof ctx.json === 'function') payload = ((await ctx.json()) as typeof payload) ?? {};
    } catch {
      /* not a JSON body: fall through to the generic message */
    }
    const err = new Error(payload.error || 'Could not record your measurement order.') as MeasurementOrderError;
    err.paymentCaptured = payload.payment_captured === true;
    err.httpStatus = (error as { context?: { status?: number } }).context?.status;
    throw err;
  }
  return (data ?? {}) as { order_id?: string; status?: string };
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
    // gh-2105 batch 4 (a, report-only): the email already went out; a failed or zero-row writeback goes to Sentry + console, flow unchanged.
    const { data: wbRows, error: wbErr } = await supabase.from('claims').update(updates).eq('id', claim.id).select('id');
    if (wbErr || !Array.isArray(wbRows) || wbRows.length === 0) {
      const wbMsg = wbErr ? wbErr.message : 'update_zero_rows: claims (adjuster info)';
      console.error('[help-measurements] adjuster writeback failed:', wbMsg);
      Sentry.captureMessage(`[help-measurements] adjuster writeback failed: ${wbMsg}`, {
        level: 'error',
        tags: { gh: '2105', site: 'help-measurements' },
        extra: { claim_id: claim.id },
      });
    }
  }
}
