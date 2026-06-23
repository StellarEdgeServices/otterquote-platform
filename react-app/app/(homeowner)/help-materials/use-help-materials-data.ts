'use client';

/**
 * Homeowner help-materials data layer (H8) — D-211. ADR-009 useState/useEffect
 * over the shared supabase singleton; RLS is the real gate. Mirrors the reads
 * and the single write the static help-materials.html performed.
 *
 * NO Services / NO Edge Function — H8 reads material_catalog + claims and writes
 * claims directly through the singleton, exactly as the static page did. There
 * is no actions.ts here by design (unlike H7, which had an EF-backed flow).
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { ClaimMaterialUpdate, MaterialCatalogRow } from './types';

export interface CurrentClaimResult {
  claimId: string | null;
  loading: boolean;
  error: Error | null;
}

/**
 * The homeowner's most-recent claim id — the row the confirmation writes to.
 * Static used .single(); we use .maybeSingle() so a genuine no-claim renders
 * gracefully (no row → claimId stays null, no error). Mirrors the dashboard's
 * latest-claim read, minus the auto-create-draft behaviour (the static help
 * page did not create a claim).
 */
export function useCurrentClaimId(userId: string | null | undefined): CurrentClaimResult {
  const [claimId, setClaimId] = useState<string | null>(null);
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
          .select('id')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!mounted) return;
        if (fetchErr && fetchErr.code !== 'PGRST116') {
          setError(new Error(fetchErr.message));
        } else if (data) {
          setClaimId((data as { id: string }).id);
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

  return { claimId, loading, error };
}

export interface DesignerProductsResult {
  products: MaterialCatalogRow[];
  loading: boolean;
  error: Error | null;
}

/**
 * Designer products from material_catalog. Lazy: only fires once `enabled`
 * (the user picked the Designer shingle path), then caches its result. Mirrors
 * the static loadDesignerProducts() query exactly.
 */
export function useDesignerProducts(enabled: boolean): DesignerProductsResult {
  const [products, setProducts] = useState<MaterialCatalogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled || loaded) return;
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const { data, error: fetchErr } = await supabase
          .from('material_catalog')
          .select('*')
          .eq('subcategory', 'designer')
          .eq('active', true)
          .order('sort_order');
        if (!mounted) return;
        if (fetchErr) {
          setError(new Error(fetchErr.message));
        } else {
          setProducts((data as MaterialCatalogRow[]) ?? []);
          setLoaded(true);
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
  }, [enabled, loaded]);

  return { products, loading, error };
}

/**
 * Persist the material selection to the homeowner's current claim. Direct
 * singleton write (no EF) — mirrors the static submitSelection() update. Throws
 * on error so the caller re-enables the Confirm button (brief item 3e).
 */
export async function saveMaterialSelection(
  claimId: string,
  update: ClaimMaterialUpdate,
): Promise<void> {
  const { error } = await supabase.from('claims').update(update).eq('id', claimId);
  if (error) throw new Error(error.message);
}
