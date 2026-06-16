'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { ContractorRecord } from '../_shell/use-contractor-record';
import {
  applyMyBids,
  excludeCappedClaims,
  filterByTradeRelease,
  mapClaimToOpportunity,
  type MyBid,
  type Opportunity,
  type RawClaim,
} from './utils';

export interface UseOpportunitiesResult {
  opportunities: Opportunity[];
  loading: boolean;
  error: Error | null;
}

/**
 * Load the contractor's available opportunities (D-211 Phase 3, ports the
 * contractor-opportunities.html init() data pipeline). Follows the ADR-009
 * data-hook pattern (useState/useEffect + the shared supabase singleton; RLS is
 * the real data gate). Runs only once `ready` is true (i.e. after the page's
 * pending/CPA/state gates have resolved) and a contractor record exists.
 *
 * Pipeline (parity with the static page):
 *   claims(ready_for_bids, active|bidding|pending) → map → D-165 trade/release
 *   filter → D-030 max-6-bids cap → D-150 exclude-own-active-bids (+expired flag).
 */
export function useOpportunitiesData(
  contractor: ContractorRecord | null,
  ready: boolean,
): UseOpportunitiesResult {
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!ready || !contractor) {
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const { data, error: claimsErr } = await supabase
          .from('claims')
          .select('*')
          .eq('ready_for_bids', true)
          .in('status', ['active', 'bidding', 'pending'])
          .order('created_at', { ascending: false })
          .limit(50);

        if (!active) return;
        if (claimsErr) throw claimsErr;

        const contractorZip = (contractor.address_zip as string | null | undefined) ?? null;
        let opps: Opportunity[] = (data ?? []).map((claim) =>
          mapClaimToOpportunity(claim as RawClaim, contractorZip),
        );

        // D-165 trade + release filter (only when the contractor has trades set).
        opps = filterByTradeRelease(opps, (contractor.trades as string[] | null) ?? null);

        // D-030: exclude opportunities already at the 6-bid cap.
        if (opps.length > 0) {
          const claimIds = opps.map((o) => o.id);
          const { data: bidCounts } = await supabase
            .from('quotes')
            .select('claim_id')
            .in('claim_id', claimIds);
          if (!active) return;
          if (bidCounts) {
            const countMap: Record<string, number> = {};
            for (const q of bidCounts as { claim_id: string }[]) {
              countMap[q.claim_id] = (countMap[q.claim_id] || 0) + 1;
            }
            opps = excludeCappedClaims(opps, countMap);
          }
        }

        // D-150: exclude this contractor's active bids; keep + flag expired ones.
        const { data: myBids } = await supabase
          .from('quotes')
          .select('id, claim_id, bid_status')
          .eq('contractor_id', contractor.id);
        if (!active) return;
        if (myBids && myBids.length > 0) {
          const myBidMap: Record<string, MyBid> = {};
          for (const b of myBids as { id: string; claim_id: string; bid_status: string }[]) {
            myBidMap[b.claim_id] = { quoteId: b.id, bidStatus: b.bid_status };
          }
          opps = applyMyBids(opps, myBidMap);
        }

        setOpportunities(opps);
      } catch (err) {
        if (active) {
          console.error('Error loading opportunities:', err);
          // Production parity: do NOT fall back to demo data — show empty state.
          setOpportunities([]);
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [ready, contractor]);

  return { opportunities, loading, error };
}
