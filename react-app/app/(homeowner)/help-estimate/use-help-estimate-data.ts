'use client';

/**
 * Homeowner help-estimate data hooks (D-211). ADR-009 useState/useEffect over
 * the shared supabase singleton; RLS is the real gate. Mirrors the reads the
 * static help-estimate.html performed in loadClaimData()/getProfile()/
 * loadCarrierData().
 *
 * Unlike the dashboard's useLatestClaim, this does NOT auto-create a draft claim
 * — the static help page did not, and a genuine no-claim state must render
 * (brief 5f). Profile name comes from profiles.full_name (the React stack
 * standard — the static page's first_name/last_name do not exist on the
 * profiles table; verified sql/v0-base-schema.sql:61-79).
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Services, type CarrierProfile } from '@/lib/services';
import type { HelpEstimateClaim, HelpEstimateProfile } from './types';

export interface ClaimResult {
  claim: HelpEstimateClaim | null;
  loading: boolean;
  error: Error | null;
}

export function useHelpEstimateClaim(userId: string | null | undefined): ClaimResult {
  const [claim, setClaim] = useState<HelpEstimateClaim | null>(null);
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
        const { data, error: fetchErr } = await supabase
          .from('claims')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!mounted) return;
        if (fetchErr && fetchErr.code !== 'PGRST116') {
          setError(new Error(fetchErr.message));
        } else if (data) {
          setClaim(data as HelpEstimateClaim);
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
  }, [userId]);

  return { claim, loading, error };
}

export interface ProfileResult {
  profile: HelpEstimateProfile | null;
  loading: boolean;
}

export function useHelpEstimateProfile(userId: string | null | undefined): ProfileResult {
  const [profile, setProfile] = useState<HelpEstimateProfile | null>(null);
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
        if (data) setProfile(data as HelpEstimateProfile);
        setLoading(false);
      } catch {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [userId]);

  return { profile, loading };
}

export interface CarrierResult {
  carrier: CarrierProfile | null;
  loading: boolean;
}

export function useCarrierHelp(carrierId: string | null | undefined): CarrierResult {
  const [carrier, setCarrier] = useState<CarrierProfile | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!carrierId) {
      setCarrier(null);
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);
    (async () => {
      try {
        const result = await Services.getCarrierHelp(carrierId);
        if (mounted) {
          setCarrier(result);
          setLoading(false);
        }
      } catch {
        if (mounted) {
          setCarrier(null);
          setLoading(false);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [carrierId]);

  return { carrier, loading };
}
