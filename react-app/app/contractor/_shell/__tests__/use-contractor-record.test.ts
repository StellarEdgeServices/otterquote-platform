/**
 * Regression tests for useContractorRecord / useContractorRecordGate (D-211 P18).
 *
 * The bug (ClickUp 86e1z9x8y): a contractor-role user with ZERO `contractors` rows
 * landed on /contractor/dashboard and hung forever on the spinner — useContractorRecord
 * used .single(), 0 rows → PostgREST 406 → every consumer's `!contractor` gate treated
 * it as "still loading" and never resolved.
 *
 * These tests lock in the two-part fix:
 *   1. useContractorRecord reads with .maybeSingle() → 0 rows is a clean
 *      `{ contractor: null, error: null, loading: false }` (no 406).
 *   2. useContractorRecordGate turns that settled-no-row signal into a redirect to
 *      /contractor/pre-approval (the Phase-6 row-creating gate), never an infinite spinner —
 *      while leaving a present row (onboarded contractor) and genuine fetch errors untouched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }));

import { supabase } from '@/lib/supabase';
import {
  useContractorRecord,
  useContractorRecordGate,
  CONTRACTOR_PRE_APPROVAL_ROUTE,
} from '../use-contractor-record';

/** Wire supabase.from('contractors').select().eq().maybeSingle() → the given result. */
function mockMaybeSingle(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  (supabase.from as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({ maybeSingle }),
    }),
  });
  return maybeSingle;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useContractorRecord — .maybeSingle() resilience', () => {
  it('returns a clean null (no error) when the contractor has zero rows', async () => {
    mockMaybeSingle({ data: null, error: null });
    const { result } = renderHook(() => useContractorRecord('user-norow'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.contractor).toBeNull();
    expect(result.current.error).toBeNull(); // 0 rows is NOT an error under .maybeSingle()
  });

  it('returns the row for an onboarded contractor', async () => {
    mockMaybeSingle({ data: { id: 'c1', user_id: 'user-onboarded' }, error: null });
    const { result } = renderHook(() => useContractorRecord('user-onboarded'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.contractor).toEqual({ id: 'c1', user_id: 'user-onboarded' });
  });

  it('stays idle (no fetch) when userId is null', () => {
    const maybeSingle = mockMaybeSingle({ data: null, error: null });
    const { result } = renderHook(() => useContractorRecord(null));

    expect(result.current.loading).toBe(false);
    expect(maybeSingle).not.toHaveBeenCalled();
  });
});

describe('useContractorRecordGate — no-row funnel to pre-approval', () => {
  it('redirects a contractor-role user with NO row to /contractor/pre-approval', async () => {
    mockMaybeSingle({ data: null, error: null });
    renderHook(() => useContractorRecordGate('user-norow'));

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(CONTRACTOR_PRE_APPROVAL_ROUTE),
    );
    expect(CONTRACTOR_PRE_APPROVAL_ROUTE).toBe('/contractor/pre-approval');
  });

  it('does NOT redirect an onboarded contractor (row present) — dashboard loads as today', async () => {
    mockMaybeSingle({ data: { id: 'c1', user_id: 'user-onboarded' }, error: null });
    const { result } = renderHook(() => useContractorRecordGate('user-onboarded'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.contractor).toEqual({ id: 'c1', user_id: 'user-onboarded' });
    expect(replace).not.toHaveBeenCalled();
  });

  it('does NOT redirect while the read is still loading (no premature bounce)', () => {
    mockMaybeSingle({ data: null, error: null }); // promise not yet resolved at first render
    const { result } = renderHook(() => useContractorRecordGate('user-norow'));

    expect(result.current.loading).toBe(true);
    expect(replace).not.toHaveBeenCalled();
  });

  it('does NOT redirect on a genuine fetch error (only on a confirmed-absent row)', async () => {
    mockMaybeSingle({ data: null, error: { message: 'network down' } });
    const { result } = renderHook(() => useContractorRecordGate('user-err'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).not.toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('stays idle when userId is null (auth not resolved yet)', () => {
    mockMaybeSingle({ data: null, error: null });
    renderHook(() => useContractorRecordGate(null));

    expect(replace).not.toHaveBeenCalled();
  });
});
