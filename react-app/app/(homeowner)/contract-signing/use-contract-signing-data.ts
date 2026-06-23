'use client';

/**
 * Homeowner contract-signing data layer (H3) — D-211 Phase 25, PR 2/2.
 *
 * ADR-009 useState/useEffect over the shared supabase singleton; RLS is the real
 * gate. Behaviour-faithful port of the reads + mutations contract-signing.html
 * (repo root) performed, with the IMPURE operations factored out of page.tsx so
 * they are unit-testable without rendering (mirrors the H9 repair-intake split):
 *
 *   • useContractSigningData — resolve claim + selected quote + contractor info
 *     (the get-contractor-info EF, same POST the static made) and derive the gate.
 *     ADDS a defensive ownership check (claim.user_id === user.id) the static
 *     lacked — a HARDENING, not a behavior port (brief item 3). RLS already blocks
 *     cross-owner reads; this fails closed in the UI too.
 *   • createHomeownerEnvelope — buildHomeownerEnvelopeRequest → create-docusign-
 *     envelope invoke. The ONLY delta from the static call is the return_url
 *     (utils.buildHomeownerReturnUrl → the React route). EF contract UNCHANGED.
 *   • recordHomeownerSigned — the quotes.homeowner_signed_at write + the static's
 *     .eq(claim_id,contractor_id) fallback (contract-signing.html:1645-1667).
 *   • sendContractorNudge / requestBidRenewal — the Step-3 send-sms nudge and the
 *     expired-bid send-support-email renewal, ported AS-IS. The hardcoded Dustin
 *     number and the message text are preserved byte-for-parity (brief item 8).
 *
 * CARRIED (EF-side, out of scope here — CTO to ticket): send-sms and
 * send-support-email have open relay/abuse findings (audit-digest §6.3) and
 * send-sms hardcodes a recipient. This PR ports the CALLS unchanged; it does NOT
 * touch those Edge Functions.
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  buildHomeownerEnvelopeRequest,
  resolveSelectedQuote,
  resolveSignGate,
  type SignGateState,
} from './utils';

// Dustin's alert line — preserved byte-for-parity from contract-signing.html:1762.
export const NUDGE_DUSTIN_PHONE = '+13175019215';

/** Claim row (superset of utils.SigningClaim — adds the fields the page renders). */
export interface SigningClaimRow {
  id: string;
  status?: string | null;
  selected_contractor_id?: string | null;
  contract_signed_at?: string | null;
  user_id?: string | null;
  homeowner_name?: string | null;
  property_address?: string | null;
}

/** Quote row (superset of utils.SignableQuote — adds the expiry + signing fields). */
export interface SigningQuoteRow {
  id: string;
  claim_id?: string | null;
  contractor_id?: string | null;
  status?: string | null;
  homeowner_signed_at?: string | null;
  total_price?: number | null;
  is_expired?: boolean | null;
  bid_status?: string | null;
  contractor_signed_at?: string | null;
  docusign_envelope_id?: string | null;
}

/** Shape returned by the get-contractor-info EF (only the fields the page uses). */
export interface ContractorInfo {
  id?: string | null;
  name?: string | null;
  company_name?: string | null;
  user_id?: string | null;
  phone?: string | null;
  notification_phones?: string[] | null;
}

export interface SigningParams {
  claimId: string | null;
  bid: string | null;
  quoteId: string | null;
  contractorId: string | null;
}

export interface SigningData {
  claim: SigningClaimRow | null;
  quote: SigningQuoteRow | null;
  contractor: ContractorInfo | null;
  contractorId: string | null;
  quoteId: string | null;
  gate: SignGateState;
  /** false → the loaded claim is not owned by this user (defensive; RLS is the real gate). */
  ownershipOk: boolean;
  /** true → the selected bid is expired (D-150 guard); render the renewal state. */
  bidExpired: boolean;
  loading: boolean;
  error: string | null;
}

