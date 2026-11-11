// gh-3497 (LEGAL-READ 6743062238 on PR #3500): Change Bid and Renew show, accept and send the bid's STORED rate.
//
// The quotes guard (gh2564, CEO ruling 6050104316: c_revised_bid_takes_current_config_rate := false) keeps the stored
// platform_fee_pct / fee_percentage on the contractor's own UPDATE and recomputes fee_amount from that rate and the new
// total_price. If the form showed the CONFIGURED rate instead, a bid stored at 5.00 and changed or renewed after a move
// to 4.00 would show 4.00 and be charged 5.00. Here the configured rate (4.00) differs from the stored one (5.00), and the
// fake UPDATE applies the guard's own rule, so "shown fee = the fee the guard stores" is checked against what is stored.
// On ccb66dc7 the form reads quotes_platform_fee_for in every mode, shows 4.00 and sends platform_fee_pct 4.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => {
  const state = {
    configured: 4 as number,      // the rate configured today (new bids)
    rpcCalls: 0,
    updates: [] as Array<Record<string, unknown>>,
    stored: [] as Array<{ platform_fee_pct: unknown; fee_amount: number }>,   // what the guard leaves on the row
    inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
    existing: null as null | Record<string, unknown>,
  };
  function builder(table: string) {
    let op = 'select';
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const k of ['select', 'order', 'eq', 'limit', 'or', 'abortSignal']) b[k] = chain;
    b.update = (row: Record<string, unknown>) => {
      op = 'update';
      if (table === 'quotes') {
        state.updates.push(row);
        // gh2564 guard on the contractor's UPDATE: the stored rate stays; fee_amount = round(rate/100 * total_price, 2)
        const old = state.existing!;
        const rate = Number(old.platform_fee_pct ?? old.fee_percentage);
        state.stored.push({ platform_fee_pct: old.platform_fee_pct, fee_amount: Math.round(rate * Number(row.total_price)) / 100 });
      }
      return b;
    };
    b.insert = (row: Record<string, unknown>) => { state.inserts.push({ table, row }); return b; };
    b.single = async () => ({ data: { id: 'quote-1' }, error: null });
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      if (table === 'quotes' && op === 'update') return Promise.resolve({ data: [{ id: 'q-1' }], error: null }).then(res, rej);
      return Promise.resolve({ data: [], error: null }).then(res, rej);
    };
    return b;
  }
  const supabase = {
    from: (t: string) => builder(t),
    rpc: async (name: string) => {
      if (name !== 'quotes_platform_fee_for') return { data: { can_submit: true }, error: null };
      state.rpcCalls++;
      return { data: [{ fee_pct: state.configured, fee_basis: 'bid_amount' }], error: null };
    },
    functions: { invoke: async () => ({ data: null, error: null }) },
  };
  return { state, supabase };
});

vi.mock('@/lib/supabase', () => ({ supabase: h.supabase }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

import { BidForm } from '../bid-form';
import { storedQuoteFeePct } from '../utils';

const claim = { id: 'claim-1', trades: ['roofing'], job_type: 'retail', funding_type: 'cash', user_id: 'u1' };
const contractor = { id: 'c1', address_state: 'IN', company_name: 'Acme Roofing' };
const flags = { isRetailJob: true, gutterTradeActive: false, sidingTradeActive: false };

const priceInput = (c: HTMLElement) => c.querySelector('.oqb-money input') as HTMLInputElement;
const feeBox = (c: HTMLElement) => Array.from(c.querySelectorAll('input[type="checkbox"]'))
  .find((el) => /platform fee/.test(el.parentElement?.textContent || '')) as HTMLInputElement;
const submitBtn = (c: HTMLElement) => Array.from(c.querySelectorAll('button')).find((b) => /Submit|Submitting|Update Bid|Renew Bid/.test(b.textContent || '')) as HTMLButtonElement;

afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  h.state.configured = 4; h.state.rpcCalls = 0; h.state.updates.length = 0; h.state.stored.length = 0; h.state.inserts.length = 0; h.state.existing = null;
});

