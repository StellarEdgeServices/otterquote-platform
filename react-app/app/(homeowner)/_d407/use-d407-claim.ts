'use client';

/**
 * D-407 shared data layer (gh-3283 RCV page, gh-3285 Out-of-pocket). Byte-identical
 * in both pull requests.
 *
 * Reads the claim the intake wizard just saved (claim_id from the URL, scoped to
 * the signed-in user; otherwise the user's latest claim, as the static
 * project-info pages did) plus the profile contact fields, and writes through the
 * supabase singleton. Every write selects the row back and throws on zero rows, so
 * a silent RLS miss is loud (gh-2105 convention).
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

/** Columns from CLAIM_PUBLIC_COLUMNS only; homeowner_notes / urgency_reason are write-only here. */
const D407_CLAIM_COLUMNS =
  'id, user_id, homeowner_name, property_address, property_city, property_state, property_zip, urgency, urgency_deadline, has_estimate, estimate_filename, has_measurements, measurements_filename, has_material_selection, funding_type, policy_type, job_type, is_test';

export interface D407Claim {
  id: string;
  user_id: string;
  homeowner_name?: string | null;
  property_address?: string | null;
  property_city?: string | null;
  property_state?: string | null;
  property_zip?: string | null;
  urgency?: string | null;
  urgency_deadline?: string | null;
  has_estimate?: boolean | null;
  estimate_filename?: string | null;
  has_measurements?: boolean | null;
  measurements_filename?: string | null;
  has_material_selection?: boolean | null;
  funding_type?: string | null;
  policy_type?: string | null;
  job_type?: string | null;
  is_test?: boolean | null;
}

export interface D407Profile {
  full_name?: string | null;
  phone?: string | null;
}

export interface D407Data {
  claim: D407Claim | null;
  profile: D407Profile | null;
  loading: boolean;
  error: string | null;
}

const EMPTY: D407Data = { claim: null, profile: null, loading: true, error: null };

export function claimIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get('claim_id');
  } catch {
    return null;
  }
}

export function useD407Data(userId: string | null | undefined): D407Data {
  const [data, setData] = useState<D407Data>(EMPTY);

  useEffect(() => {
    if (!userId) return;
    let active = true;
    (async () => {
      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('full_name, phone')
          .eq('id', userId)
          .maybeSingle();

        const wanted = claimIdFromUrl();
        let q = supabase.from('claims').select(D407_CLAIM_COLUMNS).eq('user_id', userId);
        q = wanted ? q.eq('id', wanted) : q.order('created_at', { ascending: false }).limit(1);
        const { data: claim, error } = await q.maybeSingle();
        if (!active) return;
        if (error && error.code !== 'PGRST116') {
          setData({ claim: null, profile: null, loading: false, error: error.message });
          return;
        }
        setData({
          claim: (claim as D407Claim) ?? null,
          profile: (profile as D407Profile) ?? null,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (!active) return;
        setData({
          claim: null,
          profile: null,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load page.',
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [userId]);

  return data;
}

/** Profile contact fields (name, phone). Throws on error or a zero-row match. */
export async function saveContact(userId: string, fullName: string, phone: string): Promise<void> {
  const { data, error } = await supabase
    .from('profiles')
    .update({ full_name: fullName.trim(), phone: phone.trim(), updated_at: new Date().toISOString() })
    .eq('id', userId)
    .select('id');
  if (error) throw new Error(error.message);
  if (!Array.isArray(data) || data.length === 0) throw new Error('update_zero_rows: profiles (d407 contact)');
}

/** One claims write for the whole page. Throws on error or a zero-row match. */
export async function saveClaim(claimId: string, update: Record<string, unknown>): Promise<void> {
  const { data, error } = await supabase.from('claims').update(update).eq('id', claimId).select('id');
  if (error) throw new Error(error.message);
  if (!Array.isArray(data) || data.length === 0) throw new Error('update_zero_rows: claims (d407 page)');
}
