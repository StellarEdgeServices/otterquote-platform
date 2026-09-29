/**
 * gh-2105 batch 4 — dashboard actions zero-row-update detection.
 *
 * `.from(t).update({...}).eq(...)` with no `.select(` resolves
 * `{ error: null }` even when RLS or the `.eq()` filter matches ZERO rows
 * (the #2103 gap). `submitForBids`, `uploadClaimDocument`, and
 * `joinExpansionWaitlist` all had this shape on `claims.update(...)`. Each
 * now chains `.select('id')` and fails closed (`{ ok: false }`) on a
 * zero-row match instead of reporting success. Mandatory negative control
 * (mirrors the #2103/gh-2105-batch-1 pattern): each test below proves the
 * zero-row case now returns `ok: false`, which the pre-fix code could not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    storage: { from: vi.fn() },
    functions: { invoke: vi.fn() },
  },
}));

import { supabase } from '@/lib/supabase';
import { submitForBids, uploadClaimDocument, joinExpansionWaitlist } from '../actions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('submitForBids — gh-2105 zero-row detection', () => {
  function wireClaims(updateRows: Array<{ id: string }> | null) {
    sb.from.mockImplementation((table: string) => {
      if (table !== 'claims') return {};
      return {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: {}, error: null }) }),
        }),
        update: () => ({
          eq: () => ({ select: () => Promise.resolve({ data: updateRows, error: null }) }),
        }),
      };
    });
  }

  it('returns ok:true on a row-written match', async () => {
    wireClaims([{ id: 'claim-1' }]);
    sb.functions.invoke.mockResolvedValue({ data: {}, error: null });
    const res = await submitForBids('claim-1');
    expect(res.ok).toBe(true);
  });

  it('gh-2105 negative control: returns ok:false (not true) on a zero-row match', async () => {
    wireClaims([]);
    const res = await submitForBids('claim-1');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/zero_rows/);
  });
});

describe('uploadClaimDocument — gh-2105 zero-row detection', () => {
  function wireClaims(updateRows: Array<{ id: string }> | null) {
    sb.storage.from.mockReturnValue({ upload: () => Promise.resolve({ data: {}, error: null }) });
    sb.from.mockImplementation((table: string) => {
      if (table !== 'claims') return {};
      return {
        update: () => ({
          eq: () => ({ select: () => Promise.resolve({ data: updateRows, error: null }) }),
        }),
      };
    });
  }

  it('returns ok:true and the storage path on a row-written match', async () => {
    wireClaims([{ id: 'claim-1' }]);
    const res = await uploadClaimDocument({
      userId: 'u1',
      claimId: 'claim-1',
      file: new File(['x'], 'measurements.pdf', { type: 'application/pdf' }),
      timestamp: 1,
      kind: 'measurements',
    });
    expect(res.ok).toBe(true);
    expect(res.storagePath).toBe('u1/claim-1/1-measurements.pdf');
  });

  it('gh-2105 negative control: returns ok:false (not true) on a zero-row match', async () => {
    wireClaims([]);
    const res = await uploadClaimDocument({
      userId: 'u1',
      claimId: 'claim-1',
      file: new File(['x'], 'measurements.pdf', { type: 'application/pdf' }),
      timestamp: 1,
      kind: 'measurements',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/zero_rows/);
  });
});

describe('joinExpansionWaitlist — gh-2105 zero-row detection', () => {
  const ARGS = {
    userId: 'u1',
    claimId: 'claim-1',
    state: 'CA',
    optedIn: true,
    optedInAt: '2026-09-27T00:00:00.000Z',
  };

  function wire(updateRows: Array<{ id: string }> | null) {
    sb.from.mockImplementation((table: string) => {
      if (table === 'expansion_waitlist') {
        return { upsert: () => Promise.resolve({ error: null }) };
      }
      if (table === 'claims') {
        return {
          update: () => ({
            eq: () => ({ select: () => Promise.resolve({ data: updateRows, error: null }) }),
          }),
        };
      }
      return {};
    });
  }

  it('returns ok:true on a row-written match', async () => {
    wire([{ id: 'claim-1' }]);
    const res = await joinExpansionWaitlist(ARGS);
    expect(res.ok).toBe(true);
  });

  it('gh-2105 negative control: returns ok:false (not true) on a zero-row match — this write was previously unchecked entirely (no error or row check)', async () => {
    wire([]);
    const res = await joinExpansionWaitlist(ARGS);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/zero_rows/);
  });
});
