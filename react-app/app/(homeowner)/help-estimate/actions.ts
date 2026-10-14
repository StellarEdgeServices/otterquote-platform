'use client';

/**
 * Homeowner help-estimate actions (D-211 H7). Mirrors help-estimate.html
 * sendEmail() (lines 1004-1068). SECURITY: Services.sendAdjusterEmail invokes the
 * hardened send-adjuster-email EF under the caller's session JWT and builds the
 * bound recipient/subject/body server-side — the client never trusts a raw
 * recipient. EFs are deployed and called AS-IS (changing one is Tier-3).
 */

import * as Sentry from '@sentry/nextjs';
import { supabase } from '@/lib/supabase';
import { Services, type SendAdjusterEmailResult } from '@/lib/services';

export interface SendEstimateRequestInput {
  claimId: string;
  carrierId: string | null;
  claimNumber: string;
  adjusterName: string;
  adjusterEmail: string;
  adjusterPhone: string;
  homeownerName: string;
  homeownerPhone: string;
  alsoMeasurements: boolean;
}

/**
 * Orchestrate the adjuster request:
 *   1. persist adjuster_name/email/phone onto the claim
 *   2. Services.findOrCreateAdjuster (D-046 KB autofill)
 *   3. Services.sendAdjusterEmail (server-side EF send)
 * Returns the Services result; the caller drives success/error UI.
 */
export async function sendEstimateRequest(
  input: SendEstimateRequestInput,
): Promise<SendAdjusterEmailResult> {
  // gh-2105 batch 4 (a, report-only): the adjuster email below is the user's intent, so a
  // failed or zero-row writeback is sent to Sentry (and the console) and does not block the
  // flow (twin of help-estimate.html).
  const { data: writeRows, error: writeErr } = await supabase
    .from('claims')
    .update({
      adjuster_name: input.adjusterName,
      adjuster_email: input.adjusterEmail,
      adjuster_phone: input.adjusterPhone || null,
    })
    .eq('id', input.claimId)
    .select('id');
  if (writeErr || !Array.isArray(writeRows) || writeRows.length === 0) {
    const writeMsg = writeErr ? writeErr.message : 'update_zero_rows: claims (adjuster info)';
    console.error('[help-estimate] adjuster writeback failed:', writeMsg);
    Sentry.captureMessage(`[help-estimate] adjuster writeback failed: ${writeMsg}`, {
      level: 'error',
      tags: { gh: '2105', site: 'help-estimate' },
      extra: { claim_id: input.claimId },
    });
  }

  await Services.findOrCreateAdjuster({
    adjuster_name: input.adjusterName,
    adjuster_email: input.adjusterEmail,
    adjuster_phone: input.adjusterPhone || null,
    carrier_id: input.carrierId,
  });

  return Services.sendAdjusterEmail({
    claim_id: input.claimId,
    adjuster_name: input.adjusterName,
    adjuster_email: input.adjusterEmail,
    homeowner_name: input.homeownerName,
    homeowner_phone: input.homeownerPhone,
    claim_number: input.claimNumber || undefined,
    request_type: input.alsoMeasurements ? 'both' : 'estimate',
  });
}
