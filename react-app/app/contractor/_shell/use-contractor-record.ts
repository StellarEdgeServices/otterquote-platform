'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

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
        const { data, error: fetchError } = await supabase
          .from('contractors')
          .select('*')
          .eq('user_id', userId)
          .single();

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
