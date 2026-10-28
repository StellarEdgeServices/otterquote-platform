/**
 * gh-3138: behavior of the winning-quote read in useProjectConfirmationData. Drives the real hook against a
 * recording fake of the supabase client and asserts the actual select list, the newest-row chain, and the
 * error / empty / multiple-row handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const calls: { table: string; select?: string; ops: string[] }[] = [];
let quoteResult: { data: unknown; error: unknown } = { data: null, error: null };
let quoteRowCount = 1;

vi.mock('@/lib/supabase', () => {
  const chain = (table: string, result: () => { data: unknown; error: unknown }) => {
    const rec = { table, ops: [] as string[], select: undefined as string | undefined };
    calls.push(rec);
    const q: Record<string, unknown> = {};
    for (const op of ['eq', 'in', 'order', 'limit']) {
      q[op] = (...a: unknown[]) => {
        rec.ops.push(op + '(' + a.map((x) => JSON.stringify(x)).join(',') + ')');
        return q;
      };
    }
    q.select = (cols: string) => {
      rec.select = cols;
      return q;
    };
    q.single = () => Promise.resolve(result());
    q.maybeSingle = () => {
      // PostgREST: maybeSingle over more than one row is an error unless limit(1) was applied.
      if (table === 'quotes' && quoteRowCount > 1 && !rec.ops.includes('limit(1)')) {
        return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
      }
      return Promise.resolve(result());
    };
    return q;
  };
  return {
    supabase: {
      from: (table: string) =>
        chain(table, () => {
          if (table === 'claims') {
            return {
              data: { id: 'c1', status: 'contract_signed', selected_contractor_id: 'ctr1', user_id: 'u1' },
              error: null,
            };
          }
          if (table === 'profiles') return { data: { id: 'u1', full_name: 'Jane' }, error: null };
          return quoteResult;
        }),
      rpc: (fn: string) => {
        if (fn === 'claim_private_text') return Promise.resolve({ data: null, error: null });
        return chain('rpc:' + fn, () => ({ data: { id: 'ctr1', company_name: 'Acme' }, error: null }));
      },
    },
  };
});

import { useProjectConfirmationData } from '../use-project-confirmation-data';

const run = () => renderHook(() => useProjectConfirmationData('u1', 'c1', true));
const quoteCall = () => calls.find((c) => c.table === 'quotes')!;

beforeEach(() => {
  calls.length = 0;
  quoteRowCount = 1;
  quoteResult = { data: null, error: null };
});

describe('useProjectConfirmationData winning quote (gh-3138)', () => {
  it('selects real columns, newest winner first, limit 1, and maps brand + decking rate', async () => {
    quoteResult = {
      data: { scope_summary: '{"brand":"GAF Timberline HDZ"}', decking_price_per_sheet: 75, status: 'selected' },
      error: null,
    };
    const { result } = run();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const c = quoteCall();
    expect(c.select).toBe('scope_summary, decking_price_per_sheet, status');
    expect(c.select).not.toMatch(/brand|product_line/);
    expect(c.ops).toContain('limit(1)');
    expect(c.ops.some((o) => o.startsWith('in("status"'))).toBe(true);
    expect(c.ops).toContain('order("created_at",{"ascending":false})');
    expect(result.current.error).toBeNull();
    expect(result.current.gate).toBe('ready');
    expect(result.current.quote?.brand).toBe('GAF Timberline HDZ');
    expect(result.current.deckingRatePerSheet).toBe(75);
  });

  it('multiple quote rows (renewals) do not hard-fail the page', async () => {
    quoteRowCount = 3;
    quoteResult = { data: { scope_summary: null, decking_price_per_sheet: 60, status: 'selected' }, error: null };
    const { result } = run();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.gate).toBe('ready');
    expect(result.current.deckingRatePerSheet).toBe(60);
  });

  it('zero quote rows is not an error', async () => {
    quoteResult = { data: null, error: null };
    const { result } = run();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.gate).toBe('ready');
    expect(result.current.quote).toBeNull();
  });

  it('a real quote query error surfaces a load error instead of silently rendering a dash', async () => {
    quoteResult = { data: null, error: { code: '42703', message: 'column quotes.brand does not exist' } };
    const { result } = run();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/quote/i);
    expect(result.current.gate).not.toBe('ready');
  });
});
