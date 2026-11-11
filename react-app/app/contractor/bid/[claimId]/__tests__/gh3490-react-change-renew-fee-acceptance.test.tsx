// gh-3490 (Ben, ruling 6740655614, option A): the fee text says submitting "constitutes your acceptance", so a changed or
// renewed bid writes its own fee_acceptances row for the bid it updated. The real BidForm is mounted; only Supabase is faked.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';

const h = vi.hoisted(() => {
  const state = {
    feeInserts: [] as Array<Record<string, unknown>>,
    feeResult: 'recorded' as 'recorded' | 'diverted' | 'error',
    updates: 0,
    quoteInserts: 0,
  };
  function builder(table: string) {
    const s: { op: string; payload: Record<string, unknown> | null } = { op: 'select', payload: null };
    const b: Record<string, unknown> = {};
    for (const k of ['select', 'order', 'or', 'limit', 'single', 'maybeSingle', 'eq', 'abortSignal']) b[k] = () => b;
    b.update = (p: Record<string, unknown>) => { s.op = 'update'; s.payload = p; return b; };
    b.insert = (p: Record<string, unknown>) => { s.op = 'insert'; s.payload = p; return b; };
    const run = async (): Promise<unknown> => {
      if (table === 'quotes' && s.op === 'update') { state.updates++; return { data: [{ id: 'q-1' }], error: null }; }
      if (table === 'quotes' && s.op === 'insert') { state.quoteInserts++; return { data: { id: 'new-1', ...s.payload }, error: null }; }
      if (table === 'fee_acceptances') {
        state.feeInserts.push(s.payload!);
        if (state.feeResult === 'error') return { data: null, error: { code: '42501', message: 'boom' } };
        if (state.feeResult === 'diverted') return { data: [], error: null };
        return { data: [{ id: 'fa-1' }], error: null };
      }
      if (table === 'platform_fee_config') return { data: [{ fee_pct: 5 }], error: null };
      return { data: [], error: null };
    };
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej);
    return b;
  }
  const supabase = {
    from: (t: string) => builder(t),
    rpc: () => ({ then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: { can_submit: true }, error: null }).then(res, rej) }),
    functions: { invoke: async () => ({ data: null, error: null }) },
  };
  return { state, supabase };
});

vi.mock('@/lib/supabase', () => ({ supabase: h.supabase }));
const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

import { BidForm } from '../bid-form';

const claim = { id: 'claim-1', trades: ['roofing'], job_type: 'retail', funding_type: 'cash', user_id: 'u1' };
const contractor = { id: 'c1', address_state: 'IN', company_name: 'Acme Roofing' };
const flags = { isRetailJob: true, gutterTradeActive: false, sidingTradeActive: false };
const mountMode = (mode: 'change' | 'renew', status: string) => render(
  <BidForm mode={mode} claim={claim as never} contractor={contractor as never}
    existingQuote={{ id: 'q-1', bid_status: status, total_price: 18000 } as never} flags={flags} claimRcv={null} userId="u1" />);
const priceInput = (c: HTMLElement) => c.querySelector('.oqb-money input') as HTMLInputElement;
const feeBox = (c: HTMLElement) => Array.from(c.querySelectorAll('input[type="checkbox"]'))
  .find((el) => /platform fee/.test(el.parentElement?.textContent || '')) as HTMLInputElement;
const submitBtn = (c: HTMLElement) => Array.from(c.querySelectorAll('button')).find((b) => /Submit|Submitting|Update Bid|Renew Bid/.test(b.textContent || '')) as HTMLButtonElement;

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => {
  cleanup(); vi.useRealTimers();
  Object.assign(h.state, { feeInserts: [], feeResult: 'recorded', updates: 0, quoteInserts: 0 });
  sentry.captureException.mockReset(); sentry.captureMessage.mockReset();
});

async function submitChange(c: HTMLElement) {
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  fireEvent.change(priceInput(c), { target: { value: '18500' } });
  fireEvent.click(feeBox(c));
  await act(async () => { fireEvent.click(submitBtn(c)); await vi.advanceTimersByTimeAsync(4000); });
}

describe('gh-3490 React bid form: a changed or renewed bid records its own acceptance', () => {
  for (const [mode, status, done] of [['change', 'active', 'Bid updated'], ['renew', 'expired', 'Bid renewed']] as const) {
    it(`${mode}: one fee_acceptances row for the updated bid, same shape as a first-time bid, and the update still lands`, async () => {
      const { container } = mountMode(mode, status);
      await submitChange(container);
      expect(container.textContent).toContain(done);
      expect(h.state.updates).toBe(1);
      expect(h.state.quoteInserts).toBe(0); // update, not a second bid
      expect(h.state.feeInserts).toHaveLength(1);
      const row = h.state.feeInserts[0];
      expect(row).toMatchObject({ contractor_id: 'c1', claim_id: 'claim-1', bid_id: 'q-1', fee_pct: 5, fee_basis: 'bid_amount', fee_amount: 925 });
      expect(Object.keys(row).sort()).toEqual(['accepted_at', 'bid_id', 'claim_id', 'contractor_id', 'fee_amount', 'fee_basis', 'fee_pct', 'fee_text_displayed', 'ip_address', 'user_agent']);
      expect(String(row.fee_text_displayed)).toContain('$925.00');
      expect(sentry.captureMessage).not.toHaveBeenCalled();
    });
  }

  it('a failed acceptance write is non-fatal (the update is saved) and leaves a Sentry trace; it is not retried', async () => {
    h.state.feeResult = 'error';
    const { container } = mountMode('change', 'active');
    await submitChange(container);
    expect(container.textContent).toContain('Bid updated');
    expect(container.textContent).not.toContain('Error submitting bid');
    expect(h.state.feeInserts).toHaveLength(1);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('an acceptance kept for review (zero rows returned) is non-fatal and warned about', async () => {
    h.state.feeResult = 'diverted';
    const { container } = mountMode('change', 'active');
    await submitChange(container);
    expect(container.textContent).toContain('Bid updated');
    expect(h.state.feeInserts).toHaveLength(1);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
  });
});
