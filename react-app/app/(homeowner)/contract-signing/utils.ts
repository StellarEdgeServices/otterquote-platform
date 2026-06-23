/**
 * Homeowner contract-signing pure helpers — D-211 Phase 25 (H3), PR 1/2.
 *
 * Mirrors the Phase-17 contractor utils.ts (react-app/app/contractor/sign/
 * [claimId]/utils.ts): every function is pure and network-free — the eventual page
 * (PR2) is the only place that touches Supabase. Differences from the contractor
 * surface are intrinsic to the homeowner flow, NOT new behavior:
 *
 *   • The homeowner route carries the claim id in the QUERY STRING
 *     (/contract-signing?claim_id=…&signed=true — see buildHomeownerReturnUrl), not as
 *     a [claimId] path segment, so the id resolver reads search params (with a path
 *     segment accepted as a fallback). This diverges deliberately from the contractor
 *     resolveClaimIdFromPath, which is path-only.
 *   • The signing gate keys on the CLAIM (selected_contractor_id + contract_signed_at
 *     / status 'contract_signed'), mirroring bids/utils.ts deriveBidAction
 *     (bids.html:1184-1199), because the homeowner signs SECOND under the IC 24-5-11
 *     sequence (the contractor signs first).
 */

// Claim statuses for the homeowner signing gate. Parity source: bids/utils.ts
// deriveBidAction (bids.html:1184-1199): 'awarded' = a contractor is selected and a
// contract exists; 'contract_signed' = the homeowner has signed.
export const HOMEOWNER_SIGNED_CLAIM_STATUS = 'contract_signed' as const;

export interface SigningClaim {
  id: string;
  status?: string | null;
  selected_contractor_id?: string | null;
  contract_signed_at?: string | null;
}

export interface SignableQuote {
  id: string;
  claim_id?: string | null;
  contractor_id?: string | null;
  status?: string | null;
  homeowner_signed_at?: string | null;
  total_price?: number | null;
}

/** ready = homeowner still owes their signature · already-signed = on file · no-contract = nothing selected. */
export type SignGateState = 'ready' | 'already-signed' | 'no-contract';

export interface HomeownerEnvelopeRequest {
  claim_id: string;
  document_type: 'homeowner_sign';
  contractor_id: string;
  quote_id: string;
  signer: { email: string; name: string };
  return_url: string;
}

/**
 * Resolve the claim id for the homeowner signing route. The canonical source is the
 * `claim_id` query param — the route the create-docusign-envelope return_url targets
 * (/contract-signing?claim_id=…). A /contract-signing/<id> path segment is accepted as
 * a fallback. Returns null when neither is present.
 */
export function resolveClaimId(search: URLSearchParams, pathname?: string): string | null {
  const fromQuery = search.get('claim_id');
  if (fromQuery) return fromQuery;
  if (pathname) {
    const m = pathname.match(/\/contract-signing\/([^/?#]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

/**
 * The quote awaiting the homeowner's signature: the SELECTED contractor's quote for
 * this claim. Filters by the claim's selected_contractor_id so the resolver is correct
 * even if handed every quote on the claim. Returns the first match or null.
 */
export function resolveSelectedQuote(
  quotes: SignableQuote[] | null | undefined,
  selectedContractorId: string | null | undefined,
): SignableQuote | null {
  if (!Array.isArray(quotes) || !selectedContractorId) return null;
  return quotes.find((q) => q && q.contractor_id === selectedContractorId) ?? null;
}

/**
 * Map the claim + resolved quote to a gate state:
 *   no-contract     → no selected contractor, or no quote for them
 *   already-signed  → claim.contract_signed_at set, claim.status 'contract_signed',
 *                     or the quote's homeowner_signed_at set
 *   ready           → a contract exists and the homeowner has not yet signed
 */
export function resolveSignGate(
  claim: SigningClaim | null | undefined,
  quote: SignableQuote | null | undefined,
): SignGateState {
  if (!claim || !claim.selected_contractor_id || !quote) return 'no-contract';
  const signed =
    !!claim.contract_signed_at ||
    claim.status === HOMEOWNER_SIGNED_CLAIM_STATUS ||
    !!quote.homeowner_signed_at;
  return signed ? 'already-signed' : 'ready';
}

/**
 * The embedded-return URL for the homeowner signing iframe. Points at the React route
 * so its in-iframe bridge (DocuSignEmbed.runSigningReturnBridge) posts completion to
 * the parent — NOT the dead static contract-signing.html. Shape per the H3 brief:
 * `${origin}/contract-signing?claim_id=…&signed=true`.
 */
export function buildHomeownerReturnUrl(origin: string, claimId: string): string {
  return `${origin}/contract-signing?claim_id=${encodeURIComponent(claimId)}&signed=true`;
}

/**
 * Pure builder for the create-docusign-envelope request body (document_type
 * 'homeowner_sign'). Mirrors contract-signing.html:1579-1590 (signer derived
 * client-side) and ADDS return_url — the static page omitted it; the React route needs
 * it so the embedded return renders the React bridge. PR2 calls this; here it is pure
 * + tested. The Edge Function contract is UNCHANGED.
 */
export function buildHomeownerEnvelopeRequest(args: {
  claimId: string;
  contractorId: string;
  quoteId: string;
  signer: { email: string; name: string };
  origin: string;
}): HomeownerEnvelopeRequest {
  return {
    claim_id: args.claimId,
    document_type: 'homeowner_sign',
    contractor_id: args.contractorId,
    quote_id: args.quoteId,
    signer: { email: args.signer.email, name: args.signer.name },
    return_url: buildHomeownerReturnUrl(args.origin, args.claimId),
  };
}
