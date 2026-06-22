'use client';

/**
 * Homeowner help-estimate actions (D-211 H7). Mirrors help-estimate.html
 * sendEmail() (lines 1004-1068). SECURITY: Services.sendAdjusterEmail invokes the
 * hardened send-adjuster-email EF under the caller's session JWT and builds the
 * bound recipient/subject/body server-side — the client never trusts a raw
 * recipient. EFs are deployed and called AS-IS (changing one is Tier-3).
 */

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
  await supabase
    .from('claims')
    .update({
      adjuster_name: input.adjusterName,
      adjuster_email: input.adjusterEmail,
      adjuster_phone: input.adjusterPhone || null,
    })
    .eq('id', input.claimId);

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
