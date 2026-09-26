'use client';

/**
 * Homeowner dashboard data hooks (D-211).
 *
 * ADR-009 data-hook pattern: useState/useEffect over the shared `supabase`
 * singleton; RLS is the real data gate. These mirror the reads the static
 * dashboard.html performed in loadClaimData()/loadProfileData()/loadCarriers()
 * and updateStatusBanner(). Live claim-stage updates ride the shared
 * useClaimStatus hook (subscribed in the page); these hooks cover the
 * one-shot/auxiliary reads.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type {
  CarrierOption,
  HomeownerClaim,
  HomeownerProfile,
  HoverOrder,
  HoverRebateOrder,
} from './types';

// ── Latest claim id (with draft auto-create, dashboard.html:1594-1704) ───────

export interface LatestClaimResult {
  claimId: string | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Resolve the homeowner's most-recent claim id. gh-2004: this previously
 * created a draft ({ status:'draft', damage_type:'roof' }) here with no
 * address at all — the four `property_*` columns all NULL — whenever a
 * signed-in homeowner had no claim yet. That claim then permanently blocked
 * the one flow that does collect an address (trade-selector's own
 * `hasFullAddress()` gate, gh-2004/#2007): once ANY claim exists,
 * trade-selector's returning-user guard sends the homeowner straight back
 * here instead. Now, when no claim exists, this redirects to trade-selector
 * instead of inserting anything, so a claim is never created without an
 * address on this path either.
 */
