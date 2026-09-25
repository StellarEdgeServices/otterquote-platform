/**
 * gh-2105 -- the #2103 pattern applied to `awardClaimToContractor`
 * (`bids/actions.ts`): the bid award/decline flow.
 *
 * In supabase-js, `.from(t).update({...}).eq(...)` WITHOUT `.select()`
 * resolves `{ error: null }` even when RLS or the `.eq()` filter matches
 * ZERO rows. A homeowner "accepting" a bid could get a success screen (and
 * a redirect to contract-signing) while `claims.status` never actually
 * changed to 'awarded' and `quotes.status` never actually changed to
 * 'selected' -- the highest-value write in this file.
 *
 * This is the mandatory negative control (issue gh-2105's closes-on): one
 * bid-award update driven against an RLS-denied / zero-match row. Before
 * the fix this resolved `error: null` with zero rows changed and was
 * reported as success (see "PRE-FIX BEHAVIOR" comment on each test below,
 * matching the .eq(...) call with no `.select()` chained). After the fix,
 * the caller sees `{ ok: false }` and never proceeds to the contract-signing
 * redirect or the `bid_accepted` funnel event.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ZERO_ROWS, ONE_ROW, makeSupabaseMock } = vi.hoisted(() => {
  const ZERO_ROWS = { data: [] as Array<{ id: string }>, error: null as { message: string } | null };
  const ONE_ROW = { data: [{ id: 'row-1' }] as Array<{ id: string }>, error: null as { message: string } | null };

  function makeSupabaseMock(responses: {
    claimUpdate?: typeof ONE_ROW;
    winUpdate?: typeof ONE_ROW;
    rejectUpdate?: typeof ONE_ROW;
  }) {
    const claimUpdate = responses.claimUpdate ?? ONE_ROW;
    const winUpdate = responses.winUpdate ?? ONE_ROW;
    const rejectUpdate = responses.rejectUpdate ?? ONE_ROW;

    const from = vi.fn((table: string) => {
      if (table === 'claims') {
        return {
          update: () => ({
            eq: () => ({
              select: () => Promise.resolve(claimUpdate),
            }),
          }),
        };
      }
      if (table === 'quotes') {
        // gh-2105 REVIEW FAIL nit (d): this used to track call ORDER via a
        // counter (`quotesUpdateCalls`), with a comment claiming the first
        // `.update()` call was the winning-bid write and the second was the
        // reject-others write. That counter never actually counted across
        // calls -- it was declared inside this `if (table === 'quotes')`
        // block, which real code re-enters (a fresh `supabase.from('quotes')`
        // call) for EACH of the two writes, so it always reset to 0 and
        // incremented to 1: `isWin` was always true. The mock worked anyway,
        // but for a different reason than the comment claimed: the two real
        // call SHAPES are structurally distinct --
        //   winning-bid write:   .update(...).eq('id', bid.id).select('id')
        //   reject-others write: .update(...).eq('claim_id', ...).neq('id', ...).select('id')
        // -- so `.eq().select()` and `.eq().neq().select()` are disambiguated
        // by their own shape, not by which call happened first. Returning
        // the fixed responses directly, keyed by that shape.
        return {
          update: () => ({
            eq: () => ({
              select: () => Promise.resolve(winUpdate),
              neq: () => ({
                select: () => Promise.resolve(rejectUpdate),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    });

    return {
      from,
      auth: { getUser: vi.fn(async () => ({ data: { user: { email: 'jane@example.com' } } })) },
    };
  }

  return { ZERO_ROWS, ONE_ROW, makeSupabaseMock };
});

vi.mock('@/lib/track', () => ({ track: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: makeSupabaseMock({}) }));

import { supabase } from '@/lib/supabase';
import { track } from '@/lib/track';
import { awardClaimToContractor } from '../actions';
import type { BidRow, BidsClaim } from '../types';

const claim: BidsClaim = { id: 'claim-1', user_id: 'u1' };
const bid: BidRow = { id: 'bid-1', claim_id: 'claim-1', contractor_id: 'contractor-1', total_price: 4200 };

function setSupabase(responses: Parameters<typeof makeSupabaseMock>[0]) {
  const next = makeSupabaseMock(responses);
  (supabase.from as unknown) = next.from;
  (supabase.auth as unknown) = next.auth;
}

describe('awardClaimToContractor -- gh-2105 zero-row silent-write detection (#2103 pattern)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSupabase({});
  });

  it('POSITIVE CONTROL: a normal award (one row each) succeeds and reaches the contract-signing handoff', async () => {
    const result = await awardClaimToContractor({ claim, bid });

    expect(result.ok).toBe(true);
    expect(result.href).toContain('contract-signing.html');
    expect(track).toHaveBeenCalledWith('bid_accepted', expect.any(Object));
  });

  it('gh-2105 FIX (mandatory negative control): a claims.update() that matches ZERO rows (RLS-filtered, error: null) is reported as failure, not success', async () => {
    // PRE-FIX BEHAVIOR: `.update({...}).eq('id', claim.id)` with no
    // `.select()` resolves `{ error: null }` on this exact same zero-row
    // match -- `claimErr` is falsy, the function falls through, and the
    // homeowner is redirected to contract-signing with `result.ok === true`
    // even though claims.status was never written. This test fails red
    // against that code path (asserting `result.ok === true` there) and
    // green against the fix, which checks `claimRows.length > 0`.
    setSupabase({ claimUpdate: ZERO_ROWS });

    const result = await awardClaimToContractor({ claim, bid });

    expect(result.ok).toBe(false);
    expect(result.href).toBeUndefined();
    // The award must not be reported as complete anywhere downstream.
    expect(track).not.toHaveBeenCalled();
  });

  it('gh-2105 FIX: a quotes.update() (winning bid) that matches ZERO rows is reported as failure, not success', async () => {
    setSupabase({ winUpdate: ZERO_ROWS });

    const result = await awardClaimToContractor({ claim, bid });

    expect(result.ok).toBe(false);
    expect(track).not.toHaveBeenCalled();
  });

  it('decision (b), NOT an error: the reject-other-bids update matching ZERO rows (a claim with only one bid) still succeeds', async () => {
    // A claim can legitimately have exactly one bid -- the winner -- so
    // there is nothing to decline. Unlike the award/win writes above, zero
    // rows here is an expected, non-error outcome (issue gh-2105 decision b).
    setSupabase({ rejectUpdate: ZERO_ROWS });

    const result = await awardClaimToContractor({ claim, bid });

    expect(result.ok).toBe(true);
    expect(track).toHaveBeenCalledWith('bid_accepted', expect.any(Object));
  });
});
