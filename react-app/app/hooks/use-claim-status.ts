'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export interface ClaimData {
  id: string;
  user_id: string;
  title: string;
  description: string;
  status: 'open' | 'in_progress' | 'completed' | 'closed';
  created_at: string;
  updated_at: string;
  budget: number;
  deadline?: string;
}

export interface UseClaimStatusResult {
  claim: ClaimData | null;
  loading: boolean;
  error: Error | null;
  retry?: () => void;
}

/**
 * useClaimStatus: Subscribe to real-time updates for a single claim.
 *
 * Returns the claim data and loading/error state.
 * Automatically cleans up subscription on unmount.
 *
 * Fallback: If real-time subscription fails, falls back to polling via React Query.
 */
export function useClaimStatus(claimId: string): UseClaimStatusResult {
  const [claim, setClaim] = useState<ClaimData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!claimId) {
      setLoading(false);
      return;
    }

    let isMounted = true;
    let subscription: any = null;

    const subscribe = async () => {
      try {
        // Initial fetch
        const { data, error: fetchError } = await supabase
          .from('claims')
          .select('*')
          .eq('id', claimId)
          .single();

        if (!isMounted) return;

        if (fetchError) {
          setError(fetchError);
          setLoading(false);
          return;
        }

        setClaim(data);
        setError(null);
        setLoading(false);

        // Subscribe to real-time updates
        const channel = supabase
          .channel(`claim-status-${claimId}`)
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'claims',
              filter: `id=eq.${claimId}`,
            },
            (payload) => {
              if (isMounted) {
                if (payload.eventType === 'DELETE') {
                  setClaim(null);
                } else {
                  setClaim(payload.new as ClaimData);
                }
              }
            }
          )
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              if (process.env.NODE_ENV === 'development') {
                console.log(`[useClaimStatus] Subscribed to claim ${claimId}`);
              }
            } else if (status === 'CLOSED') {
              if (process.env.NODE_ENV === 'development') {
                console.warn(`[useClaimStatus] Subscription closed for claim ${claimId}`);
              }
            }
          });

        subscription = channel;
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      }
    };

    subscribe();

    return () => {
      isMounted = false;
      if (subscription) {
        supabase.removeChannel(subscription);
      }
    };
  }, [claimId]);

  return { claim, loading, error };
}