for (const mode of ['change', 'renew'] as const) {
  describe(`gh-3497: ${mode === 'change' ? 'Change Bid' : 'Renew'} uses the bid's stored rate, not the configured one`, () => {
    it('stored 5.00, configured 4.00: shows 5.00, sends platform_fee_pct 5, and the fee shown is the fee the guard stores', async () => {
      const existing = { id: 'q-1', bid_status: mode === 'renew' ? 'expired' : 'active', total_price: 18000, platform_fee_pct: 5, fee_percentage: 5 };
      h.state.existing = existing;
      const { container } = render(
        <BidForm mode={mode} claim={claim as never} contractor={contractor as never} existingQuote={existing as never}
          flags={flags} claimRcv={null} userId="u1" />,
      );
      fireEvent.change(priceInput(container), { target: { value: '25000' } });
      // the disclosure and the acceptance line carry the stored rate and its fee
      await waitFor(() => expect(container.textContent).toContain('$1,250.00'));
      expect(container.textContent).toContain('5.00%');
      expect(container.textContent).not.toContain('4.00%');
      expect(container.textContent).not.toContain('$1,000.00');
      expect(feeBox(container).parentElement?.textContent).toContain('$1,250.00');
      fireEvent.click(feeBox(container));
      await waitFor(() => expect(submitBtn(container).disabled).toBe(false));
      fireEvent.click(submitBtn(container));
      await waitFor(() => expect(h.state.updates.length).toBe(1));
      await waitFor(() => expect(container.textContent).toMatch(mode === 'renew' ? /Bid renewed/ : /Bid updated/));
      // the UPDATE sends the stored rate...
      expect(h.state.updates[0].platform_fee_pct).toBe(5);
      expect(h.state.updates[0].total_price).toBe(25000);
      // ...and the fee shown and accepted equals the fee the guard leaves on the row (what docusign-webhook charges)
      expect(h.state.stored[0].fee_amount).toBe(1250);
      // Change Bid / Renew write no fee_acceptances row (the original acceptance stays; the table is append-only)
      expect(h.state.inserts.filter((i) => i.table === 'fee_acceptances').length).toBe(0);
    });

    it('a stored row with platform_fee_pct NULL uses fee_percentage, as the guard does', async () => {
      const existing = { id: 'q-1', bid_status: mode === 'renew' ? 'expired' : 'active', total_price: 18000, platform_fee_pct: null, fee_percentage: 5 };
      h.state.existing = existing;
      const { container } = render(
        <BidForm mode={mode} claim={claim as never} contractor={contractor as never} existingQuote={existing as never}
          flags={flags} claimRcv={null} userId="u1" />,
      );
      fireEvent.change(priceInput(container), { target: { value: '25000' } });
      await waitFor(() => expect(container.textContent).toContain('$1,250.00'));
      fireEvent.click(feeBox(container));
      await waitFor(() => expect(submitBtn(container).disabled).toBe(false));
      fireEvent.click(submitBtn(container));
      await waitFor(() => expect(h.state.updates.length).toBe(1));
      expect(h.state.updates[0].platform_fee_pct).toBe(5);
      expect(h.state.stored[0].fee_amount).toBe(1250);
    });
  });
}

describe('gh-3497: a new bid still reads the configured rate', () => {
  it('configured 4.00: a new bid shows 4.00 (the stored-rate path is only for an existing quote)', async () => {
    const { container } = render(
      <BidForm mode="new" claim={claim as never} contractor={contractor as never} existingQuote={null}
        flags={flags} claimRcv={null} userId="u1" />,
    );
    fireEvent.change(priceInput(container), { target: { value: '25000' } });
    await waitFor(() => expect(container.textContent).toContain('4.00%'));
    expect(container.textContent).toContain('$1,000.00');
    expect(h.state.rpcCalls).toBeGreaterThan(0);
  });
});

describe('gh-3497: storedQuoteFeePct', () => {
  it('reads platform_fee_pct, then fee_percentage (the guard\'s COALESCE order)', () => {
    expect(storedQuoteFeePct({ platform_fee_pct: 5, fee_percentage: 7.5 })).toBe(5);
    expect(storedQuoteFeePct({ platform_fee_pct: '5.00' })).toBe(5);
    expect(storedQuoteFeePct({ platform_fee_pct: null, fee_percentage: '7.50' })).toBe(7.5);
  });
  it('returns null, never a default, when the row has no usable rate', () => {
    for (const q of [null, undefined, {}, { platform_fee_pct: null, fee_percentage: null }, { platform_fee_pct: 'abc' }, { platform_fee_pct: 0 }]) {
      expect(storedQuoteFeePct(q as never)).toBeNull();
    }
  });
});
