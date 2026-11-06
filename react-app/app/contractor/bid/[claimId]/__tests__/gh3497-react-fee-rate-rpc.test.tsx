// gh-3497 (LEGAL-READ 6675181967 on PR #3491): the React bid form reads the fee rate the way the SERVER does, through
// rpc('quotes_platform_fee_for'), and a submit with no answer stops.
//
// The fake client models what production does to a contractor session: platform_fee_config is admin-only under RLS, so a
// table read returns 0 rows (not an error); the RPC (SECURITY DEFINER, executable by `authenticated`) answers.
// On the base (bab62017) the form reads the table, gets 0 rows, shows 5.00 whatever is configured, and files the bid.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => {
  const state = {
    configured: 7.5 as number,                 // the rate the server has configured
    rpcMode: 'rate' as 'rate' | 'empty' | 'error' | 'null-pct' | 'hang',
    rpcArgs: [] as Array<Record<string, unknown>>,
    tableReads: 0,
    inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
    insertError: null as string | null,   // the quotes trigger refuses the insert once (and the rate has moved to 7.5)
  };
  function builder(table: string) {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const k of ['select', 'order', 'eq', 'limit', 'update', 'or']) b[k] = chain;
    b.insert = (row: Record<string, unknown>) => { if (!(table === 'quotes' && state.insertError)) state.inserts.push({ table, row }); return b; };
    b.single = async () => {
      if (table === 'quotes' && state.insertError) {
        const message = state.insertError; state.insertError = null; state.configured = 7.5;   // refused: no row stored; the configured rate had moved
        return { data: null, error: { message, code: 'P0001' } };
      }
      return { data: { id: 'quote-1' }, error: null };
    };
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      if (table === 'platform_fee_config') state.tableReads++;       // RLS: 0 rows, no error, for a contractor
      return Promise.resolve({ data: [], error: null }).then(res, rej);
    };
    return b;
  }
  const supabase = {
    from: (t: string) => builder(t),
    rpc: async (name: string, args?: Record<string, unknown>) => {
      if (name !== 'quotes_platform_fee_for') return { data: { can_submit: true }, error: null };
      state.rpcArgs.push(args ?? {});
      switch (state.rpcMode) {
        case 'hang': return new Promise(() => {});
        case 'empty': return { data: [], error: null };
        case 'error': return { data: null, error: { message: 'permission denied for function quotes_platform_fee_for' } };
        case 'null-pct': return { data: [{ fee_pct: null, fee_basis: 'bid_amount' }], error: null };
        default: return { data: [{ fee_pct: state.configured, fee_basis: 'bid_amount' }], error: null };
      }
    },
    functions: { invoke: async () => ({ data: null, error: null }) },
  };
  return { state, supabase };
});

vi.mock('@/lib/supabase', () => ({ supabase: h.supabase }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

import { BidForm } from '../bid-form';
import { parseConfiguredFeePct } from '../utils';

const claim = { id: 'claim-1', trades: ['roofing'], job_type: 'retail', funding_type: 'cash', user_id: 'u1' };
const contractor = { id: 'c1', address_state: 'IN', company_name: 'Acme Roofing' };
const flags = { isRetailJob: true, gutterTradeActive: false, sidingTradeActive: false };

function mount() {
  return render(
    <BidForm mode="new" claim={claim as never} contractor={contractor as never} existingQuote={null}
      flags={flags} claimRcv={null} userId="u1" />,
  );
}
const priceInput = (c: HTMLElement) => c.querySelector('.oqb-money input') as HTMLInputElement;
const feeBox = (c: HTMLElement) => Array.from(c.querySelectorAll('input[type="checkbox"]'))
  .find((el) => /platform fee/.test(el.parentElement?.textContent || '')) as HTMLInputElement;
const submitBtn = (c: HTMLElement) => Array.from(c.querySelectorAll('button')).find((b) => /Submit|Submitting/.test(b.textContent || '')) as HTMLButtonElement;
const inserted = (t: string) => h.state.inserts.filter((i) => i.table === t);

afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  h.state.configured = 7.5; h.state.rpcMode = 'rate'; h.state.rpcArgs.length = 0; h.state.tableReads = 0; h.state.inserts.length = 0; h.state.insertError = null;
});

