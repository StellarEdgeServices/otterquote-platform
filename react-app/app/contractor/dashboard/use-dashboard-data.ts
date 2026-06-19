'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  buildLocation,
  buildMaterial,
  contractorNeedsToSign,
  filterOpportunities,
  formatActivityTime,
  formatMoney,
  titleCase,
  PROJECT_STATUS_LABEL,
  type OppClaim,
} from './utils';

export interface PendingBid {
  quoteId: string;
  claimId: string;
  location: string;
  damageType: string;
  bidAmount: string;
  submittedDate: string;
  bidStatus: string | null;
  expiresAt: string | null;
}

export interface ActiveProject {
  id: string;
  fullId: string;
  quoteId: string;
  location: string;
  damageType: string;
  material: string;
  estimatedValue: string;
  status: string; // 'Won' | 'Completed' | raw
  completionDate: string | null;
  warrantyUrl: string | null;
  needsSignature: boolean; // contractor still owes Step-A signature (D-211 P17 Unit B)
}

export interface ActivityItem {
  text: string;
  time: string;
  type: string;
}

export interface DashboardStats {
  availableCount: number;
  activeBids: number;
  wonJobs: number;
  earnings: number;
}

export interface DunningInfo {
  id: string;
  amountCents: number;
}

export interface DashboardData {
  loading: boolean;
  stats: DashboardStats;
  pendingBids: PendingBid[];
  activeProjects: ActiveProject[];
  activity: ActivityItem[];
  dunning: DunningInfo | null;
}

const EMPTY_STATS: DashboardStats = { availableCount: 0, activeBids: 0, wonJobs: 0, earnings: 0 };

/**
 * Loads the contractor dashboard view-model. Mirrors contractor-dashboard.html
 * init() (opportunity count with the exact opportunities-page filter, active-bid
 * / won-job counts, monthly earnings, the bids + projects split, activity feed,
 * and the active dunning record). RLS is the real data gate; all derivation uses
 * the pure helpers in ./utils. Pass a resolved contractor id + user id.
 */
