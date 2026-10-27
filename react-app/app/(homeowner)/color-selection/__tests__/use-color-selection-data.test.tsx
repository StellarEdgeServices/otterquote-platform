/**
 * gh-2105 (colour-signature repair, checklist A, B, C, F) -- the data layer against a
 * fake supabase client. The page test (color-selection-page.test.tsx) mocks this hook, so
 * nothing else exercised the column names or the contractor lookup, which is how the
 * hook shipped selecting claims.homeowner_id and contractors.name, neither of which exists.
 *
 * Each assertion is on what the hook SENDS (select string, filter columns, rpc name) and on
 * what it does with the answer, so a reintroduced wrong column name fails here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  claimSelect: '' as string,
  filters: [] as Array<[string, unknown]>,
  claimRow: null as Record<string, unknown> | null,
  rpc: vi.fn(),
  updateResult: { data: [{ id: 'c1' }] as unknown, error: null as { message: string } | null },
  updatePatch: null as unknown,
}));

vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = (cols: string) => {
      if (table === 'claims') h.claimSelect = cols;
      return chain;
    };
    chain.update = (patch: unknown) => {
      h.updatePatch = patch;
      return chain;
    };
    chain.eq = (col: string, val: unknown) => {
      h.filters.push([col, val]);
      return chain;
    };
    chain.single = () =>
      Promise.resolve(
        table === 'profiles'
          ? { data: { full_name: 'Jane Doe', email: 'jane@example.com' }, error: null }
          : { data: h.claimRow, error: h.claimRow ? null : { message: 'nf' } },
      );
    // `update(...).eq(...).eq(...).select('id')` is awaited directly.
    chain.then = (resolve: (v: unknown) => void) => resolve(h.updateResult);
    return chain;
  };
  return { supabase: { from, rpc: h.rpc, functions: { invoke: vi.fn() } } };
});

import { useColorSelectionData, saveColorSelection } from '../use-color-selection-data';

const CLAIM = {
  id: 'c1',
  user_id: 'u1',
  selected_contractor_id: 'ctr1',
  property_address: '123 Oak St, Zionsville 46077',
  color_brand: null,
  color_name: null,
  color_selected_at: null,
};

beforeEach(() => {
  h.claimSelect = '';
  h.filters = [];
  h.claimRow = { ...CLAIM };
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ data: [{ company_name: 'Acme Roofing', preferred_brands: ['GAF', 'IKO'] }], error: null });
  h.updateResult = { data: [{ id: 'c1' }], error: null };
  h.updatePatch = null;
});

describe('gh-2105 A: claims is keyed on user_id', () => {
  it('selects user_id, never the nonexistent homeowner_id', async () => {
    const { result } = renderHook(() => useColorSelectionData('u1', 'c1', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(h.claimSelect).toMatch(/\buser_id\b/);
    expect(h.claimSelect).not.toMatch(/homeowner_id/);
    expect(result.current.gate).toBe('ready');
  });

  it('gates a claim owned by someone else as access-denied', async () => {
    h.claimRow = { ...CLAIM, user_id: 'someone-else' };
    const { result } = renderHook(() => useColorSelectionData('u1', 'c1', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.gate).toBe('access-denied');
  });

  it('saves scoped by id + user_id', async () => {
    await saveColorSelection({ claimId: 'c1', userId: 'u1', brand: 'GAF', colorName: 'Charcoal' });
    expect(h.filters).toEqual([['id', 'c1'], ['user_id', 'u1']]);
  });
});

describe('gh-2105 B + C: contractor name and brand come from the RPC, not an embedded join', () => {
  it('does not embed contractors or name nonexistent contractor columns', async () => {
    const { result } = renderHook(() => useColorSelectionData('u1', 'c1', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(h.claimSelect).not.toMatch(/contractors?\s*[:(]/);
    expect(h.claimSelect).not.toMatch(/preferred_brand\b/);
    expect(h.claimSelect).not.toMatch(/notification_phones|\bphone\b|\bemail\b/);
  });

  it('calls get_claim_color_contractor with the claim id and reads company_name + the first brand', async () => {
    const { result } = renderHook(() => useColorSelectionData('u1', 'c1', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(h.rpc).toHaveBeenCalledWith('get_claim_color_contractor', { p_claim_id: 'c1' });
    expect(result.current.contractorName).toBe('Acme Roofing');
    expect(result.current.brand).toBe('GAF');
    expect(result.current.contractorPhone).toBeNull();
  });

  it('normalizes the OC alias from the first array element', async () => {
    h.rpc.mockResolvedValue({ data: [{ company_name: 'Acme', preferred_brands: ['OC'] }], error: null });
    const { result } = renderHook(() => useColorSelectionData('u1', 'c1', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.brand).toBe('Owens Corning');
  });

  it('an RPC error is not fatal: generic contractor name, brand unconfirmed, page still ready', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'function does not exist' } });
    const { result } = renderHook(() => useColorSelectionData('u1', 'c1', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.gate).toBe('ready');
    expect(result.current.contractorName).toBe('Your Contractor');
    expect(result.current.brand).toBeNull();
  });

  it('an empty RPC result (not the owner, no selected contractor) behaves the same', async () => {
    h.rpc.mockResolvedValue({ data: [], error: null });
    const { result } = renderHook(() => useColorSelectionData('u1', 'c1', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.contractorName).toBe('Your Contractor');
    expect(result.current.brand).toBeNull();
  });
});

describe('gh-2105 F: a zero-row save surfaces', () => {
  it('resolves when the update returns a row', async () => {
    await expect(
      saveColorSelection({ claimId: 'c1', userId: 'u1', brand: null, colorName: 'Charcoal' }),
    ).resolves.toBeUndefined();
  });

  it('throws when the update matched zero rows (negative control for the line above)', async () => {
    h.updateResult = { data: [], error: null };
    await expect(
      saveColorSelection({ claimId: 'c1', userId: 'u1', brand: null, colorName: 'Charcoal' }),
    ).rejects.toThrow('Error saving color. Please try again.');
  });

  it('throws when the update returns null data', async () => {
    h.updateResult = { data: null, error: null };
    await expect(
      saveColorSelection({ claimId: 'c1', userId: 'u1', brand: null, colorName: 'Charcoal' }),
    ).rejects.toThrow();
  });

  it('throws the database error when there is one', async () => {
    h.updateResult = { data: null, error: { message: 'permission denied' } };
    await expect(
      saveColorSelection({ claimId: 'c1', userId: 'u1', brand: null, colorName: 'Charcoal' }),
    ).rejects.toThrow('Failed to save color selection: permission denied');
  });
});
