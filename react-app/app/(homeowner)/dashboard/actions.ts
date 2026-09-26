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
  // #482: static-stack parity (PR #473) — stamp {trade}_bid_released_at for
  // releasable trades at submit. Siding releases via the D-164 design gate.
  const update: Record<string, unknown> = { status: 'active', ready_for_bids: true };
  try {
    const { data: claimRow } = await supabase
      .from('claims')
      .select('trades, roofing_bid_released_at, gutters_bid_released_at, windows_bid_released_at')
      .eq('id', claimId)
      .maybeSingle();
    const row = (claimRow ?? {}) as Record<string, unknown>;
    const trades = Array.isArray(row.trades) ? (row.trades as string[]) : [];
    const now = new Date().toISOString();
    for (const trade of ['roofing', 'gutters', 'windows']) {
      if (trades.includes(trade) && !row[`${trade}_bid_released_at`]) {
        update[`${trade}_bid_released_at`] = now;
      }
    }
  } catch { /* non-fatal — submit still proceeds */ }
  const { error: updErr } = await supabase
    .from('claims')
    .update(update)
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
  kind: 'estimate' | 'measurements';
}): Promise<{ ok: boolean; storagePath?: string; error?: string }> {
  const { userId, claimId, file, timestamp, kind } = params;
  const storagePath = `${userId}/${claimId}/${timestamp}-${file.name}`;

  const { error: upErr } = await supabase.storage
    .from('claim-documents')
    .upload(storagePath, file);
  if (upErr) return { ok: false, error: upErr.message };

  // #482: static-stack parity — flip the checklist flag and store the FULL
  // storage path (contractor pages open the doc via createSignedUrl; a bare
  // display name 404s — PR #473).
  const flagField = kind === 'estimate' ? 'has_estimate' : 'has_measurements';
  const nameField = kind === 'estimate' ? 'estimate_filename' : 'measurements_filename';
  const { error: updErr } = await supabase
    .from('claims')
    .update({ [flagField]: true, [nameField]: storagePath })
    .eq('id', claimId);
  if (updErr) return { ok: false, error: updErr.message };

  // Parsing is fire-and-forget (gh-2070) — parse-loss-sheet makes a
  // synchronous, non-streaming Claude vision call (routinely 15-60s, bounded
  // only by the ~150s Edge Function wall clock), so `await`ing it here could
  // stall the upload indefinitely on a slow or hung call. A parse failure (or
  // a call that never settles) must never fail or delay the upload (#336).
  // Mirrors the trade-selector attach fix in PR #2080.
  if (kind === 'estimate') {
    void supabase.functions.invoke('parse-loss-sheet', {
      body: { claim_id: claimId, storage_path: storagePath },
    }).catch((err) => {
      console.warn('[dashboard] parse-loss-sheet failed (non-fatal):', err);
    });
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
