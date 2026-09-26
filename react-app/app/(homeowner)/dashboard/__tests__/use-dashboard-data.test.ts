import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Mock ONLY the supabase singleton — the data layer under test is the real thing.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getUser: vi.fn() },
    from: vi.fn(),
  },
}));

import { supabase } from '@/lib/supabase';
import { useLatestClaim } from '../use-dashboard-data';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

interface SetupOpts {
  existingClaimId?: string | null;
  fetchError?: { message: string; code?: string } | null;
}

function setup(opts: SetupOpts = {}) {
  const { existingClaimId = null, fetchError = null } = opts;
  const rec: { inserts: unknown[] } = { inserts: [] };

  sb.from.mockImplementation((table: string) => {
    if (table === 'claims') {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: existingClaimId ? { id: existingClaimId } : null,
                    error: fetchError,
                  }),
              }),
            }),
          }),
        }),
        // gh-2004 negative control: if this hook ever calls .insert() on
        // 'claims' again, it is re-introducing the addressless auto-create.
        insert: (payload: unknown) => {
          rec.inserts.push(payload);
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id: 'should-not-exist' }, error: null }),
            }),
          };
        },
      };
    }
    return {};
  });

  return { rec };
}

describe('useLatestClaim (gh-2004)', () => {
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: '' },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it('an existing claim resolves normally — no insert, no redirect', async () => {
    const { rec } = setup({ existingClaimId: 'c-1' });
    const { result } = renderHook(() => useLatestClaim('u1'));

    await waitFor(() => expect(result.current.claimId).toBe('c-1'));
    expect(result.current.loading).toBe(false);
    expect(rec.inserts).toHaveLength(0);
    expect(window.location.href).toBe('');
  });

  // This is the negative control: the pre-fix behavior. Reproduces the exact
  // gh-2004 defect shape — a claims insert with no address columns at all —
  // so this test documents what NO LONGER happens.
  it('gh-2004: no existing claim → redirects to trade-selector and NEVER inserts a claim', async () => {
    const { rec } = setup({ existingClaimId: null });
    renderHook(() => useLatestClaim('u1'));

    await waitFor(() => expect(window.location.href).toBe('/trade-selector'));
    expect(rec.inserts).toHaveLength(0);
  });

  it('no userId → not loading, no query, no redirect', () => {
    setup();
    const { result } = renderHook(() => useLatestClaim(null));
    expect(result.current.loading).toBe(false);
    expect(result.current.claimId).toBeNull();
    expect(window.location.href).toBe('');
    expect(sb.from).not.toHaveBeenCalled();
  });

  it('a fetch error (not "no rows") surfaces as error state, no redirect', async () => {
    setup({ fetchError: { message: 'rls denied', code: 'XX000' } });
    const { result } = renderHook(() => useLatestClaim('u1'));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('rls denied');
    expect(window.location.href).toBe('');
  });
});
