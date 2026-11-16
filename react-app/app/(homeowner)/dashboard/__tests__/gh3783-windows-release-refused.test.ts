/**
 * gh-3783 (D-375) — submitForBids never releases windows to contractors.
 * Negative control: on main these fail (windows_bid_released_at is stamped; a windows-only claim is updated).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  supabase: { from: vi.fn(), storage: { from: vi.fn() }, functions: { invoke: vi.fn() } },
}));

import { supabase } from '@/lib/supabase';
import { submitForBids } from '../actions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;
const updates: Record<string, unknown>[] = [];

function wire(trades: string[]) {
  updates.length = 0;
  sb.from.mockImplementation((table: string) => {
    if (table !== 'claims') return {};
    return {
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { trades }, error: null }) }) }),
      update: (u: Record<string, unknown>) => {
        updates.push(u);
        return { eq: () => ({ select: () => Promise.resolve({ data: [{ id: 'c1' }], error: null }) }) };
      },
    };
  });
  sb.functions.invoke.mockResolvedValue({ data: {}, error: null });
}

beforeEach(() => vi.clearAllMocks());

describe('gh-3783 submitForBids and windows', () => {
  it('refuses a windows-only claim with the existing "Coming Soon" text and writes nothing', async () => {
    wire(['windows']);
    const res = await submitForBids('c1');
    expect(res).toEqual({ ok: false, error: 'Coming Soon' });
    expect(updates).toHaveLength(0);
    expect(sb.functions.invoke).not.toHaveBeenCalled();
  });

  it('never stamps windows_bid_released_at on a roofing + windows claim, still releases roofing', async () => {
    wire(['roofing', 'windows']);
    const res = await submitForBids('c1');
    expect(res.ok).toBe(true);
    expect(updates[0]).not.toHaveProperty('windows_bid_released_at');
    expect(updates[0]).toHaveProperty('roofing_bid_released_at');
  });

  it('roofing-only claim still releases and notifies (positive control)', async () => {
    wire(['roofing']);
    const res = await submitForBids('c1');
    expect(res.ok).toBe(true);
    expect(updates[0]).toHaveProperty('roofing_bid_released_at');
    expect(sb.functions.invoke).toHaveBeenCalledWith('notify-contractors', { body: { claim_id: 'c1' } });
  });
});
