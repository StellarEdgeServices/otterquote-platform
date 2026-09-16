/**
 * gh-1940 fix3 (CEO ruling, PR #1979 comment 5698022815, conditions 1-2) —
 * `awardClaimToContractor` (`bids/actions.ts`) is the ONE `bid_accepted`
 * call site in the React `(homeowner)/bids` page (confirmed unlinked from
 * the live dashboard — `dashboard.html` and `StatusBanner.tsx` both link
 * out to the static `bids.html`, which carries #1988's own, separate
 * `bid_accepted` emission; see that file for the negative control that a
 * real duplicate WOULD look like on the one surface that IS live).
 *
 * This test proves, for one award action on THIS page:
 *   1. `track('bid_accepted', ...)` fires exactly once (not twice on a
 *      retry-shaped call, and not once per write instead of once per action).
 *   2. The payload never carries `claim_id` (fix3) and matches #1988's
 *      param shape (`bid_id`/`contractor_id`/`bid_amount`/`source`/
 *      `test_account`) per the CEO ruling.
 *   NEGATIVE CONTROL: the exact pre-fix payload shape
 *   (`{ claim_id: claim.id }`, PR #1979's original call) is asserted absent
 *   — see the `claim_id` assertions below, which fail red against the
 *   pre-fix source (`git show pr1979-orig:.../actions.ts`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase', () => {
  const eqThenNeq = (result: { error: null | { message: string } }) => {
    const p = Promise.resolve(result);
    return Object.assign(p, { neq: () => Promise.resolve(result) });
  };
  return {
    supabase: {
      from: vi.fn((table: string) => ({
        update: vi.fn(() => ({
          eq: vi.fn(() => eqThenNeq({ error: null })),
        })),
      })),
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { email: 'jane@example.com' } } })),
      },
    },
  };
});

vi.mock('@/lib/track', () => ({ track: vi.fn() }));

import { supabase } from '@/lib/supabase';
import { track } from '@/lib/track';
import { awardClaimToContractor } from '../actions';
import type { BidRow, BidsClaim } from '../types';

describe('awardClaimToContractor — bid_accepted dedupe + claim_id strip (fix3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (supabase.auth.getUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { email: 'jane@example.com' } },
    });
  });

  const claim: BidsClaim = { id: 'claim-1', user_id: 'u1' };
  const bid: BidRow = { id: 'bid-1', claim_id: 'claim-1', contractor_id: 'contractor-1', total_price: 4200 };

  it('fires track("bid_accepted", ...) exactly once per award action', async () => {
    const result = await awardClaimToContractor({ claim, bid });

    expect(result.ok).toBe(true);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('bid_accepted', expect.any(Object));
  });

  it('the payload matches #1988\'s param shape and never carries claim_id (fix3, CEO ruling)', async () => {
    await awardClaimToContractor({ claim, bid });

    const payload = (track as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toEqual({
      bid_id: 'bid-1',
      contractor_id: 'contractor-1',
      bid_amount: 4200,
      source: 'bids_react',
      test_account: false,
    });
    // NEGATIVE CONTROL: this is exactly the key PR #1979 originally sent
    // (`{ claim_id: claim.id }`) — asserting it is gone is the assertion
    // that fails red against the pre-fix source.
    expect(payload).not.toHaveProperty('claim_id');
    expect(Object.values(payload)).not.toContain('claim-1');
  });

  it('test_account reflects an @otterquote-internal.test signed-in user', async () => {
    (supabase.auth.getUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { email: 'qa@otterquote-internal.test' } },
    });

    await awardClaimToContractor({ claim, bid });

    const payload = (track as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(payload.test_account).toBe(true);
  });

  it('does not fire bid_accepted at all when an earlier write fails (no partial/duplicate emission)', async () => {
    (supabase.from as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      update: () => ({
        eq: () => Promise.resolve({ error: { message: 'contractor_no_payment_method: x' } }),
      }),
    }));

    const result = await awardClaimToContractor({ claim, bid });

    expect(result.ok).toBe(false);
    expect(track).not.toHaveBeenCalled();
  });
});
