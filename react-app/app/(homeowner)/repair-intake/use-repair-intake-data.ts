'use client';

/**
 * Homeowner repair-intake data layer (H9) — D-211 Phase 24. ADR-009
 * useState/useEffect over the shared supabase singleton; RLS is the real gate.
 * Mirrors the reads and the create-or-update + photo-upload the static
 * repair-intake.html performed.
 *
 * NO Services / NO Edge Function — claims (insert + update) and contractors_public
 * (read) go directly through the singleton, exactly as the static page did. The
 * static had zero functions.invoke; neither does this.
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  buildClaimInsert,
  buildClaimUpdate,
  buildStoragePath,
  fileExt,
} from './utils';
import type {
  ContractorPublicRow,
  RepairSubmission,
  RepairSubmitResult,
  Trade,
} from './types';

/**
 * Thrown when the auth re-check at submit time finds no live session — the page
 * redirects to get-started.html (mirrors the static session-expiry guard).
 */
export class SessionExpiredError extends Error {
  constructor(message = 'Session expired') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export interface ContractorsResult {
  contractors: ContractorPublicRow[];
  loading: boolean;
  error: Error | null;
}

/**
 * Contractors who have opted into repairs for this trade, from the PUBLIC-SAFE
 * view (never the base contractors table). Lazy: only fires once `enabled`
 * (the homeowner has submitted). Mirrors the static showRepairContractors query.
 */
export function useRepairContractors(trade: Trade, enabled: boolean): ContractorsResult {
  const [contractors, setContractors] = useState<ContractorPublicRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const { data, error: fetchErr } = await supabase
          .rpc('get_contractors_public')
          .select('id, company_name, years_in_business, rating, service_counties')
          .eq('repairs_accepted', true)
          .contains('trades', [trade])
          .limit(10);
        if (!mounted) return;
        if (fetchErr) {
          setError(new Error(fetchErr.message));
        } else {
          setContractors((data as ContractorPublicRow[]) ?? []);
        }
        setLoading(false);
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [trade, enabled]);

  return { contractors, loading, error };
}

/**
 * Create (or update) the repair claim, upload every selected photo to the
 * claim-documents bucket, then mark the claim submitted. Faithful port of the
 * static submitForm() (repair-intake.html:1195-1306):
 *   1. Re-verify auth (session-expiry guard) → SessionExpiredError on failure.
 *   2. Read profiles.full_name (defensive maybeSingle) — fetched as the static
 *      did; the value is intentionally unused (the static fetched-and-ignored).
 *   3. No claim id → INSERT a draft repair claim; else UPDATE the existing one.
 *   4. Upload each photo (UID-first RLS-compliant path; {upsert:false}). An
 *      individual upload error is logged, not thrown (static parity) — one bad
 *      file must not abort the submission.
 *   5. Mark the claim 'submitted'.
 * Throws on claim insert/update failure so the caller re-enables Submit (test d).
 */
export async function submitRepairIntake(
  sub: RepairSubmission,
): Promise<RepairSubmitResult> {
  // 1. Auth re-check.
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) throw new SessionExpiredError();

  // 2. Profile read (mirrors the static fetch; result intentionally unused).
  await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle();

  // 3. Create-or-update the claim.
  let claimId = sub.claimId;
  const submission: RepairSubmission = { ...sub, userId: user.id };
  if (!claimId) {
    const { data, error } = await supabase
      .from('claims')
      .insert(buildClaimInsert(submission))
      .select('id')
      .single();
    if (error || !data) throw new Error(error?.message || 'Failed to create claim');
    claimId = (data as { id: string }).id;
  } else {
    const { error } = await supabase
      .from('claims')
      .update(buildClaimUpdate(submission))
      .eq('id', claimId)
      .eq('user_id', user.id);
    if (error) throw new Error(error.message);
  }

  // 4. Upload photos — RLS-compliant UID-first path, {upsert:false}.
  for (const { tier, file } of sub.photos) {
    const path = buildStoragePath(
      user.id,
      claimId,
      tier,
      fileExt(file),
      Date.now(),
      Math.random().toString(36).slice(2),
    );
    const { error: uploadErr } = await supabase.storage
      .from('claim-documents')
      .upload(path, file, { contentType: file.type, upsert: false });
    if (uploadErr) {
      // Faithful: a single failed photo must not abort the submission.
      console.warn('Photo upload failed:', uploadErr.message);
    }
  }

  // 5. Mark submitted (faithful: the static did not hard-fail on this update).
  await supabase
    .from('claims')
    .update({ status: 'submitted' })
    .eq('id', claimId)
    .eq('user_id', user.id);

  return { claimId };
}