const EMPTY: SigningData = {
  claim: null,
  quote: null,
  contractor: null,
  contractorId: null,
  quoteId: null,
  gate: 'no-contract',
  ownershipOk: true,
  bidExpired: false,
  loading: true,
  error: null,
};

/**
 * Load the claim, the selected/awarded quote, and the contractor (via the
 * get-contractor-info EF), then derive the gate. Faithful port of the static
 * init (contract-signing.html:1169-1255): ?bid resolves the quote first, else the
 * quote is read by ?quote_id or by claim_id + the claim's selected contractor.
 * Only fires once `ready` (params resolved client-side) and a user is present.
 */
export function useContractSigningData(
  userId: string | null,
  params: SigningParams | null,
  ready: boolean,
): SigningData {
  const [data, setData] = useState<SigningData>(EMPTY);

  const claimIdParam = params?.claimId ?? null;
  const bidParam = params?.bid ?? null;
  const quoteIdParam = params?.quoteId ?? null;
  const contractorIdParam = params?.contractorId ?? null;

  useEffect(() => {
    if (!ready) return;
    // Params resolved but no user yet → wait (the shell gate handles the redirect).
    if (!userId) return;

    let active = true;
    setData((d) => ({ ...d, loading: true, error: null }));

    (async () => {
      try {
        let claimId = claimIdParam;
        let contractorId = contractorIdParam;
        let quoteId = quoteIdParam;
        let quote: SigningQuoteRow | null = null;

        // ── ?bid=… → resolve the quote first, derive claim + contractor from it ──
        if (bidParam) {
          const { data: bidData, error: bidErr } = await supabase
            .from('quotes')
            .select('*')
            .eq('id', bidParam)
            .single();
          if (bidErr || !bidData) {
            throw new Error('Bid not found. Please go back and try again.');
          }
          quote = bidData as SigningQuoteRow;
          claimId = claimId ?? quote.claim_id ?? null;
          contractorId = contractorId ?? quote.contractor_id ?? null;
          quoteId = quoteId ?? quote.id;
        }

        if (!claimId) throw new Error('No project specified.');

        // ── Load the claim ──
        const { data: claimData, error: claimErr } = await supabase
          .from('claims')
          .select('*')
          .eq('id', claimId)
          .single();
        if (claimErr || !claimData) throw new Error('Claim not found.');
        const claim = claimData as SigningClaimRow;

        // ── Defensive ownership check (HARDENING; the static had none) ──
        // RLS already blocks cross-owner reads; this fails closed in the UI too.
        if (claim.user_id && userId && claim.user_id !== userId) {
          if (!active) return;
          setData({ ...EMPTY, claim, ownershipOk: false, loading: false });
          return;
        }

        // Contractor falls back to the claim's selected contractor (static parity).
        contractorId = contractorId ?? claim.selected_contractor_id ?? null;

        // ── Load the quote if ?bid didn't already supply it ──
        if (!quote) {
          if (quoteId) {
            const { data: q } = await supabase
              .from('quotes')
              .select('*')
              .eq('id', quoteId)
              .single();
            quote = (q as SigningQuoteRow) ?? null;
          } else if (contractorId) {
            const { data: q } = await supabase
              .from('quotes')
              .select('*')
              .eq('claim_id', claimId)
              .eq('contractor_id', contractorId)
              .order('created_at', { ascending: false })
              .limit(1)
              .single();
            quote = (q as SigningQuoteRow) ?? null;
          }
        }
        quoteId = quoteId ?? quote?.id ?? null;

        // The gate keys on the claim's selected contractor (utils.resolveSelectedQuote),
        // so a quote handed in via ?bid/?quote_id is matched the same way the static did.
        const selectedQuote = resolveSelectedQuote(
          quote ? [quote] : null,
          contractorId,
        ) ?? quote;

        // ── Load contractor info via the get-contractor-info EF (same POST) ──
        let contractor: ContractorInfo | null = null;
        if (contractorId) {
          const { data: info, error: infoErr } = await supabase.functions.invoke(
            'get-contractor-info',
            { body: { claim_id: claimId, contractor_id: contractorId } },
          );
          if (!infoErr && info) {
            contractor = info as ContractorInfo;
            // Normalize name (static contract-signing.html:1231-1234).
            if (!contractor.name && contractor.company_name) {
              contractor.name = contractor.company_name;
            }
          }
        }

        // ── Bid-expiry guard (D-150) — both flags, matching the static ──
        const bidExpired = !!(quote?.is_expired || quote?.bid_status === 'expired');

        const gate = resolveSignGate(
          { ...claim, selected_contractor_id: contractorId },
          selectedQuote,
        );

        if (!active) return;
        setData({
          claim,
          quote: selectedQuote,
          contractor,
          contractorId,
          quoteId,
          gate,
          ownershipOk: true,
          bidExpired,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (!active) return;
        setData({
          ...EMPTY,
          loading: false,
          error: err instanceof Error ? err.message : 'Unable to load contract',
        });
      }
    })();

    return () => {
      active = false;
    };
  }, [userId, claimIdParam, bidParam, quoteIdParam, contractorIdParam, ready]);

  return data;
}

/**
 * Create the homeowner_sign DocuSign envelope and return its embedded signing URL.
 * The request body is built by the (tested) pure utils.buildHomeownerEnvelopeRequest
 * — the only delta from the static call (contract-signing.html:1579-1590) is the
 * return_url, which targets the React route. The EF contract is UNCHANGED.
 * Throws on EF error or a missing signing_url (surfaced in the page error panel).
 */
export async function createHomeownerEnvelope(args: {
  claimId: string;
  contractorId: string;
  quoteId: string;
  signer: { email: string; name: string };
  origin: string;
}): Promise<{ signingUrl: string }> {
  const body = buildHomeownerEnvelopeRequest(args);
  const { data: result, error } = await supabase.functions.invoke(
    'create-docusign-envelope',
    { body },
  );
  if (error) throw new Error(error.message || 'Failed to create DocuSign envelope');
  if (!result?.signing_url) throw new Error('No signing URL returned from DocuSign');
  return { signingUrl: result.signing_url as string };
}

/**
 * Write quotes.homeowner_signed_at (IC 24-5-11 tracking). Mirrors the static
 * onSigningComplete update + its claim_id+contractor_id fallback
 * (contract-signing.html:1645-1667): prefer the quote id, else key on the claim +
 * contractor. Errors are logged, not thrown — the redirect proceeds regardless,
 * exactly as the static did (the webhook is the source of truth).
 */
export async function recordHomeownerSigned(args: {
  claimId: string;
  quoteId: string | null;
  contractorId: string | null;
  signedAt: string;
}): Promise<void> {
  try {
    if (args.quoteId) {
      const { error } = await supabase
        .from('quotes')
        .update({ homeowner_signed_at: args.signedAt })
        .eq('id', args.quoteId);
      if (error) console.error('Error updating homeowner_signed_at:', error);
    } else if (args.contractorId) {
      const { error } = await supabase
        .from('quotes')
        .update({ homeowner_signed_at: args.signedAt })
        .eq('claim_id', args.claimId)
        .eq('contractor_id', args.contractorId);
      if (error) console.error('Error updating homeowner_signed_at:', error);
    }
  } catch (err) {
    console.error('Error updating claim:', err);
  }
}

/**
 * The post-sign redirect target. Coexistence: the React /project-confirmation route
 * lands in Phase 26 — until then the signed homeowner returns to the STATIC
 * project-confirmation page (brief item 7).
 */
export function buildProjectConfirmationUrl(claimId: string): string {
  return `https://otterquote.com/project-confirmation.html?claim_id=${claimId}`;
}

/**
 * Step-3 "haven't heard from your contractor" nudge — SMS the contractor (every
 * collected number) and Dustin's alert line. Ported AS-IS from
 * contract-signing.html:1731-1778: the recipient set, the hardcoded Dustin number,
 * and the message text are preserved byte-for-parity. Resolves true iff every send
 * succeeded (the page reflects success/failure copy). The send-sms EF is UNCHANGED.
 */
export async function sendContractorNudge(args: {
  contractor: ContractorInfo | null;
  claim: SigningClaimRow | null;
  claimId: string | null;
}): Promise<boolean> {
  const c = args.contractor;
  const cl = args.claim;
  const contractorName = c?.company_name || c?.name || 'your contractor';
  const homeownerName = cl?.homeowner_name || 'your homeowner';
  const address = cl?.property_address || 'their property';
  const signedDate = cl?.contract_signed_at
    ? new Date(cl.contract_signed_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : 'recently';

  const phones: string[] = [];
  if (Array.isArray(c?.notification_phones) && c.notification_phones.length) {
    phones.push(...c.notification_phones.filter(Boolean));
  }
  if (c?.phone && !phones.includes(c.phone)) {
    phones.push(c.phone);
  }

  const contractorMsg = `Otter Quotes: Hi ${contractorName} — your homeowner ${homeownerName} (${address}) signed their contract on ${signedDate} and hasn't heard from you yet. Please reach out as soon as possible. Questions? Call (844) 875-3412.`;
  const dustinMsg = `Otter Quotes Alert: ${homeownerName} (claim ${args.claimId || 'unknown'}) says they haven't heard from ${contractorName} since signing on ${signedDate}. Heads up.`;

  const sends = phones.map((phone) =>
    supabase.functions.invoke('send-sms', { body: { to: phone, message: contractorMsg } }),
  );
  // Always notify Dustin (hardcoded number — byte-for-parity with the static).
  sends.push(
    supabase.functions.invoke('send-sms', {
      body: { to: NUDGE_DUSTIN_PHONE, message: dustinMsg },
    }),
  );

  try {
    await Promise.all(sends);
    return true;
  } catch (err) {
    console.error('Nudge error:', err);
    return false;
  }
}

/**
 * Expired-bid renewal (D-150) — notify the contractor (dashboard notification) and
 * email support. Faithful port of contract-signing.html:1783-1850: each step is
 * best-effort, the outcome is the OR of the two. The send-support-email EF is
 * UNCHANGED (ported as an invoke, the React-idiomatic equivalent of the static
 * fetch). Returns true iff at least one channel succeeded.
 */
export async function requestBidRenewal(args: {
  bidId: string;
  contractor: ContractorInfo | null;
  claim: SigningClaimRow | null;
  claimId: string | null;
}): Promise<boolean> {
  const { contractor, claim, claimId, bidId } = args;
  let notifOk = false;
  let emailOk = false;

  // 1. Dashboard notification for the contractor.
  try {
    if (contractor?.user_id) {
      const { error } = await supabase.from('notifications').insert({
        user_id: contractor.user_id,
        claim_id: claimId,
        notification_type: 'bid_renewal_requested',
        channel: 'dashboard',
        recipient: '',
        message_preview: `A homeowner is requesting an updated bid on ${
          claim?.property_address || 'their project'
        }.`,
      });
      if (!error) notifOk = true;
      else console.warn('requestBidRenewal — notification insert error:', error);
    }
  } catch (err) {
    console.warn('requestBidRenewal — notification step error:', err);
  }

  // 2. Support email so admin has visibility.
  try {
    const { error } = await supabase.functions.invoke('send-support-email', {
      body: {
        subject: 'Bid Renewal Requested — ' + (contractor?.company_name || 'Unknown Contractor'),
        body: [
          'A homeowner has requested an updated bid (via contract-signing expired guard).',
          'Contractor: ' + (contractor?.company_name || 'N/A'),
          'Property: ' + (claim?.property_address || 'N/A'),
          'Claim ID: ' + (claimId || 'N/A'),
          'Quote ID: ' + bidId,
          '',
          'The contractor has been notified via their dashboard' +
            (notifOk ? '.' : ' (notification may have failed — check manually).'),
        ].join('\n'),
      },
    });
    if (!error) emailOk = true;
  } catch (err) {
    console.warn('requestBidRenewal — email step error:', err);
  }

  return notifOk || emailOk;
}
