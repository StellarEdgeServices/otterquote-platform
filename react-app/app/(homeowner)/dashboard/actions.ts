'use client';

/**
 * Homeowner dashboard actions (D-211) — thin wrappers over the singleton for the
 * writes + Edge Function calls the dashboard performs.
 *
 * Every Edge Function is invoked via supabase.functions.invoke, which attaches the
 * caller's session JWT automatically. This replicates the post-Phase-19
 * authenticated contracts and intentionally does NOT reintroduce any
 * anon-key-bearer call pattern:
 *   • #336 parse-loss-sheet  — storage_path is scoped under the caller's own
 *                              user_id/claim_id.
 *   • #337 resend-hover-link — user session JWT (invoke), not the anon-key bearer.
 *   • send-support-email / notify-contractors / send-message-notification — all
 *     invoked under the user's authenticated session.
 *
 * These EFs were hardened in Phase 19 and are CALLED here unchanged.
 */

import { supabase } from '@/lib/supabase';
import { buildSwitchSurveyMessage, normalizeWarrantyBucketPath, WARRANTY_SIGNED_URL_TTL_SECONDS } from './utils';
import type { HomeownerClaim, HomeownerProfile } from './types';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** D-211 P19 #337 — resend the Hover capture link (rate-limited 3/day server-side). */
export async function resendHoverLink(claimId: string): Promise<ActionResult> {
  const { error } = await supabase.functions.invoke('resend-hover-link', {
    body: { claim_id: claimId },
  });
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Submit the claim for bids: flip to active, then notify contractors (non-fatal). */
export async function submitForBids(claimId: string): Promise<ActionResult> {
  const { error: updErr } = await supabase
    .from('claims')
    .update({ status: 'active', ready_for_bids: true })
    .eq('id', claimId);
  if (updErr) return { ok: false, error: updErr.message };

  // notify-contractors is non-fatal — a notification failure must not block submit.
  try {
    await supabase.functions.invoke('notify-contractors', { body: { claim_id: claimId } });
  } catch (err) {
    console.warn('[dashboard] notify-contractors failed (non-fatal):', err);
  }
  return { ok: true };
}

/**
 * Upload an estimate/measurements document and kick off parsing (#336).
 * storage_path is scoped under the caller's own user_id/claim_id.
 */
export async function uploadClaimDocument(params: {
  userId: string;
  claimId: string;
  file: File;
  timestamp: number;
}): Promise<{ ok: boolean; storagePath?: string; error?: string }> {
  const { userId, claimId, file, timestamp } = params;
  const storagePath = `${userId}/${claimId}/${timestamp}-${file.name}`;

  const { error: upErr } = await supabase.storage
    .from('claim-documents')
    .upload(storagePath, file);
  if (upErr) return { ok: false, error: upErr.message };

  // Parsing is non-blocking — a parse failure must not fail the upload (#336).
  try {
    await supabase.functions.invoke('parse-loss-sheet', {
      body: { claim_id: claimId, storage_path: storagePath },
    });
  } catch (err) {
    console.warn('[dashboard] parse-loss-sheet failed (non-fatal):', err);
  }
  return { ok: true, storagePath };
}

/** D-171 — submit the switch-contractor survey via the send-support-email EF. */
export async function submitSwitchSurvey(params: {
  claim: HomeownerClaim;
  profile: HomeownerProfile | null;
  email: string | null | undefined;
  reasons: string[];
  notes: string;
}): Promise<ActionResult> {
  const { claim, profile, email, reasons, notes } = params;
  const { error } = await supabase.functions.invoke('send-support-email', {
    body: {
      from_name: profile?.full_name || 'Homeowner',
      from_email: email || '',
      subject: 'Switch Contractor Request',
      message: buildSwitchSurveyMessage(claim, reasons, notes),
    },
  });
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** W3-P4 — open the warranty document via a 7-day signed URL. */
export async function openWarrantyDoc(warrantyUrl: string): Promise<ActionResult> {
  try {
    const bucketPath = normalizeWarrantyBucketPath(warrantyUrl);
    const { data, error } = await supabase.storage
      .from('contractor-documents')
      .createSignedUrl(bucketPath, WARRANTY_SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) {
      return { ok: false, error: error?.message || 'Could not generate link' };
    }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** D-231 — persist the home profile (upsert keyed on homeowner_user_id). */
export async function saveHomeProfile(payload: {
  homeowner_user_id: string;
  year_built: number;
  square_footage: number;
  stories: string;
  future_projects: string[];
  roof_last_replaced?: number | null;
  siding_material?: string | null;
  hvac_age_years?: number | null;
}): Promise<ActionResult> {
  const { error } = await supabase
    .from('home_profiles')
    .upsert(payload, { onConflict: 'homeowner_user_id' });
  return error ? { ok: false, error: error.message } : { ok: true };
}

/** Send a homeowner message on a claim thread, then fire the notification EF. */
export async function sendClaimMessage(params: {
  claimId: string;
  senderId: string;
  body: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { claimId, senderId, body } = params;
  const { data, error } = await supabase
    .from('messages')
    .insert({ claim_id: claimId, sender_id: senderId, sender_role: 'homeowner', body })
    .select('id')
    .single();
  if (error) return { ok: false, error: error.message };

  // Notification is non-fatal — the message is already persisted.
  try {
    await supabase.functions.invoke('send-message-notification', {
      body: { message_id: data.id },
    });
  } catch (err) {
    console.warn('[dashboard] send-message-notification failed (non-fatal):', err);
  }
  return { ok: true };
}

/** D-178 state gate — record an expansion-waitlist opt-in and waitlist the claim. */
export async function joinExpansionWaitlist(params: {
  userId: string;
  claimId: string;
  state: string;
  optedIn: boolean;
  optedInAt: string;
}): Promise<ActionResult> {
  const { userId, claimId, state, optedIn, optedInAt } = params;
  const { error } = await supabase.from('expansion_waitlist').upsert(
    {
      user_id: userId,
      claim_id: claimId,
      state,
      opted_in: optedIn,
      opted_in_at: optedIn ? optedInAt : null,
    },
    { onConflict: 'user_id,state' },
  );
  if (error) return { ok: false, error: error.message };

  await supabase.from('claims').update({ status: 'waitlisted' }).eq('id', claimId);
  return { ok: true };
}
