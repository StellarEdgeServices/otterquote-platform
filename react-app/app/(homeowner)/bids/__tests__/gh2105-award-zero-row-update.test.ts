/**
 * gh-2105 -- the #2103 pattern applied to `awardClaimToContractor`
 * (`bids/actions.ts`): the bid award flow must never report success when
 * nothing was actually awarded.
 *
 * History: the award used to be direct `.update()` calls on claims/quotes,
 * where a zero-row RLS/filter match resolves `{ error: null }` and had to be
 * detected with `.select('id')` row-count checks. gh-2914 (Refs #2819) moved
 * the award to ONE atomic `accept_bid` RPC (as bids.html does). The RPC raises
 * on every failure path (not owner, bid/claim not awardable, no payment
 * method, ...), so "nothing awarded" now always arrives as an `error` and the
 * old zero-row detection is replaced by this contract: an RPC error is
 * `{ ok: false }`, with no contract-signing redirect and no `bid_accepted`
 * funnel event. The write shape is also asserted: no direct claims/quotes
 * write is attempted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { makeSupabaseMock } = vi.hoisted(() => {
  function makeSupabaseMock(rpcResult: { data: unknown; error: null | { message: string } }) {
    return {
      rpc: vi.fn(async () => rpcResult),
      // Any direct table write is a regression: fail loudly.
      from: vi.fn((table: string) => {
        throw new Error(`unexpected direct write to table: ${table}`);
      }),
      auth: { getUser: vi.fn(async () => ({ data: { user: { email: 'jane@example.com' } } })) },
    };
  }
  return { makeSupabaseMock };
});

vi.mock('@/lib/track', () => ({ track: vi.fn() }));
vi.mock('@/lib/supabase', () => ({
  supabase: makeSupabaseMock({ data: [{ out_claim_id: 'claim-1' }], error: null }),
}));

import { supabase } from '@/lib/supabase';
import { track } from '@/lib/track';
import { awardClaimToContractor } from '../actions';
import type { BidRow, BidsClaim } from '../types';

const claim: BidsClaim = { id: 'claim-1', user_id: 'u1' };
const bid: BidRow = { id: 'bid-1', claim_id: 'claim-1', contractor_id: 'contractor-1', total_price: 4200 };

function setSupabase(rpcResult: Parameters<typeof makeSupabaseMock>[0]) {
  const next = makeSupabaseMock(rpcResult);
  (supabase.rpc as unknown) = next.rpc;
  (supabase.from as unknown) = next.from;
  (supabase.auth as unknown) = next.auth;
}

describe('awardClaimToContractor -- gh-2105 nothing-awarded detection via accept_bid (gh-2914)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSupabase({ data: [{ out_claim_id: 'claim-1' }], error: null });
  });

  it('POSITIVE CONTROL: a normal award succeeds and reaches the contract-signing handoff', async () => {
    const result = await awardClaimToContractor({ claim, bid });

    expect(result.ok).toBe(true);
    expect(result.href).toContain('contract-signing.html');
    expect(track).toHaveBeenCalledWith('bid_accepted', expect.any(Object));
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL: claim not awardable (RPC raises claim_not_awardable) is a failure, not a success', async () => {
    setSupabase({
      data: null,
      error: { message: 'claim_not_awardable: this claim is not open for bids, so a bid cannot be accepted on it' },
    });

    const result = await awardClaimToContractor({ claim, bid });

    expect(result.ok).toBe(false);
    expect(result.href).toBeUndefined();
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain('claim_not_awardable');
    expect(track).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL: bid not awardable (RPC raises bid_not_awardable) is a failure, not a success', async () => {
    setSupabase({
      data: null,
      error: {
        message: 'bid_not_awardable: this bid is expired, withdrawn or no longer active, so it cannot be accepted',
      },
    });

    const result = await awardClaimToContractor({ claim, bid });

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('bid_not_awardable');
    expect(track).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL: ownership refusal (42501) is a failure and never fires the funnel event', async () => {
    setSupabase({
      data: null,
      error: { message: 'accept_bid: quote bid-1 is not a bid on claim claim-1 owned by the caller' },
    });

    const result = await awardClaimToContractor({ claim, bid });

    expect(result.ok).toBe(false);
    expect(result.href).toBeUndefined();
    expect(track).not.toHaveBeenCalled();
  });

  it('a claim with only one bid (nothing to decline) still succeeds: accept_bid declines siblings internally', async () => {
    setSupabase({ data: [{ out_declined_count: 0 }], error: null });

    const result = await awardClaimToContractor({ claim, bid });

    expect(result.ok).toBe(true);
    expect(track).toHaveBeenCalledWith('bid_accepted', expect.any(Object));
  });
});