export function useDashboardData(
  contractor: { id?: string | null; trades?: string[] | null } | null,
  userId: string | null | undefined,
): DashboardData {
  const [data, setData] = useState<DashboardData>({
    loading: true,
    stats: EMPTY_STATS,
    pendingBids: [],
    activeProjects: [],
    activity: [],
    dunning: null,
  });

  const contractorId = contractor?.id ?? null;
  const trades = contractor?.trades ?? null;

  useEffect(() => {
    if (!contractorId || !userId) {
      setData((d) => ({ ...d, loading: false }));
      return;
    }
    let active = true;

    (async () => {
      const stats: DashboardStats = { ...EMPTY_STATS };
      let pendingBids: PendingBid[] = [];
      let activeProjects: ActiveProject[] = [];
      let activity: ActivityItem[] = [];
      let dunning: DunningInfo | null = null;

      try {
        // 1) Available opportunities (same filter as the opportunities page).
        try {
          const { data: oppClaims } = await supabase
            .from('claims')
            .select('*')
            .eq('ready_for_bids', true)
            .in('status', ['active', 'bidding', 'pending'])
            .order('created_at', { ascending: false })
            .limit(50);
          if (oppClaims && oppClaims.length > 0) {
            const claimIds = oppClaims.map((c: { id: string }) => c.id);
            const { data: bidRows } = await supabase
              .from('quotes')
              .select('claim_id')
              .in('claim_id', claimIds);
            const bidCountByClaim: Record<string, number> = {};
            (bidRows || []).forEach((q: { claim_id: string }) => {
              bidCountByClaim[q.claim_id] = (bidCountByClaim[q.claim_id] || 0) + 1;
            });
            const { data: myBids } = await supabase
              .from('quotes')
              .select('claim_id')
              .eq('contractor_id', contractorId);
            const myBidClaimIds = new Set<string>((myBids || []).map((b: { claim_id: string }) => b.claim_id));
            const contractorTrades = Array.isArray(trades) ? trades : [];
            stats.availableCount = filterOpportunities(
              oppClaims as OppClaim[],
              contractorTrades,
              bidCountByClaim,
              myBidClaimIds,
            ).length;
          }
        } catch {
          /* non-fatal: leave availableCount at 0 */
        }

        // 2) Active bids / 3) Won jobs (counts).
        const [{ count: activeBids }, { count: wonJobs }] = await Promise.all([
          supabase.from('quotes').select('id', { count: 'exact', head: true })
            .eq('contractor_id', contractorId).in('status', ['pending', 'submitted']),
          supabase.from('quotes').select('id', { count: 'exact', head: true })
            .eq('contractor_id', contractorId).in('status', ['selected', 'awarded']),
        ]);
        stats.activeBids = activeBids ?? 0;
        stats.wonJobs = wonJobs ?? 0;

        // 4) Monthly earnings (sum fee_amount on won quotes this calendar month).
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const { data: earnData } = await supabase
          .from('quotes').select('fee_amount')
          .eq('contractor_id', contractorId).in('status', ['selected', 'awarded'])
          .gte('updated_at', monthStart);
        stats.earnings = (earnData || []).reduce(
          (sum: number, q: { fee_amount: number | string | null }) => sum + (parseFloat(String(q.fee_amount)) || 0),
          0,
        );

        // 5) All quotes → submitted bids + active/won projects (D-074 privacy).
        const { data: allQuotes } = await supabase
          .from('quotes')
          .select('id, claim_id, total_price, status, contractor_signed_at, bid_status, expires_at, created_at, warranty_document_url, claims(id, property_address, damage_type, material_category, shingle_type, rcv_amount, completion_date)')
          .eq('contractor_id', contractorId)
          .in('status', ['submitted', 'selected', 'awarded', 'completed'])
          .order('created_at', { ascending: false })
          .limit(50);

        (allQuotes || []).forEach((q: Record<string, unknown>) => {
          const claim = (q.claims as Record<string, unknown>) || {};
          const status = String(q.status);
          if (status === 'submitted') {
            pendingBids.push({
              quoteId: String(q.id),
              claimId: String(q.claim_id),
              location: buildLocation(claim.property_address as string, status),
              damageType: titleCase(claim.damage_type as string, 'Roofing'),
              bidAmount: formatMoney(q.total_price as number),
              submittedDate: new Date(String(q.created_at)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
              bidStatus: (q.bid_status as string) || null,
              expiresAt: (q.expires_at as string) || null,
            });
          } else {
            activeProjects.push({
              id: claim.id ? String(claim.id).slice(0, 8) : String(q.claim_id).slice(0, 8) || '—',
              fullId: String(q.claim_id),
              quoteId: String(q.id),
              location: buildLocation(claim.property_address as string, status),
              damageType: titleCase(claim.damage_type as string),
              material: buildMaterial(claim),
              estimatedValue: q.total_price ? formatMoney(q.total_price as number) : formatMoney(claim.rcv_amount as number),
              status: PROJECT_STATUS_LABEL[status] || status,
              completionDate: (claim.completion_date as string) || null,
              warrantyUrl: (q.warranty_document_url as string) || null,
              needsSignature: contractorNeedsToSign(status, (q.contractor_signed_at as string | null) ?? null),
            });
          }
        });

        // 6) Activity feed.
        const { data: activityData } = await supabase
          .from('activity_log')
          .select('event_type, title, metadata, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(15);
        activity = (activityData || []).map((evt: Record<string, unknown>) => ({
          text: String(evt.title ?? ''),
          time: formatActivityTime(String(evt.created_at)),
          type: String(evt.event_type ?? ''),
        }));

        // 7) Active dunning record (read-only — see page.tsx for the folded
        //    [critical] dead "Retry Payment Now" path).
        try {
          const { data: failures } = await supabase
            .from('payment_failures')
            .select('id, amount_cents')
            .eq('contractor_id', contractorId)
            .eq('dunning_status', 'active')
            .order('created_at', { ascending: false })
            .limit(1);
          if (failures && failures.length > 0) {
            dunning = { id: String(failures[0].id), amountCents: Number(failures[0].amount_cents) || 0 };
          }
        } catch {
          /* non-fatal */
        }
      } catch (err) {
        console.error('[dashboard] data load error:', err);
      }

      if (!active) return;
      setData({ loading: false, stats, pendingBids, activeProjects, activity, dunning });
    })();

    return () => { active = false; };
  }, [contractorId, userId, trades]);

  return data;
}
