// gh-3488 (REVIEW 6674426561, REVIEW 6674889982, LEGAL-READ 6674806511): the React bid form's timing windows.
//   - edit during submit: handleSubmit closes over the render-time bid, so stored price and accepted fee agree
//   - acceptance older than the rate: a tick never outlives the rate or bid it was given under
//   - a fee lookup or ipify call that never returns is bounded; the submit button cannot stay disabled forever
//   - one submit at a time: a double click (same tick) files one bid; the fee box is locked while submitting
//   - a fresh rate lookup at every submit, keyed on address_state (the column the server reads)
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => {
  const state = {
    releaseFee: null as null | ((rows: Array<{ fee_pct: number }>) => void),
    inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
    rate: 5,            // what any lookup after the first answers
    deferFirst: true,   // the first lookup is held until releaseFee
    hangAll: false,     // every lookup never returns
    lookups: 0,
    queries: [] as string[],
  };
  function builder(table: string) {
    const ors: string[] = [];
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const k of ['select', 'order', 'eq', 'limit', 'update']) b[k] = chain;
    b.or = (a: string) => { ors.push(a); return b; };
    b.insert = (row: Record<string, unknown>) => { state.inserts.push({ table, row }); return b; };
    b.single = async () => ({ data: { id: 'quote-1' }, error: null });
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      if (table === 'platform_fee_config') {
        state.lookups++;
        state.queries.push(ors.join(' | '));
        if (state.hangAll) return new Promise(() => {}).then(res, rej);
        if (state.lookups === 1 && state.deferFirst) {
          return new Promise((r) => { state.releaseFee = (rows) => { state.rate = rows[0].fee_pct; r({ data: rows, error: null }); }; }).then(res, rej);
        }
        return Promise.resolve({ data: [{ fee_pct: state.rate }], error: null }).then(res, rej);
      }
      return Promise.resolve({ data: [], error: null }).then(res, rej);
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
  h.state.inserts.length = 0; h.state.releaseFee = null; h.state.rate = 5; h.state.deferFirst = true;
  h.state.hangAll = false; h.state.lookups = 0; h.state.queries.length = 0;
});

async function ready(c: HTMLElement, bid = '18500', rate = 5) {
  await waitFor(() => expect(h.state.releaseFee).toBeTruthy());
  await act(async () => { h.state.releaseFee!([{ fee_pct: rate }]); });
  fireEvent.change(priceInput(c), { target: { value: bid } });
  fireEvent.click(feeBox(c));
}

describe('gh-3488 React bid form: timing windows', () => {
  it('(1) an edit after the click cannot change what is stored or accepted', async () => {
    const { container } = mount();
    await ready(container);
    fireEvent.click(submitBtn(container));
    fireEvent.change(priceInput(container), { target: { value: '25000' } }); // edit after the click
    await waitFor(() => expect(inserted('fee_acceptances').length).toBe(1));
    expect(inserted('quotes')[0].row.total_price).toBe(18500);
    expect(inserted('fee_acceptances')[0].row.fee_amount).toBe(925);
  });

  it('(2) a rate that arrives after the box was ticked must not carry the old acceptance onto the new disclosure', async () => {
    const { container } = mount();
    await waitFor(() => expect(h.state.releaseFee).toBeTruthy());
    fireEvent.change(priceInput(container), { target: { value: '18500' } });
    fireEvent.click(feeBox(container));
    expect(feeBox(container).checked).toBe(true);
    expect(container.textContent).toContain('5.00%');
    await act(async () => { h.state.releaseFee!([{ fee_pct: 7.5 }]); });
    expect(container.textContent).toContain('7.50%');
    expect(feeBox(container).checked).toBe(false);
  });

  it('(2) submit stays disabled while the rate lookup is in flight, then enables once it lands', async () => {
    const { container } = mount();
    await waitFor(() => expect(h.state.releaseFee).toBeTruthy());
    fireEvent.change(priceInput(container), { target: { value: '18500' } });
    fireEvent.click(feeBox(container));
    expect(submitBtn(container).disabled).toBe(true);
    await act(async () => { h.state.releaseFee!([{ fee_pct: 5 }]); });
    expect(feeBox(container).checked).toBe(true);
    expect(submitBtn(container).disabled).toBe(false);
  });

  it('(REVIEW) a fee lookup that never returns is bounded: the button is not disabled forever', async () => {
    h.state.hangAll = true;
    const { container } = mount();
    fireEvent.change(priceInput(container), { target: { value: '18500' } });
    fireEvent.click(feeBox(container));
    expect(submitBtn(container).disabled).toBe(true);                         // while the lookup is open
    await waitFor(() => expect(submitBtn(container).disabled).toBe(false), { timeout: 8000 });   // 3fc20d19: never
    expect(feeBox(container).checked).toBe(true);
  }, 15000);

  it('(REVIEW) an ipify call that never returns times out; the bid files with the IP unknown', async () => {
    const { container } = mount();
    await ready(container);
    vi.stubGlobal('fetch', (_u: string, init?: { signal?: AbortSignal }) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));      // never answers by itself
    }));
    fireEvent.click(submitBtn(container));
    await waitFor(() => expect(inserted('fee_acceptances').length).toBe(1), { timeout: 8000 });   // 3fc20d19: never
    expect(inserted('fee_acceptances')[0].row.ip_address).toBe('unknown');
  }, 15000);

  it('(REVIEW) a double click in the same tick files one bid, and the fee box is locked while submitting', async () => {
    const { container } = mount();
    await ready(container);
    const btn = submitBtn(container);
    await act(async () => { btn.click(); btn.click(); });                       // no re-render between the two clicks
    expect(feeBox(container).disabled).toBe(true);                              // 3fc20d19: not locked
    await waitFor(() => expect(inserted('fee_acceptances').length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 200));
    expect(inserted('quotes').length).toBe(1);                                   // 3fc20d19: 2
    expect(inserted('fee_acceptances').length).toBe(1);
  });

  it('(LEGAL) a rate that moved since the last lookup is caught at submit: nothing is filed and the new rate needs a new tick', async () => {
    const { container } = mount();
    await ready(container);
    h.state.rate = 7.5;                                                          // the server moves; the form has not looked
    fireEvent.click(submitBtn(container));
    await waitFor(() => expect(container.textContent).toContain('7.50%'));
    await new Promise((r) => setTimeout(r, 100));
    expect(inserted('quotes').length).toBe(0);                                   // 3fc20d19: filed at 5.00
    expect(inserted('fee_acceptances').length).toBe(0);
    expect(feeBox(container).checked).toBe(false);
    expect(submitBtn(container).disabled).toBe(true);
    fireEvent.click(feeBox(container));
    fireEvent.click(submitBtn(container));
    await waitFor(() => expect(inserted('fee_acceptances').length).toBe(1));
    expect(inserted('fee_acceptances')[0].row.fee_amount).toBe(1387.5);
  });

  it('(LEGAL) the lookup uses the contractor\'s address_state, the column the server reads', async () => {
    mount();
    await waitFor(() => expect(h.state.queries.length).toBeGreaterThan(0));
    expect(h.state.queries[0]).toContain('state.eq.IN');                          // 3fc20d19: state.eq. (blank)
  });

  it('(LEGAL) a tick is cleared when the bid changes', async () => {
    const { container } = mount();
    await ready(container);
    expect(feeBox(container).checked).toBe(true);
    fireEvent.change(priceInput(container), { target: { value: '19000' } });
    expect(feeBox(container).checked).toBe(false);
  });
});
