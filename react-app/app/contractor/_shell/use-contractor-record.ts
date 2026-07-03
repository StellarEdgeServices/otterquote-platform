'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

// The Phase-6 pre-approval gate (#297) — the contractor onboarding landing that
// CREATES the contractors row on first arrival. An authenticated contractor with
// no row yet belongs here, not on a data page that reads their (missing) row.
export const CONTRACTOR_PRE_APPROVAL_ROUTE = '/contractor/pre-approval';

/**
 * The current contractor's `contractors` row. Typed loosely (index signature)
 * because contractor pages read many columns; the named fields are the ones the
 * shared shell logic (gating + CPA guard + nav) depends on.
 */
export interface ContractorRecord {
  id: string;
  user_id: string;
  company_name?: string | null;
  status?: string | null;
  cpa_version?: string | null;
  cpa_accepted_at?: string | null;
  needs_cpa_reattestation?: boolean | null;
  agreement_accepted_at?: string | null;
  agreement_version?: string | null;
  service_counties?: string[] | null;
  trades?: string[] | null;
  address_state?: string | null;
  attestation_accepted_at?: unknown;
  coi_file_url?: unknown;
  coi_insurer?: unknown;
  coi_policy_number?: unknown;
  coi_expires_at?: unknown;
  [key: string]: unknown;
}

export interface UseContractorRecordResult {
  contractor: ContractorRecord | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Fetch the current contractor's `contractors` row by user_id. Reused by every
 * contractor-track page (dashboard / opportunities / profile / ...). Follows the
 * ADR-009 data-hook pattern (useState/useEffect + the shared supabase singleton;
 * RLS is the real data gate). Pass `null`/`undefined` while auth is still
 * resolving — the hook stays idle until a userId is provided.
 */
export function useContractorRecord(
  userId: string | null | undefined,
): UseContractorRecordResult {
  const [contractor, setContractor] = useState<ContractorRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);

    (async () => {
      try {
        // .maybeSingle() (NOT .single()): a contractor-role user with zero
        // `contractors` rows is a legitimate state (brand-new / pre-approval not
        // yet completed, or a row removed). .single() turns 0 rows into a
        // PostgREST 406 error, which every consumer treats as "still loading"
        // (`!contractor`) → the dashboard spins forever (D-211 P18). .maybeSingle()
        // returns a clean `{ data: null, error: null }` for 0 rows so callers can
        // distinguish "no row yet" from "still loading" and route accordingly
        // (see useContractorRecordGate below).
        const { data, error: fetchError } = await supabase
          .from('contractors')
          .select('*')
          .eq('user_id', userId)
          .maybeSingle();

        if (!active) return;

        if (fetchError) {
          setError(fetchError as unknown as Error);
          setContractor(null);
        } else {
          setContractor((data as ContractorRecord) ?? null);
          setError(null);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [userId, nonce]);

  return { contractor, loading, error, refetch: () => setNonce((n) => n + 1) };
}

/**
 * useContractorRecord + the no-row funnel. Identical return shape to
 * useContractorRecord, but once the read SETTLES with no `contractors` row for an
 * authenticated contractor, it routes them to /contractor/pre-approval (the
 * Phase-6 row-creating gate, #297) instead of leaving the consumer stuck on
 * `!contractor` forever.
 *
 * Why this is the contractor-track default (D-211 P18): every contractor page
 * (dashboard / opportunities / profile / settings / bid / sign / auto-bids) reads
 * the row via this hook and gates render on `loading || !contractor`. Without the
 * funnel, a contractor-role user with zero rows sat on an infinite spinner. The
 * redirect window is covered by each page's EXISTING spinner gate (contractor stays
 * null), so there is no content flash and no per-page gate change is needed.
 *
 * Scope: fires ONLY on the unambiguous "no row" signal (settled, no error, no row).
 * A genuine fetch error (`error` set) is left to the consumer's existing handling —
 * we never bounce on a transient/RLS error, only on a confirmed-absent row.
 */
export function useContractorRecordGate(
  userId: string | null | undefined,
): UseContractorRecordResult {
  const result = useContractorRecord(userId);
  const router = useRouter();
  const { loading, error, contractor } = result;

  useEffect(() => {
    // Wait for a real user + a settled read. `!error` keeps this to the confirmed
    // no-row case (.maybeSingle() → data:null/error:null); errors fall through to
    // the consumer. No loop: /contractor/pre-approval does NOT use ContractorShell
    // and only redirects back to the dashboard once a row exists and is active.
    if (!userId || loading || error) return;
    if (!contractor) {
      router.replace(CONTRACTOR_PRE_APPROVAL_ROUTE);
    }
  }, [userId, loading, error, contractor, router]);

  return result;
}