describe('gh-3497 part 1: React bid form reads the rate through quotes_platform_fee_for', () => {
  it('shows the CONFIGURED rate to a contractor session (the table read would return 0 rows and show 5.00)', async () => {
    const { container } = mount();
    fireEvent.change(priceInput(container), { target: { value: '25000' } });
    await waitFor(() => expect(container.textContent).toContain('7.50%'));
    expect(container.textContent).toContain('$1,875.00');
    expect(container.textContent).not.toContain('$1,250.00');
    expect(h.state.rpcArgs[0]).toEqual({ p_contractor_id: 'c1', p_claim_id: 'claim-1' });
    expect(h.state.tableReads).toBe(0);
  });

  it('files the bid at the configured rate once the contractor has accepted the figure on screen', async () => {
    const { container } = mount();
    fireEvent.change(priceInput(container), { target: { value: '25000' } });
    await waitFor(() => expect(container.textContent).toContain('7.50%'));
    fireEvent.click(feeBox(container));
    fireEvent.click(submitBtn(container));
    await waitFor(() => expect(inserted('fee_acceptances').length).toBe(1));
    expect(inserted('quotes')[0].row.platform_fee_pct).toBe(7.5);
    expect(inserted('fee_acceptances')[0].row.fee_amount).toBe(1875);
  });

  for (const mode of ['empty', 'error', 'null-pct'] as const) {
    it(`no answer (${mode}): nothing is filed, the reason is shown through the existing error line, and the entries are kept`, async () => {
      h.state.rpcMode = mode;
      const { container } = mount();
      fireEvent.change(priceInput(container), { target: { value: '25000' } });
      await waitFor(() => expect(h.state.rpcArgs.length).toBeGreaterThan(0));
      fireEvent.click(feeBox(container));
      await waitFor(() => expect(submitBtn(container).disabled).toBe(false));
      fireEvent.click(submitBtn(container));
      await waitFor(() => expect(container.textContent).toContain('Error submitting bid: fee_rate_unavailable'));
      expect(inserted('quotes').length).toBe(0);
      expect(inserted('fee_acceptances').length).toBe(0);
      expect(priceInput(container).value).toBe('25000');           // the bid is not lost
      expect(submitBtn(container).disabled).toBe(false);            // and can be tried again
    });
  }

  it('no answer (the lookup never returns): bounded, then nothing is filed', async () => {
    h.state.rpcMode = 'hang';
    const { container } = mount();
    fireEvent.change(priceInput(container), { target: { value: '25000' } });
    fireEvent.click(feeBox(container));
    await waitFor(() => expect(submitBtn(container).disabled).toBe(false), { timeout: 8000 });
    fireEvent.click(submitBtn(container));
    await waitFor(() => expect(container.textContent).toContain('Error submitting bid: fee_rate_unavailable'), { timeout: 8000 });
    expect(inserted('quotes').length).toBe(0);
    expect(inserted('fee_acceptances').length).toBe(0);
  }, 25000);

  it('a retry after a no-answer files normally once the rate is readable', async () => {
    h.state.rpcMode = 'empty';
    const { container } = mount();
    fireEvent.change(priceInput(container), { target: { value: '25000' } });
    await waitFor(() => expect(h.state.rpcArgs.length).toBeGreaterThan(0));
    fireEvent.click(feeBox(container));
    await waitFor(() => expect(submitBtn(container).disabled).toBe(false));
    fireEvent.click(submitBtn(container));
    await waitFor(() => expect(container.textContent).toContain('fee_rate_unavailable'));
    h.state.rpcMode = 'rate';                                                     // the rate is readable again: the fresh lookup
    fireEvent.click(submitBtn(container));                                         // shows 7.50 and asks for acceptance again
    await waitFor(() => expect(container.textContent).toContain('7.50%'));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });      // let the new rate's effects settle: a tick belongs to its rate
    expect(inserted('quotes').length).toBe(0);
    fireEvent.click(feeBox(container));
    await waitFor(() => expect(submitBtn(container).disabled).toBe(false));
    fireEvent.click(submitBtn(container));
    await waitFor(() => expect(inserted('fee_acceptances').length).toBe(1));
    expect(inserted('fee_acceptances')[0].row.fee_amount).toBe(1875);
  });

  it('the server refuses a stale displayed rate (fee_rate_mismatch): the bid is not lost, the new rate is shown, the tick is cleared, and the re-accepted bid files', async () => {
    h.state.configured = 5;
    const { container } = mount();
    fireEvent.change(priceInput(container), { target: { value: '25000' } });
    await waitFor(() => expect(container.textContent).toContain('5.00%'));
    fireEvent.click(feeBox(container));
    await waitFor(() => expect(submitBtn(container).disabled).toBe(false));
    h.state.insertError = 'quotes: fee_rate_mismatch: the fee rate shown with this bid is 5.00 percent but the configured rate is 7.50 percent, so the bid was not saved (gh-3497)';
    fireEvent.click(submitBtn(container));
    await waitFor(() => expect(container.textContent).toContain('Error submitting bid: quotes: fee_rate_mismatch'));
    await waitFor(() => expect(container.textContent).toContain('7.50%'));
    expect(inserted('quotes').length).toBe(0);
    expect(inserted('fee_acceptances').length).toBe(0);
    expect(priceInput(container).value).toBe('25000');                         // the bid is not lost
    expect(feeBox(container).checked).toBe(false);                             // the old acceptance does not carry over
    expect(submitBtn(container).disabled).toBe(true);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    fireEvent.click(feeBox(container));
    await waitFor(() => expect(submitBtn(container).disabled).toBe(false));
    fireEvent.click(submitBtn(container));
    await waitFor(() => expect(inserted('fee_acceptances').length).toBe(1));
    expect(inserted('quotes')[0].row.platform_fee_pct).toBe(7.5);
    expect(inserted('fee_acceptances')[0].row.fee_amount).toBe(1875);
  });
});

describe('gh-3497: parseConfiguredFeePct has no default', () => {
  it('reads a rate from the function\'s table answer', () => {
    expect(parseConfiguredFeePct([{ fee_pct: 7.5, fee_basis: 'bid_amount' }])).toBe(7.5);
    expect(parseConfiguredFeePct([{ fee_pct: '5.00', fee_basis: 'bid_amount' }])).toBe(5);
  });
  it('returns null, not 5, for every non-answer', () => {
    for (const v of [null, undefined, [], {}, [{}], [{ fee_pct: null }], [{ fee_pct: 'abc' }], [{ fee_pct: 0 }], [{ fee_pct: -1 }], 'x']) {
      expect(parseConfiguredFeePct(v as never)).toBeNull();
    }
  });
});
