/**
 * gh-2914 (Refs #2819) -- `awardClaimToContractor` awards through the
 * `accept_bid` SECURITY DEFINER RPC exactly as bids.html does
 * (`.rpc('accept_bid', { p_claim_id, p_quote_id })`), instead of direct
 * claims/quotes writes that a homeowner session can no longer perform after
 * the #2819 migration.
 *
 * Proves: (1) the RPC is called once with the exact argument names/values;
 * (2) the bid_accepted event fires only AFTER the RPC succeeded, and never on
 * failure; (3) the payment-method guard (P0001 contractor_no_payment_method)
 * is mapped to homeowner wording, never the internal identifier.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const order: string[] = [];

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(async () => {
      order.push('rpc');
      return { data: [{ out_claim_id: 'claim-1' }], error: null };
    }),
    from: vi.fn(),
    auth: { getUser: vi.fn(async () => ({ data: { user: { email: 'jane@example.com' } } })) },
  },
}));
vi.mock('@/lib/track', () => ({
  track: vi.fn(() => {
    order.push('track');
  }),
}));

import { supabase } from '@/lib/supabase';
import { track } from '@/lib/track';
import { awardClaimToContractor } from '../actions';
import { NO_PAYMENT_METHOD_MESSAGE } from '../utils';
import type { BidRow, BidsClaim } from '../types';

const claim: BidsClaim = { id: 'claim-1', user_id: 'u1' };
const bid: BidRow = { id: 'bid-1', claim_id: 'claim-1', contractor_id: 'contractor-1', total_price: 4200 };

describe('awardClaimToContractor -- accept_bid RPC (gh-2914)', () => {
  beforeEach(() => {
    order.length = 0;
    vi.clearAllMocks();
  });

  it('calls supabase.rpc("accept_bid", { p_claim_id, p_quote_id }) exactly once with the claim and bid ids', async () => {
    const result = await awardClaimToContractor({ claim, bid });

    expect(result.ok).toBe(true);
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('accept_bid', { p_claim_id: 'claim-1', p_quote_id: 'bid-1' });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(result.href).toContain('claim_id=claim-1');
    expect(result.href).toContain('quote_id=bid-1');
    expect(result.href).toContain('contractor_id=contractor-1');
  });

  it('fires bid_accepted only after the RPC has succeeded', async () => {
    await awardClaimToContractor({ claim, bid });

    expect(order).toEqual(['rpc', 'track']);
    expect(track).toHaveBeenCalledTimes(1);
  });

  it('does not fire bid_accepted and returns ok:false when the RPC errors', async () => {
    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: null,
      error: { message: 'bid_not_awardable: expired' },
    });

    const result = await awardClaimToContractor({ claim, bid });

    expect(result.ok).toBe(false);
    expect(result.href).toBeUndefined();
    expect(track).not.toHaveBeenCalled();
  });

  it('maps the P0001 payment-method guard to homeowner wording (never the internal identifier)', async () => {
    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: null,
      error: {
        code: 'P0001',
        message:
          'contractor_no_payment_method: the selected contractor has not added a payment method, so this bid cannot be accepted yet',
      },
    });

    const result = await awardClaimToContractor({ claim, bid });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(NO_PAYMENT_METHOD_MESSAGE);
    expect(result.error).not.toContain('contractor_no_payment_method');
    expect(track).not.toHaveBeenCalled();
  });
});