export function useLatestClaim(userId: string | null | undefined): LatestClaimResult {
  const [claimId, setClaimId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  // Guard against React StrictMode's double-effect creating two draft claims.
  const resolving = useRef(false);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    if (resolving.current) return;
    resolving.current = true;

    let mounted = true;
    (async () => {
      try {
        const { data, error: fetchErr } = await supabase
          .from('claims')
          .select('id')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!mounted) return;

        if (fetchErr && fetchErr.code !== 'PGRST116') {
          setError(new Error(fetchErr.message));
          setLoading(false);
          return;
        }

        if (data?.id) {
          setClaimId(data.id);
          setLoading(false);
          return;
        }

        // No claim yet. gh-2004: route to trade-selector — the surface that
        // actually collects/validates a full address before any claim is
        // created — instead of inserting an addressless draft here. Loading
        // is left true (not set false) so no dead-end dashboard state ever
        // renders in the moment before the redirect lands.
        if (typeof window !== 'undefined') {
          window.location.href = '/trade-selector';
        }
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
  }, [userId]);

  return { claimId, loading, error };
}

// ── Homeowner profile (dashboard.html:1535-1577) ─────────────────────────────

export interface ProfileResult {
  profile: HomeownerProfile | null;
  loading: boolean;
}

/**
 * Load the homeowner profile. If the row is absent, derive a minimal local
 * profile from auth metadata / the cs_signup hint and attempt a non-fatal upsert
 * (the static page did the same via Auth.updateProfile so downstream cards have a
 * profile id). Failure to persist still yields a usable local profile.
 */
export function useHomeownerProfile(
  userId: string | null | undefined,
  email: string | null | undefined,
): ProfileResult {
  const [profile, setProfile] = useState<HomeownerProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let mounted = true;
    (async () => {
      try {
        const { data } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .maybeSingle();

        if (!mounted) return;

        if (data) {
          setProfile(data as HomeownerProfile);
          setLoading(false);
          return;
        }

        // No profile row — derive a minimal default and try to persist it.
        let signup: Record<string, unknown> = {};
        try {
          signup = JSON.parse(
            localStorage.getItem('cs_signup') || sessionStorage.getItem('cs_signup') || '{}',
          );
        } catch {
          signup = {};
        }
        const firstName = (signup.first_name as string) || '';
        const lastName = (signup.last_name as string) || '';
        const fullName =
          `${firstName} ${lastName}`.trim() || email?.split('@')[0] || 'there';

        const local: HomeownerProfile = {
          id: userId,
          full_name: fullName,
          phone: (signup.phone as string) || null,
          address_street: (signup.address_street as string) || (signup.address as string) || null,
          address_city: (signup.address_city as string) || null,
          address_state: (signup.address_state as string) || null,
          address_zip: (signup.address_zip as string) || null,
          role: 'homeowner',
        };

        // Non-fatal persist (RLS allows a homeowner to upsert their own profile).
        supabase
          .from('profiles')
          .upsert(local, { onConflict: 'id' })
          .then(({ error: upErr }) => {
            if (upErr) console.warn('[dashboard] profile upsert failed (non-fatal):', upErr);
          });

        if (mounted) {
          setProfile(local);
          setLoading(false);
        }
      } catch {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [userId, email]);

  return { profile, loading };
}

// ── Carriers (dashboard.html:1579-1592) ──────────────────────────────────────

export function useCarriers(): CarrierOption[] {
  const [carriers, setCarriers] = useState<CarrierOption[]>([]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data, error } = await supabase
        .from('carrier_profiles')
        .select('id, carrier_name')
        .order('carrier_name');
      if (mounted && !error && data) {
        setCarriers(data.map((c) => ({ id: c.id as string, name: c.carrier_name as string })));
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  return carriers;
}

// ── Auxiliary claim data (hover / rebate / warranty / bids / home-profile) ───

export interface ClaimAuxData {
  hoverOrder: HoverOrder | null;
  rebateOrder: HoverRebateOrder | null;
  warrantyUrl: string | null;
  bidCount: number;
  hasHomeProfile: boolean;
  loading: boolean;
  refetch: () => void;
}

/**
 * Load the auxiliary reads the dashboard needs alongside the live claim row:
 *   • active Hover order (pending/link_sent) — resend card
 *   • latest Hover order with a payment intent — D-181 rebate card (display-only)
 *   • selected quote warranty_document_url — W3-P4 warranty button
 *   • bid count (quotes: submitted/selected) — D-178 status-banner copy
 *   • whether a home_profiles row exists — D-231 prompt eligibility
 */
export function useClaimAux(
  claimId: string | null | undefined,
  homeownerUserId: string | null | undefined,
): ClaimAuxData {
  const [aux, setAux] = useState<Omit<ClaimAuxData, 'loading' | 'refetch'>>({
    hoverOrder: null,
    rebateOrder: null,
    warrantyUrl: null,
    bidCount: 0,
    hasHomeProfile: false,
  });
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!claimId) {
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);

    (async () => {
      const next: Omit<ClaimAuxData, 'loading' | 'refetch'> = {
        hoverOrder: null,
        rebateOrder: null,
        warrantyUrl: null,
        bidCount: 0,
        hasHomeProfile: false,
      };

      // Active Hover order (resend card).
      try {
        const { data } = await supabase
          .from('hover_orders')
          .select('id, claim_id, status, capture_link, capturing_user_email, resend_count, last_resend_at, hover_job_id')
          .eq('claim_id', claimId)
          .in('status', ['pending', 'link_sent'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        next.hoverOrder = (data as HoverOrder) || null;
      } catch {
        /* non-fatal */
      }

      // D-181 rebate state (display-only).
      try {
        const { data } = await supabase
          .from('hover_orders')
          .select('id, homeowner_charge_amount, homeowner_stripe_payment_intent_id, rebate_due, rebate_paid_at')
          .eq('claim_id', claimId)
          .not('homeowner_stripe_payment_intent_id', 'is', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        next.rebateOrder = (data as HoverRebateOrder) || null;
      } catch {
        /* non-fatal */
      }

      // W3-P4 warranty document url.
      try {
        const { data } = await supabase
          .from('quotes')
          .select('warranty_document_url')
          .eq('claim_id', claimId)
          .in('status', ['selected'])
          .not('warranty_document_url', 'is', null)
          .order('warranty_uploaded_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        next.warrantyUrl = (data?.warranty_document_url as string) || null;
      } catch {
        /* non-fatal */
      }

      // Bid count for the status banner.
      try {
        const { count } = await supabase
          .from('quotes')
          .select('id', { count: 'exact', head: true })
          .eq('claim_id', claimId)
          .in('status', ['submitted', 'selected']);
        next.bidCount = count || 0;
      } catch {
        /* non-fatal */
      }

      // D-231 — does a home_profiles row already exist for this homeowner?
      if (homeownerUserId) {
        try {
          const { data } = await supabase
            .from('home_profiles')
            .select('id')
            .eq('homeowner_user_id', homeownerUserId)
            .maybeSingle();
          next.hasHomeProfile = !!data?.id;
        } catch {
          /* non-fatal */
        }
      }

      if (mounted) {
        setAux(next);
        setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [claimId, homeownerUserId, nonce]);

  return { ...aux, loading, refetch };
}
