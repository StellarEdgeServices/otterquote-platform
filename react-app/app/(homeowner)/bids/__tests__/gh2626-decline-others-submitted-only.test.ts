/**
 * gh-2626 B4 (DECIDED by Ben, #2626 comment 6156405895): the React award's
 * "decline all other quotes" write must be filtered to status = 'submitted'.
 * The DB guard (claims_guard_award_columns / quotes owner-decline rule) refuses
 * the whole statement when it touches a draft or expired sibling bid, so an
 * unfiltered write would fail the award whenever a sibling is not submitted.
 *
 * Negative control: remove `.eq('status', 'submitted')` from actions.ts and the
 * "filters the decline-others write" test below fails (no status filter recorded).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { calls, makeSupabase } = vi.hoisted(() => {
  const calls: Array<{ table: string; patch: unknown; filters: Array<[string, string, unknown]> }> = [];
  function makeSupabase() {
    const from = vi.fn((table: string) => ({
      update: (patch: unknown) => {
        const rec = { table, patch, filters: [] as Array<[string, string, unknown]> };
        calls.push(rec);
        const chain: Record<string, unknown> = {};
        chain.eq = (c: string, v: unknown) => { rec.filters.push(['eq', c, v]); return chain; };
        chain.neq = (c: string, v: unknown) => { rec.filters.push(['neq', c, v]); return chain; };
        chain.select = () => Promise.resolve({ data: [{ id: 'row-1' }], error: null });
        return chain;
      },
    }));
    return { from, auth: { getUser: vi.fn(async () => ({ data: { user: { email: 'jane@example.com' } } })) } };
  }
  return { calls, makeSupabase };
});

vi.mock('@/lib/track', () => ({ track: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: makeSupabase() }));

import { supabase } from '@/lib/supabase';
import { awardClaimToContractor } from '../actions';
import type { BidRow, BidsClaim } from '../types';

const claim: BidsClaim = { id: 'claim-1', user_id: 'u1' };
const bid: BidRow = { id: 'bid-1', claim_id: 'claim-1', contractor_id: 'contractor-1', total_price: 4200 };

describe('awardClaimToContractor -- gh-2626 B4 decline-others filter', () => {
  beforeEach(() => {
    calls.length = 0;
    const next = makeSupabase();
    (supabase.from as unknown) = next.from;
    (supabase.auth as unknown) = next.auth;
  });

  it('filters the decline-others write to status = submitted (and still excludes the winner)', async () => {
    const result = await awardClaimToContractor({ claim, bid });
    expect(result.ok).toBe(true);
    const decline = calls.find((c) => c.table === 'quotes' && (c.patch as { status?: string }).status === 'declined');
    expect(decline).toBeDefined();
    expect(decline!.filters).toContainEqual(['eq', 'claim_id', 'claim-1']);
    expect(decline!.filters).toContainEqual(['neq', 'id', 'bid-1']);
    expect(decline!.filters).toContainEqual(['eq', 'status', 'submitted']);
  });
});
