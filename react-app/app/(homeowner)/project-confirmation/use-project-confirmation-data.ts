'use client';

/**
 * Homeowner project-confirmation data layer — D-211 Phase 26, PR 2/2.
 *
 * ADR-009 useState/useEffect over the shared supabase singleton; RLS is the real
 * gate. Mirrors use-contract-signing-data.ts idiom. Faithful port of the static
 * init (project-confirmation.html:2156-2311).
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { brandFromScopeSummary, extractDepreciation, isStatusAllowed } from './signing-utils';
import { buildProjectConfirmationEnvelopeRequest } from './signing-utils';
import { CLAIM_PUBLIC_COLUMNS, fetchClaimPrivateText } from '@/lib/claim-columns';

// ── Row shapes ─────────────────────────────────────────────────────────────────

export interface ConfirmationClaimRow {
  id: string;
  status?: string | null;
  selected_contractor_id?: string | null;
  user_id?: string | null;
  property_address?: string | null;
  shingle_manufacturer?: string | null;
  shingle_type?: string | null;
  parsed_line_items?: unknown;
  selected_trades?: unknown;
  funding_type?: string | null;
  job_type?: string | null;
  project_confirmation?: Record<string, unknown> | null;
}

export interface ContractorPublicRow {
  id: string;
  company_name?: string | null;
  years_in_business?: number | null;
  // gh-3056: get_contractors_public() exposes no logo column; never selected. Avatar falls back to initial.
  logo_url?: string | null;
}

export interface WinningQuoteRow {
  /** Derived from quotes.scope_summary JSON `.brand` (free-text "Brand & Product Line"); quotes has no brand column. */
  brand?: string | null;
  /** gh-3138: the bid stores no separate product line anywhere; always null so the claim's shingle_type fallback shows. */
  product_line?: string | null;
  decking_price_per_sheet?: number | null;
  status?: string | null;
}

/** gh-3138: public.quotes has no brand/product_line columns; the bid form writes brand into scope_summary JSON. */
export const WINNING_QUOTE_COLUMNS = 'scope_summary, decking_price_per_sheet, status';

// ── Gate type ──────────────────────────────────────────────────────────────────

export type ConfirmationGate =
  | 'ready'
  | 'missing-claim'
  | 'access-denied'
  | 'not-signed'
  | 'no-contractor';

// ── Return shape ───────────────────────────────────────────────────────────────

export interface ProjectConfirmationData {
  claim: ConfirmationClaimRow | null;
  contractor: ContractorPublicRow | null;
  quote: WinningQuoteRow | null;
  contractorId: string | null;
  homeownerName: string | null;
  depreciation: number | null;
  deckingRatePerSheet: number | null;
  existingConfirmation: Record<string, unknown> | null;
  gate: ConfirmationGate;
  loading: boolean;
  error: string | null;
}

const EMPTY: ProjectConfirmationData = {
  claim: null,
  contractor: null,
  quote: null,
  contractorId: null,
  homeownerName: null,
  depreciation: null,
  deckingRatePerSheet: null,
  existingConfirmation: null,
  gate: 'missing-claim',
  loading: true,
  error: null,
};

/**
 * Load claim + profile + contractor + winning quote for the project confirmation page.
 * Faithful port of static init 2156-2311. Fires once ready && userId present.
 * Null claimId → gate 'missing-claim' immediately.
 */
