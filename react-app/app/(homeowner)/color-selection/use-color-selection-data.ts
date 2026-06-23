'use client';

/**
 * Homeowner color-selection data layer — D-211 Phase 27, PR 2/2.
 *
 * ADR-009 useState/useEffect over the shared supabase singleton; RLS is the real
 * gate. Mirrors use-project-confirmation-data.ts (H4) idiom. Faithful port of the
 * static init (color-selection.html:629-713) and its three mutations
 * (requestColorBoardVisit:999-1059, handleColorConfirmation save:1081-1091,
 * createColorAddendum EF call:1123-1159).
 *
 * Faithful-port notes:
 *   • Ownership is scoped by claims.homeowner_id (NOT user_id) — the static keys the
 *     claim on homeowner_id (color-selection.html:656). This page loads the claim by
 *     id and gates ownership separately (mirrors H4's missing-claim/access-denied
 *     split) rather than the static's in-query .eq() + alert/redirect.
 *   • The profile lookup uses profiles.id = auth uid (color-selection.html:636 and the
 *     dominant codebase convention — dashboard/help-estimate/repair-intake/auth-provider
 *     all key profiles on `id`). H4's use-project-confirmation-data.ts keys on `user_id`,
 *     which is the outlier; this hook follows the static + the majority convention so the
 *     signer email (which gates the addendum) resolves.
 *   • The contractor join targets the private `contractors` table (color-selection.html:650),
 *     NOT contractors_public — contractors_public exposes neither preferred_brand nor the
 *     phone columns. Columns are verbatim from the static/brief. RLS unchanged (Tier-3).
 *   • createColorAddendumEnvelope omits the `signer` field (D-220: the EF derives the
 *     signer server-side) and sends a return_url targeting this React route — the same
 *     delta H4 applied. The static sent signer + no return_url.
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { COLOR_COPY } from './copy';
import {
  normalizeBrand,
  extractZip,
  resolvePrimaryPhone,
  buildColorAddendumPayload,
  buildColorReturnUrl,
} from './utils';

// ── Row shapes ─────────────────────────────────────────────────────────────────

export interface ColorContractorRow {
  id: string;
  name?: string | null;
  preferred_brand?: string | null;
  phone?: string | null;
  notification_phones?: string[] | null;
  email?: string | null;
}

export interface ColorClaimRow {
  id: string;
  homeowner_id?: string | null;
  selected_contractor_id?: string | null;
  property_address?: string | null;
  // Supabase returns an embedded to-one resource as an object; typed permissively
  // (object | array | null) and normalized below so the page sees a single row.
  contractor?: ColorContractorRow | ColorContractorRow[] | null;
  color_brand?: string | null;
  color_name?: string | null;
  color_selected_at?: string | null;
}

// ── Gate type ──────────────────────────────────────────────────────────────────

export type ColorSelectionGate = 'ready' | 'missing-claim' | 'access-denied';

// ── Return shape ───────────────────────────────────────────────────────────────

export interface ColorSelectionData {
  claim: ColorClaimRow | null;
  contractor: ColorContractorRow | null;
  contractorId: string | null;
  /** Normalized contractor brand (utils.normalizeBrand), null when unconfirmed/unknown. */
  brand: string | null;
  /** 5-digit ZIP for the OC widget (extractZip; defaults to '46077'). */
  zipCode: string;
  contractorName: string;
  contractorPhone: string | null;
  /** Signer display name (profiles.full_name → 'Homeowner'). Display only. */
  signerName: string;
  /** Signer email (profiles.email → ''). Gates the addendum; NOT sent in the payload. */
  signerEmail: string;
  /** Already-confirmed color name (claims.color_name) — prefills + shows success on load. */
  selectedColorName: string | null;
  gate: ColorSelectionGate;
  loading: boolean;
  error: string | null;
}

const EMPTY: ColorSelectionData = {
  claim: null,
  contractor: null,
  contractorId: null,
  brand: null,
  zipCode: '46077',
  contractorName: COLOR_COPY.contractorNameFallback,
  contractorPhone: null,
  signerName: COLOR_COPY.signerNameFallback,
  signerEmail: '',
  selectedColorName: null,
  gate: 'missing-claim',
  loading: true,
  error: null,
};

/**
 * Load claim + contractor (+ signer profile) for the color-selection page. Faithful
 * port of static loadClaimData (color-selection.html:629-713). Fires once
 * ready && userId present. Null claimId → gate 'missing-claim' immediately.
 */
