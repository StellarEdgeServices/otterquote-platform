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
import { isTestEmail } from '@/lib/test-signal';
import { track } from '@/lib/track';
import {
  buildClaimInsert,
  buildClaimUpdate,
  buildStoragePath,
  fileExt,
  hasFullAddress,
} from './utils';
import type {
  ContractorPublicRow,
  RepairSubmission,
  RepairSubmitResult,
  ResolvedAddress,
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

/**
 * gh-2004: thrown when repair-intake would otherwise create a brand-new
 * claim with no address at all (no claim_id was handed to this page, and
 * the homeowner's saved profile doesn't have a complete address either).
 * The page redirects to trade-selector — the surface with the actual
 * address-resolution gate (#2007/#2008) — instead of this page silently
 * inserting a claim with every property_* column NULL.
 */
export class MissingAddressError extends Error {
  constructor(message = 'No address on file') {
    super(message);
    this.name = 'MissingAddressError';
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
 *   2. Read profiles.full_name + gh-2004's address_street/city/state/zip
 *      (defensive maybeSingle) — full_name stays intentionally unused (the
 *      static fetched-and-ignored it); the address fields feed the
 *      hasFullAddress() gate below.
 *   3. No claim id → INSERT a draft repair claim, but ONLY once
 *      hasFullAddress() holds on the profile (gh-2004: this is one of the
 *      "no address column at all" call sites the issue's refuter found —
 *      see utils.ts's buildClaimInsert()). No usable address →
 *      MissingAddressError, never a NULL-address insert. Has a claim id
 *      already → UPDATE the existing one (buildClaimUpdate doesn't touch
 *      address at all — the claim's address was already resolved wherever
 *      it was created, normally trade-selector).
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

  // 2. Profile read (full_name mirrors the static fetch, intentionally
  // unused; gh-2004 adds the address columns for the hasFullAddress() gate
  // just below, used only on the create-a-new-claim branch).
  const { data: profileRow } = await supabase
    .from('profiles')
    .select('full_name, address_street, address_city, address_state, address_zip')
    .eq('id', user.id)
    .maybeSingle();

  // 3. Create-or-update the claim.
  let claimId = sub.claimId;
  const submission: RepairSubmission = { ...sub, userId: user.id };
  if (!claimId) {
    // gh-2004: this create-a-new-claim branch only runs when the homeowner
    // reached repair-intake with no claim_id at all (URL param or
    // sessionStorage) — normally trade-selector already created the claim
    // with a resolved address before redirecting here. When it does run,
    // never insert a claim with no address column named at all (the
    // refuted defect, comment 5721477654, "4c"). Block with an honest
    // error instead — the caller (page.tsx) redirects to trade-selector,
    // which is the surface that can actually ask the homeowner for it.
    // REVIEW fix (PR #2109, finding 4): .trim() before the || null
    // fallback — matches trade-selector's own gate so a whitespace-only
    // profile field (" ", truthy but not a real value) is rejected here
    // too, not just there.
    const profileAddress: ResolvedAddress = {
      street: (profileRow?.address_street || '').trim() || null,
      city: (profileRow?.address_city || '').trim() || null,
      state: (profileRow?.address_state || '').trim() || null,
      zip: (profileRow?.address_zip || '').trim() || null,
    };
    if (!hasFullAddress(profileAddress)) {
      throw new MissingAddressError();
    }

    // gh-397/#689: stamp is_test on this insert path — PR #714 only fixed
    // the COI-identity contractor insert, never any claims insert.
    // Predicate mirrors the CEO-approved contractor check (#543 /
    // test-exclusion.ts) and the static repair-intake.html parity fix.
    const { data, error } = await supabase
      .from('claims')
      .insert({ ...buildClaimInsert(submission, profileAddress), is_test: isTestEmail(user.email) })
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
    } else {
      // gh-1940: "documents uploaded" funnel step — fired per file, only on
      // a confirmed storage write. `tier` is a photo-category label
      // (PhotoTier), not file content or a filename — no PII.
      track('document_uploaded', { tier });
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
