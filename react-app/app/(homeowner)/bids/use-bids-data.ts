'use client';

/**
 * Homeowner bids data hooks (D-211 P21).
 *
 * ADR-009 data-hook pattern: useState/useEffect over the shared `supabase`
 * singleton; RLS is the real data gate. These mirror the reads the static
 * bids.html performed in loadClaimData()/loadBids()/loadBidUpdatedNotifications()
 * and resolveContractorPhotos().
 *
 * The LIVE bid list itself is supplied by the shared `useBidUpdates(claimId)`
 * realtime hook (reused, not rebuilt — its generic BidData rows are cast to the
 * richer BidRow shape, per the use-claim-status "cast, don't modify" pattern).
 * These hooks cover the surrounding one-shot reads: the claim, the contractor
 * profiles (+ signed owner photos), and the bid_updated notifications.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { resolveOwnerPhotoUrl } from './actions';
import type { BidRow, BidNotification, BidsClaim, ContractorProfile } from './types';

// ── Claim resolution (bids.html:554-567) ─────────────────────────────────────

export interface BidsClaimResult {
  claim: BidsClaim | null;
  claimId: string | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Resolve the claim the bids belong to: the `claim_id` URL param when present
 * (scoped to the homeowner), else the homeowner's most-recent claim. Unlike the
 * dashboard this does NOT auto-create a draft — /bids only views existing claims.
 */
export function useBidsClaim(
  userId: string | null | undefined,
  claimIdParam?: string | null,
): BidsClaimResult {
  const [claim, setClaim] = useState<BidsClaim | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);

    (async () => {
      try {
        let query = supabase.from('claims').select('*').eq('user_id', userId);
        query = claimIdParam
          ? query.eq('id', claimIdParam)
          : query.order('created_at', { ascending: false }).limit(1);

        const { data, error: fetchErr } = await query.maybeSingle();
        if (!mounted) return;

        if (fetchErr && fetchErr.code !== 'PGRST116') {
          setError(new Error(fetchErr.message));
          setClaim(null);
        } else {
          setClaim((data as BidsClaim) || null);
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
  }, [userId, claimIdParam]);

  return { claim, claimId: claim?.id ?? null, loading, error };
}

// ── Contractor profiles + signed photos (bids.html:575-589, 1100-1106) ───────

const CONTRACTOR_COLUMNS =
  'id, user_id, company_name, contact_name, owner_photo_url, about_us, years_in_business, ' +
  'service_area_description, service_counties, license_number, verified, google_reviews_url, ' +
  'rating, review_count, bbb_url, angi_url, yelp_url, specialties, why_choose_us, num_employees, ' +
  'trades, website_url';

export interface ContractorsResult {
  contractors: Record<string, ContractorProfile>;
  loading: boolean;
}

/**
 * Load the contractor profile for every contractor that has a bid, and resolve
 * each owner-photo signed URL into `_resolvedPhotoUrl`. Re-runs when the set of
 * contractor ids changes (not on every realtime tick).
 */
export function useBidContractors(bids: BidRow[]): ContractorsResult {
  const [contractors, setContractors] = useState<Record<string, ContractorProfile>>({});
  const [loading, setLoading] = useState(true);

  // Stable key over the unique contractor ids so the effect only refires when the
  // membership changes, not on every bid status/realtime update.
  const idKey = useMemo(() => {
    const ids = Array.from(new Set(bids.map((b) => b.contractor_id).filter(Boolean)));
    ids.sort();
    return ids.join(',');
  }, [bids]);

  useEffect(() => {
    if (!idKey) {
      setContractors({});
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);

    (async () => {
      const ids = idKey.split(',');
      const { data, error } = await supabase.from('contractors').select(CONTRACTOR_COLUMNS).in('id', ids);
      if (!mounted) return;
      if (error || !data) {
        setLoading(false);
        return;
      }

      const map: Record<string, ContractorProfile> = {};
      for (const row of data as unknown as ContractorProfile[]) map[row.id] = row;

      // Resolve signed owner-photo URLs in parallel (non-fatal per contractor).
      await Promise.all(
        Object.values(map).map(async (c) => {
          if (c.owner_photo_url) c._resolvedPhotoUrl = await resolveOwnerPhotoUrl(c.owner_photo_url);
        }),
      );

      if (mounted) {
        setContractors(map);
        setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [idKey]);

  return { contractors, loading };
}

// ── Bid-updated notifications banner (bids.html:607-656) ─────────────────────

export interface BidUpdatedNotificationsResult {
  notifications: BidNotification[];
  ids: string[];
  loading: boolean;
  /** Clear the banner locally (the caller persists read_at via actions). */
  clear: () => void;
}

/** Unread `bid_updated` notifications for this homeowner+claim (one-shot read). */
export function useBidUpdatedNotifications(
  userId: string | null | undefined,
  claimId: string | null | undefined,
): BidUpdatedNotificationsResult {
  const [notifications, setNotifications] = useState<BidNotification[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId || !claimId) {
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);

    (async () => {
      try {
        const { data, error } = await supabase
          .from('notifications')
          .select('id, message_preview, created_at')
          .eq('user_id', userId)
          .eq('claim_id', claimId)
          .eq('notification_type', 'bid_updated')
          .is('read_at', null)
          .order('created_at', { ascending: false });
        if (!mounted) return;
        if (!error && data) setNotifications(data as BidNotification[]);
        setLoading(false);
      } catch {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [userId, claimId]);

  const clear = useCallback(() => setNotifications([]), []);
  const ids = useMemo(() => notifications.map((n) => n.id), [notifications]);

  return { notifications, ids, loading, clear };
}