export function useColorSelectionData(
  userId: string | null,
  claimId: string | null,
  ready: boolean,
): ColorSelectionData {
  const [data, setData] = useState<ColorSelectionData>(EMPTY);

  useEffect(() => {
    if (!ready) return;

    // claimId missing → gate immediately, no network call.
    if (!claimId) {
      setData({ ...EMPTY, loading: false, gate: 'missing-claim' });
      return;
    }

    // Params resolved but no user yet → wait for auth.
    if (!userId) return;

    let active = true;
    setData((d) => ({ ...d, loading: true, error: null }));

    (async () => {
      try {
        // 1. Signer profile (static 632-641) — profiles.id = auth uid; display + gate only.
        const { data: profile } = await supabase
          .from('profiles')
          .select('full_name, email')
          .eq('id', userId)
          .single();
        const signerName =
          (profile as { full_name?: string | null } | null)?.full_name ||
          COLOR_COPY.signerNameFallback;
        const signerEmail = (profile as { email?: string | null } | null)?.email || '';

        // 2. Load claim by id with contractor join (static 643-657)
        const { data: claimData, error: claimError } = await supabase
          .from('claims')
          .select(
            `
            id,
            homeowner_id,
            selected_contractor_id,
            property_address,
            contractor:contractors(id, name, preferred_brand, phone, notification_phones, email),
            color_brand,
            color_name,
            color_selected_at
          `,
          )
          .eq('id', claimId)
          .single();

        if (claimError || !claimData) {
          throw new Error('Claim not found. Please return to your dashboard.');
        }
        const claim = claimData as ColorClaimRow;

        // 3. Ownership gate (static 656 scoped homeowner_id; here split like H4)
        if (claim.homeowner_id && userId && claim.homeowner_id !== userId) {
          if (!active) return;
          setData({ ...EMPTY, loading: false, gate: 'access-denied' });
          return;
        }

        // 4. Normalize the embedded contractor to a single row.
        const contractor: ColorContractorRow | null = Array.isArray(claim.contractor)
          ? claim.contractor[0] ?? null
          : claim.contractor ?? null;

        // 5. Derived fields (static 666-686)
        const contractorId = claim.selected_contractor_id ?? null;
        const contractorName = contractor?.name || COLOR_COPY.contractorNameFallback;
        const brand = normalizeBrand(contractor?.preferred_brand);
        const zipCode = extractZip(claim.property_address);
        const contractorPhone = resolvePrimaryPhone(
          contractor?.notification_phones,
          contractor?.phone,
        );
        const selectedColorName = claim.color_name ?? null;

        if (!active) return;
        setData({
          claim,
          contractor,
          contractorId,
          brand,
          zipCode,
          contractorName,
          contractorPhone,
          signerName,
          signerEmail,
          selectedColorName,
          gate: 'ready',
          loading: false,
          error: null,
        });
      } catch (err) {
        if (!active) return;
        setData({
          ...EMPTY,
          loading: false,
          gate: 'missing-claim',
          error: err instanceof Error ? err.message : 'Unable to load claim',
        });
      }
    })();

    return () => {
      active = false;
    };
  }, [userId, claimId, ready]);

  return data;
}

// ── Mutations ──────────────────────────────────────────────────────────────────

/**
 * SAVE-FIRST step: persist the chosen color to claims, scoped by id + homeowner_id
 * (static handleColorConfirmation 1081-1091). Throws on error so the page can show
 * the success state only on a real save.
 */
export async function saveColorSelection({
  claimId,
  userId,
  brand,
  colorName,
}: {
  claimId: string;
  userId: string;
  brand: string | null;
  colorName: string;
}): Promise<void> {
  const { error } = await supabase
    .from('claims')
    .update({
      color_brand: brand,
      color_name: colorName,
      color_selected_at: new Date().toISOString(),
    })
    .eq('id', claimId)
    .eq('homeowner_id', userId);

  if (error) {
    throw new Error('Failed to save color selection: ' + error.message);
  }
}

/**
 * Create the color_confirmation DocuSign envelope and return its embedded signing URL.
 * Calls create-docusign-envelope EF UNCHANGED. No `signer` field (D-220); return_url
 * targets this React route. Throws on EF error or missing signing_url (→ page fallback).
 */
export async function createColorAddendumEnvelope({
  claimId,
  contractorId,
  origin,
}: {
  claimId: string;
  contractorId: string;
  origin: string;
}): Promise<{ signingUrl: string; envelopeId: string | null }> {
  const body = buildColorAddendumPayload({
    claimId,
    contractorId,
    returnUrl: buildColorReturnUrl(origin, claimId),
  });

  const { data: result, error } = await supabase.functions.invoke('create-docusign-envelope', {
    body,
  });

  if (error) {
    throw new Error(error.message || 'Failed to create color addendum envelope.');
  }
  if (!result?.signing_url) {
    throw new Error('No signing URL returned from DocuSign');
  }

  return {
    signingUrl: result.signing_url as string,
    envelopeId: (result.envelope_id as string | null | undefined) ?? null,
  };
}

// ── In-person color board request ────────────────────────────────────────────────

export type ColorBoardResult =
  | { status: 'already' }
  | { status: 'created' }
  | { status: 'error'; error: string };

/**
 * Faithful port of requestColorBoardVisit (color-selection.html:999-1059): dedup check
 * then insert a 'color_board_request' notification. Any failure (dedup or insert) →
 * { status: 'error' } so the page can fall back to the mailto. Does NOT alter
 * notifications RLS (Tier-3 — preserved as the static wrote it).
 */
export async function requestColorBoardVisit({
  claimId,
  userId,
}: {
  claimId: string;
  userId: string;
}): Promise<ColorBoardResult> {
  try {
    // Dedup (static 1005-1010) — maybeSingle; the static ignores a dedup error and
    // proceeds to insert, so any select error simply yields no `existing`.
    const { data: existing } = await supabase
      .from('notifications')
      .select('id')
      .eq('claim_id', claimId)
      .eq('notification_type', 'color_board_request')
      .maybeSingle();

    if (existing) {
      return { status: 'already' };
    }

    // Insert (static 1023-1033)
    const { error } = await supabase.from('notifications').insert({
      claim_id: claimId,
      notification_type: 'color_board_request',
      channel: 'dashboard',
      recipient: '',
      message_preview: 'Homeowner requesting a color board visit.',
      user_id: userId,
      created_at: new Date().toISOString(),
    });

    if (error) throw error;

    return { status: 'created' };
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : 'Failed to request color board visit.',
    };
  }
}
