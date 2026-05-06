'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export interface BidData {
  id: string;
  claim_id: string;
  contractor_id: string;
  amount: number;
  message: string;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: string;
  updated_at: string;
}

export interface UseBidUpdatesResult {
  bids: BidData[];
  loading: boolean;
  error: Error | null;
}

/**
 * useBidUpdates: Subscribe to real-time updates for bids on a specific claim.
 *
 * Handles INSERT (new bid) and UPDATE (status change) events.
 * Returns list of all bids for the claim and loading/error state.
 * Automatically cleans up subscription on unmount.
 */
export function useBidUpdates(claimId: string): UseBidUpdatesResult {
  const [bids, setBids] = useState<BidData[]>([]);
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
          .from('quotes')
          .select('*')
          .eq('claim_id', claimId);

        if (!isMounted) return;

        if (fetchError) {
          setError(fetchError);
          setLoading(false);
          return;
        }

        setBids(data || []);
        setError(null);
        setLoading(false);

        // Subscribe to real-time updates
        const channel = supabase
          .channel(`bid-updates-${claimId}`)
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'quotes',
              filter: `claim_id=eq.${claimId}`,
            },
            (payload) => {
              if (isMounted) {
                setBids((prev) => [...prev, payload.new as BidData]);
              }
            }
          )
          .on(
            'postgres_changes',
            {
              event: 'UPDATE',
              schema: 'public',
              table: 'quotes',
              filter: `claim_id=eq.${claimId}`,
            },
            (payload) => {
              if (isMounted) {
                setBids((prev) =>
                  prev.map((bid) =>
                    bid.id === (payload.new as BidData).id ? (payload.new as BidData) : bid
                  )
                );
              }
            }
          )
          .on(
            'postgres_changes',
            {
              event: 'DELETE',
              schema: 'public',
              table: 'quotes',
              filter: `claim_id=eq.${claimId}`,
            },
            (payload) => {
              if (isMounted) {
                setBids((prev) => prev.filter((bid) => bid.id !== (payload.old as BidData).id));
              }
            }
          )
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              if (process.env.NODE_ENV === 'development') {
                console.log(`[useBidUpdates] Subscribed to bids for claim ${claimId}`);
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

  return { bids, loading, error };
}
