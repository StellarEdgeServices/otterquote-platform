/**
 * gh-2626 B4 (DECIDED by Ben, #2626 comment 6156405895) + gh-2914.
 *
 * B4 originally required the React award's "decline all other quotes" write to
 * be filtered to status = 'submitted', because the DB guard refuses a
 * client statement that touches a draft or expired sibling bid (42501).
 *
 * gh-2914 (Refs #2819) moved the whole award to the accept_bid RPC. The
 * decline-siblings step now runs server side inside that SECURITY DEFINER
 * function, so the client must make NO direct quotes write at all -- there is
 * no client-side filter left to get wrong. This test is the guard for that:
 * the award issues exactly one RPC, and never touches claims or quotes
 * directly (a direct decline would be refused for a homeowner after #2819).
 *
 * Negative control: re-add any `.from('quotes').update(...)` or
 * `.from('claims').update(...)` to awardClaimToContractor and the
 * "makes no direct claims/quotes write" test below fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { makeSupabase } = vi.hoisted(() => {
  function makeSupabase() {
    return {
      rpc: vi.fn(async () => ({ data: [{ out_declined_count: 2 }], error: null })),
      from: vi.fn(() => ({
        update: vi.fn(),
        insert: vi.fn(),
        delete: vi.fn(),
      })),
      auth: { getUser: vi.fn(async () => ({ data: { user: { email: 'jane@example.com' } } })) },
    };
  }
  return { makeSupabase };
});

vi.mock('@/lib/track', () => ({ track: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: makeSupabase() }));

import { supabase } from '@/lib/supabase';
import { awardClaimToContractor } from '../actions';
import type { BidRow, BidsClaim } from '../types';

const claim: BidsClaim = { id: 'claim-1', user_id: 'u1' };
const bid: BidRow = { id: 'bid-1', claim_id: 'claim-1', contractor_id: 'contractor-1', total_price: 4200 };

describe('awardClaimToContractor -- gh-2626 B4 / gh-2914 decline-others is server side', () => {
  beforeEach(() => {
    const next = makeSupabase();
    (supabase.rpc as unknown) = next.rpc;
    (supabase.from as unknown) = next.from;
    (supabase.auth as unknown) = next.auth;
  });

  it("makes no direct claims/quotes write; declining the other bids is accept_bid's job", async () => {
    const result = await awardClaimToContractor({ claim, bid });

    expect(result.ok).toBe(true);
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    const tables = (supabase.from as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(tables).not.toContain('quotes');
    expect(tables).not.toContain('claims');
  });

  it('the single RPC carries the claim and the winning quote (siblings are resolved server side)', async () => {
    await awardClaimToContractor({ claim, bid });

    expect(supabase.rpc).toHaveBeenCalledWith('accept_bid', { p_claim_id: 'claim-1', p_quote_id: 'bid-1' });
  });
});
