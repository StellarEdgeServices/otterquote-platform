/**
 * Contractor contract-signing pure helpers — D-211 Phase 17 Unit B.
 *
 * Extracted so the parity test exercises the gate logic without importing page.tsx
 * (which pulls in the Supabase client). All functions are pure; the page is the
 * only place that touches the network. The signable-status set + the
 * contractorNeedsToSign predicate are imported from the dashboard utils so the
 * "Sign Contract" CTA gate and this surface's gate share ONE source of truth.
 */

import {
  CONTRACTOR_SIGNABLE_STATUSES,
  contractorNeedsToSign,
} from '../../dashboard/utils';

export interface SignableQuote {
  id: string;
  claim_id?: string | null;
  contractor_id?: string | null;
  status?: string | null;
  contractor_signed_at?: string | null;
  total_price?: number | null;
}

/** ready = contractor still owes Step A · already-signed = signature on file · no-contract = nothing selected. */
export type SignGateState = 'ready' | 'already-signed' | 'no-contract';

/**
 * Resolve the claimId from the /contractor/sign/<id> path. Mirrors the bid route's
 * resolveClaimId-from-window.location pattern (avoids next/navigation useSearchParams,
 * which Next 15 requires under a Suspense boundary).
 */
export function resolveClaimIdFromPath(pathname: string): string | null {
  const m = pathname.match(/\/contractor\/sign\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * The contractor's selected/awarded quote for this claim — the contract awaiting
 * Step A (contractor) signature. Filters defensively by contractor_id AND the
 * shared signable-status set, so the resolver is correct even if handed a broader
 * quote list. Returns the first match (a contractor holds at most one live quote
 * per claim) or null when nothing is selected.
 */
export function resolveSelectedQuote(
  quotes: SignableQuote[] | null | undefined,
  contractorId: string,
): SignableQuote | null {
  if (!Array.isArray(quotes) || !contractorId) return null;
  const signable = CONTRACTOR_SIGNABLE_STATUSES as readonly string[];
  return (
    quotes.find(
      (q) => q && q.contractor_id === contractorId && signable.includes(q.status ?? ''),
    ) ?? null
  );
}

/**
 * Map the resolved quote to a gate state. A non-null quote from resolveSelectedQuote
 * is already known-signable, so the split is purely on contractor_signed_at:
 * unsigned → ready, signed → already-signed. No quote → no-contract.
 */
export function resolveSignGate(quote: SignableQuote | null): SignGateState {
  if (!quote) return 'no-contract';
  return contractorNeedsToSign(quote.status ?? null, quote.contractor_signed_at ?? null)
    ? 'ready'
    : 'already-signed';
}

/**
 * True only for a genuine completion return. DocuSign appends ?event=signing_complete
 * to the embedded return URL when (and only when) signing finishes; cancel/decline
 * carry a different event value, so keying on this avoids a false success on cancel.
 * Mirrors contract-signing.html's completion check.
 */
export function isSigningCompleteEvent(search: URLSearchParams): boolean {
  return search.get('event') === 'signing_complete';
}
