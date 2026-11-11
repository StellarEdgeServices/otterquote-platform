// gh-3488 (REVIEW 6674426561, REVIEW 6674889982, LEGAL-READ 6674806511): the React bid form's timing windows.
//   - edit during submit: handleSubmit closes over the render-time bid, so stored price and accepted fee agree
//   - acceptance older than the rate: a tick never outlives the rate or bid it was given under
//   - a fee lookup or ipify call that never returns is bounded; the submit button cannot stay disabled forever
//   - one submit at a time: a double click (same tick) files one bid; the fee box is locked while submitting
//   - a fresh rate lookup at every submit; gh-3497: through rpc('quotes_platform_fee_for'), which resolves the state itself.
//     The fake below models RLS: a table read of platform_fee_config as a contractor returns 0 rows.
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
    hangUpdate: false,  // gh-3491: a quotes UPDATE never returns
    lookups: 0,
    queries: [] as string[],   // gh-3497: the rpc arguments of each lookup, as text
    tableReads: 0,             // reads of platform_fee_config itself (a contractor sees 0 rows)
  };
  function builder(table: string) {
    const ors: string[] = [];
    let op = 'select';
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const k of ['select', 'order', 'eq', 'limit', 'abortSignal']) b[k] = chain;
    b.update = (row: Record<string, unknown>) => { op = 'update'; state.inserts.push({ table: table + ':update', row }); return b; };
    b.or = (a: string) => { ors.push(a); return b; };
    b.insert = (row: Record<string, unknown>) => { state.inserts.push({ table, row }); return b; };
    b.single = async () => ({ data: { id: 'quote-1' }, error: null });
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      if (table === 'platform_fee_config') state.tableReads++;   // RLS: admin-only, 0 rows for a contractor
      if (table === 'quotes' && op === 'update') {
        if (state.hangUpdate) return new Promise(() => {}).then(res, rej);
        return Promise.resolve({ data: [{ id: 'q-1' }], error: null }).then(res, rej);
      }
      return Promise.resolve({ data: [], error: null }).then(res, rej);
    };
    return b;
  }
  const supabase = {
    from: (t: string) => builder(t),
    rpc: async (name: string, args?: Record<string, unknown>) => {
      if (name !== 'quotes_platform_fee_for') return { data: { can_submit: true }, error: null };
      state.lookups++;
      state.queries.push(JSON.stringify(args));
      if (state.hangAll) return new Promise(() => {});
      if (state.lookups === 1 && state.deferFirst) {
        return new Promise((r) => { state.releaseFee = (rows) => { state.rate = rows[0].fee_pct; r({ data: rows, error: null }); }; });
      }
      return { data: [{ fee_pct: state.rate, fee_basis: 'bid_amount' }], error: null };
    },
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
const submitBtn = (c: HTMLElement) => Array.from(c.querySelectorAll('button')).find((b) => /Submit|Submitting|Update Bid|Renew Bid/.test(b.textContent || '')) as HTMLButtonElement;
const inserted = (t: string) => h.state.inserts.filter((i) => i.table === t);

afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  h.state.inserts.length = 0; h.state.releaseFee = null; h.state.rate = 5; h.state.deferFirst = true;
  h.state.hangAll = false; h.state.hangUpdate = false; h.state.lookups = 0; h.state.queries.length = 0; h.state.tableReads = 0;
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

  it('(REVIEW) an ipify call that never returns times out; the bid files with no IP (null, not the string unknown)', async () => {
    const { container } = mount();
    await ready(container);
    vi.stubGlobal('fetch', (_u: string, init?: { signal?: AbortSignal }) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));      // never answers by itself
    }));
    fireEvent.click(submitBtn(container));
    await waitFor(() => expect(inserted('fee_acceptances').length).toBe(1), { timeout: 8000 });   // 3fc20d19: never
    expect(inserted('fee_acceptances')[0].row.ip_address).toBeNull();   // gh-3409: never 'unknown' (inet column)
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

  it('(LEGAL) the lookup goes through quotes_platform_fee_for with the contractor and claim, not the admin-only table', async () => {
    mount();
    await waitFor(() => expect(h.state.queries.length).toBeGreaterThan(0));
    expect(JSON.parse(h.state.queries[0])).toEqual({ p_contractor_id: 'c1', p_claim_id: 'claim-1' });   // the server resolves state and trade
    expect(h.state.tableReads).toBe(0);
  });

  it('(LEGAL) a tick is cleared when the bid changes', async () => {
    const { container } = mount();
    await ready(container);
    expect(feeBox(container).checked).toBe(true);
    fireEvent.change(priceInput(container), { target: { value: '19000' } });
    expect(feeBox(container).checked).toBe(false);
  });

  // gh-3491 (REVIEW 6688103147): the Change Bid UPDATE is the one await the submit lock made un-escapable.
  it('(REVIEW) a Change Bid UPDATE that never returns ends with a message and an unlocked form; a retry files once', async () => {
    h.state.deferFirst = false;
    h.state.hangUpdate = true;
    const existing = { id: 'q-1', bid_status: 'active', renewals_count: 0, total_price: 18000, platform_fee_pct: 5, fee_percentage: 5 };   // gh-3497: a stored rate, as every row has (fee_percentage is NOT NULL)
    const { container } = render(
      <BidForm mode="change" claim={claim as never} contractor={contractor as never} existingQuote={existing as never}
        flags={flags} claimRcv={null} userId="u1" />,
    );
    // gh-3497 (LEGAL-READ 6743062238): Change Bid uses the quote's stored rate, so it makes no configured-rate lookup.
    await waitFor(() => expect(container.textContent).toContain('5.00%'));
    fireEvent.change(priceInput(container), { target: { value: '18500' } });
    fireEvent.click(feeBox(container));
    await waitFor(() => expect(submitBtn(container).disabled).toBe(false));
    fireEvent.click(submitBtn(container));
    await waitFor(() => expect(submitBtn(container).textContent).toContain('Submitting'));
    // bab62017: stays "Submitting…" with the fee box locked and no message, forever
    await waitFor(() => expect(container.querySelector('.oqb-err')?.textContent).toContain('Error submitting bid'), { timeout: 20000 });
    expect(submitBtn(container).disabled).toBe(false);
    expect(submitBtn(container).textContent).not.toContain('Submitting');
    expect(feeBox(container).disabled).toBe(false);
    // the connection is back: the retry files the same UPDATE once and reaches the success screen
    h.state.hangUpdate = false;
    fireEvent.click(submitBtn(container));
    await waitFor(() => expect(container.textContent).toContain('Bid updated'));
    expect(inserted('quotes:update').length).toBe(2);   // the first (hung) attempt and the retry; one row, same fields
    expect(inserted('quotes:update')[1].row.total_price).toBe(18500);
    expect(inserted('quotes:update')[1].row.platform_fee_pct).toBe(5);   // gh-3497: the stored rate
    expect(h.state.lookups).toBe(0);
  }, 40000);
});