export function useProjectConfirmationData(
  userId: string | null,
  claimId: string | null,
  ready: boolean,
): ProjectConfirmationData {
  const [data, setData] = useState<ProjectConfirmationData>(EMPTY);

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
        // 1. Load claim (static 2158-2165)
        const { data: claimData, error: claimError } = await supabase
          .from('claims')
          .select(CLAIM_PUBLIC_COLUMNS)
          .eq('id', claimId)
          .single();

        if (claimError || !claimData) {
          throw new Error('Claim not found. Please return to your dashboard.');
        }
        const claim = claimData as ConfirmationClaimRow;

        // 2. Load profile for homeowner name (static 2168-2174)
        const { data: profile } = await supabase
          .from('profiles')
          .select('id, full_name')
          .eq('id', userId)
          .single();
        const homeownerName: string | null = (profile as { full_name?: string | null } | null)?.full_name ?? null;

        // 3. Ownership check (static 2176-2179)
        if (claim.user_id && userId && claim.user_id !== userId) {
          if (!active) return;
          setData({ ...EMPTY, loading: false, gate: 'access-denied' });
          return;
        }

        // 4. Status gate (static 2182-2185)
        if (!isStatusAllowed(claim.status)) {
          if (!active) return;
          setData({ ...EMPTY, loading: false, gate: 'not-signed' });
          return;
        }

        // 5. Contractor ID (static 2188-2191)
        const contractorId = claim.selected_contractor_id ?? null;
        if (!contractorId) {
          if (!active) return;
          setData({ ...EMPTY, loading: false, gate: 'no-contractor' });
          return;
        }

        // 6. Load contractor (static 2195-2201)
        const { data: contractorData, error: contractorError } = await supabase
          .rpc('get_contractors_public')
          .select('id, company_name, years_in_business')
          .eq('id', contractorId)
          .single();

        if (contractorError || !contractorData) {
          throw new Error('Contractor not found.');
        }
        const contractor = contractorData as ContractorPublicRow;

        // 7. Load winning quote (static 2205-2213) — maybeSingle: a missing row is fine, a failed query is not (gh-3138)
        const { data: quoteData, error: quoteError } = await supabase
          .from('quotes')
          .select(WINNING_QUOTE_COLUMNS)
          .eq('claim_id', claimId)
          .eq('contractor_id', contractorId)
          .maybeSingle();

        if (quoteError) {
          throw new Error('Unable to load your contractor’s quote. Please refresh and try again.');
        }

        const quoteRaw = quoteData as {
          scope_summary?: unknown;
          decking_price_per_sheet?: number | null;
          status?: string | null;
        } | null;
        const quote: WinningQuoteRow | null = quoteRaw
          ? {
              brand: brandFromScopeSummary(quoteRaw.scope_summary),
              product_line: null,
              decking_price_per_sheet: quoteRaw.decking_price_per_sheet ?? null,
              status: quoteRaw.status ?? null,
            }
          : null;
        // `|| null` (NOT `??`) — faithful to the static (project-confirmation.html:2213):
        // a falsy rate (0) collapses to null, so the ack/banner show the default text.
        const deckingRatePerSheet = quote?.decking_price_per_sheet || null;

        // 8. Depreciation (static 2216-2224)
        const depreciation = extractDepreciation(claim.parsed_line_items);

        // 9. Existing confirmation (static 2261)
        // gh-2881 / D-390: project_confirmation is not selectable on the claims row; the owner reads it through claim_private_text().
        const privateText = await fetchClaimPrivateText(supabase, claimId);
        const existingConfirmation = privateText?.project_confirmation ?? null;

        if (!active) return;
        setData({
          claim,
          contractor,
          quote,
          contractorId,
          homeownerName,
          depreciation,
          deckingRatePerSheet,
          existingConfirmation,
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
          error: err instanceof Error ? err.message : 'Unable to load project',
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
 * SAVE-FIRST step: write the project_confirmation JSONB to claims.
 * Throws on error so the page can handle it separately from the EF call.
 */
export async function saveProjectConfirmation(
  claimId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { data: upRows, error } = await supabase
    .from('claims')
    .update({ project_confirmation: payload })
    .eq('id', claimId)
    .select('id');

  if (error) {
    throw new Error('Failed to save project confirmation: ' + error.message);
  }
  if (!Array.isArray(upRows) || upRows.length === 0) {
    throw new Error('Failed to save project confirmation: update_zero_rows');
  }
}

/**
 * Create the project_confirmation DocuSign envelope and return its embedded signing URL.
 * Calls create-docusign-envelope EF UNCHANGED. No `signer` field (D-220).
 * Throws on EF error or missing signing_url.
 */
export async function createProjectConfirmationEnvelope({
  claimId,
  contractorId,
  origin,
}: {
  claimId: string;
  contractorId: string;
  origin: string;
}): Promise<{ signingUrl: string; envelopeId: string | null }> {
  const body = buildProjectConfirmationEnvelopeRequest({ claimId, contractorId, origin });

  const { data: result, error } = await supabase.functions.invoke('create-docusign-envelope', {
    body,
  });

  if (error) {
    throw new Error(error.message || 'Failed to create project confirmation envelope.');
  }
  if (!result?.signing_url) {
    throw new Error('No signing URL returned');
  }

  return {
    signingUrl: result.signing_url as string,
    envelopeId: (result.envelope_id as string | null | undefined) ?? null,
  };
}
