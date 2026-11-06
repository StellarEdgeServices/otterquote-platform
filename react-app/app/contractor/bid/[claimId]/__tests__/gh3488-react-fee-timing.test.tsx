// gh-3488 (REVIEW 6674426561): does the React bid form have the same two timing windows as contractor-bid-form.html?
//   (1) bid edited while submit is running: handleSubmit closes over the render-time bid, so what is recorded, stored
//       and sent is one figure; the test proves the stored price, the accepted fee and the confirmation agree.
//   (2) acceptance older than the rate: feePct starts at the default until the platform_fee_config lookup returns.
//       A contractor who ticks the box under the default-rate disclosure must not have it carried onto a different rate.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => {
  const state = {
    releaseFee: null as null | ((rows: Array<{ fee_pct: number }>) => void),
    inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  };
  function builder(table: string) {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const k of ['select', 'or', 'order', 'eq', 'limit', 'update']) b[k] = chain;
    b.insert = (row: Record<string, unknown>) => { state.inserts.push({ table, row }); return b; };
    b.single = async () => ({ data: { id: 'quote-1' }, error: null });
    b.then = (res: (v: unknown) => unknown) => {
      if (table === 'platform_fee_config') {
        return new Promise((r) => { state.releaseFee = (rows) => r({ data: rows, error: null }); }).then(res);
      }
      return Promise.resolve({ data: [], error: null }).then(res);
    };
    return b;
  }
  const supabase = {
    from: (t: string) => builder(t),
    rpc: async () => ({ data: { can_submit: true }, error: null }),
    functions: { invoke: async () => ({ data: null, error: null }) },
  };
  return { state, supabase };
});

vi.mock('@/lib/supabase', () => ({ supabase: h.supabase }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

import { BidForm } from '../bid-form';

const claim = { id: 'claim-1', trades: ['roofing'], job_type: 'retail', funding_type: 'cash', user_id: 'u1' };
const contractor = { id: 'c1', state: 'TX', company_name: 'Acme Roofing' };
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

afterEach(() => { cleanup(); h.state.inserts.length = 0; h.state.releaseFee = null; });

describe('gh-3488 React bid form: timing windows', () => {
  it('(1) an edit after the click cannot change what is stored or accepted', async () => {
    const { container, getByText } = mount();
    await waitFor(() => expect(h.state.releaseFee).toBeTruthy());
    await act(async () => { h.state.releaseFee!([{ fee_pct: 5 }]); });
    fireEvent.change(priceInput(container), { target: { value: '18500' } });
    fireEvent.click(feeBox(container));
    fireEvent.click(getByText(/Submit/i, { selector: 'button' }));
    fireEvent.change(priceInput(container), { target: { value: '25000' } }); // edit after the click
    await waitFor(() => expect(h.state.inserts.some((i) => i.table === 'fee_acceptances')).toBe(true));
    const q = h.state.inserts.find((i) => i.table === 'quotes')!.row;
    const fa = h.state.inserts.find((i) => i.table === 'fee_acceptances')!.row;
    expect(q.total_price).toBe(18500);
    expect(fa.fee_amount).toBe(925);
  });

  it('(2) a rate that arrives after the box was ticked must not carry the old acceptance onto the new disclosure', async () => {
    const { container } = mount();
    await waitFor(() => expect(h.state.releaseFee).toBeTruthy());
    fireEvent.change(priceInput(container), { target: { value: '18500' } });
    fireEvent.click(feeBox(container));                 // ticked under the default-rate (5.00%) disclosure
    expect(feeBox(container).checked).toBe(true);
    expect(container.textContent).toContain('5.00%');
    await act(async () => { h.state.releaseFee!([{ fee_pct: 7.5 }]); });   // the configured rate lands afterwards
    expect(container.textContent).toContain('7.50%');
    // the disclosure changed, so the earlier acceptance no longer covers it
    expect(feeBox(container).checked).toBe(false);
  });

  it('(2) submit stays disabled while the rate lookup is in flight, then enables once it lands', async () => {
    const { container, getByText } = mount();
    await waitFor(() => expect(h.state.releaseFee).toBeTruthy());
    fireEvent.change(priceInput(container), { target: { value: '18500' } });
    fireEvent.click(feeBox(container));
    const btn = getByText(/Submit/i, { selector: 'button' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);                    // lookup still in flight
    await act(async () => { h.state.releaseFee!([{ fee_pct: 5 }]); });
    expect(feeBox(container).checked).toBe(true);       // unchanged rate: the acceptance still stands
    expect(btn.disabled).toBe(false);
  });
});
