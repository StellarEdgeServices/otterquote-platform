/**
 * gh-3858 (review fix 4): the data hook reads an existing paid measurement order ONLY when the charge flag is ON, so a revisit
 * can show the confirmation; with the flag OFF it runs no hover_orders query (queries identical to main).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const tables: string[] = [];
let orderRow: unknown = null;

vi.mock('@/lib/supabase', () => {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit', 'not', 'neq']) c[m] = () => c;
    c.maybeSingle = () =>
      Promise.resolve({
        data: table === 'claims' ? { id: 'c1' } : table === 'hover_orders' ? orderRow : null,
        error: null,
      });
    return c;
  };
  return { supabase: { from: (t: string) => { tables.push(t); return chain(t); } } };
});
vi.mock('@/lib/services', () => ({ sendAdjusterEmail: vi.fn(), createHoverPaymentIntent: vi.fn() }));

import { useHelpMeasurementsData } from '../use-help-measurements-data';

beforeEach(() => {
  tables.length = 0;
  orderRow = null;
});
afterEach(() => vi.unstubAllEnvs());

describe('useHelpMeasurementsData existingOrder', () => {
  it('flag ON + a paid order row: existingOrder is true', async () => {
    vi.stubEnv('NEXT_PUBLIC_MEASUREMENT_CHARGE_ENABLED', 'true');
    orderRow = { id: 'o1' };
    const { result } = renderHook(() => useHelpMeasurementsData('u1', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.existingOrder).toBe(true);
    expect(tables).toContain('hover_orders');
  });

  it('flag ON + no order row: existingOrder is false', async () => {
    vi.stubEnv('NEXT_PUBLIC_MEASUREMENT_CHARGE_ENABLED', 'true');
    const { result } = renderHook(() => useHelpMeasurementsData('u1', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.existingOrder).toBe(false);
  });

  it('flag OFF: no hover_orders query at all and existingOrder stays false, even if a row exists', async () => {
    vi.stubEnv('NEXT_PUBLIC_MEASUREMENT_CHARGE_ENABLED', 'false');
    orderRow = { id: 'o1' };
    const { result } = renderHook(() => useHelpMeasurementsData('u1', true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.existingOrder).toBe(false);
    expect(tables).not.toContain('hover_orders');
  });
});
