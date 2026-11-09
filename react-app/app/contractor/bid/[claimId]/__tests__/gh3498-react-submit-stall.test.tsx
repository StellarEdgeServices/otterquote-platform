// gh-3498 (REVIEW 6675274132): a stalled bid_can_submit or quote insert ends with a message and an unlocked form, and a retry
// after an insert that landed but timed out files no second bid (idempotency key + read-back on the unique violation).
// The real BidForm is mounted; only the Supabase client is faked. An aborted request rejects, as fetch does.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => {
  const state = {
    gate: 'ok' as 'ok' | 'hang',
    insert: 'ok' as 'ok' | 'hang' | 'land_then_hang' | 'nocolumn',
    rows: [] as Array<Record<string, unknown>>,
    keyed: [] as string[],
    aborted: 0,
    readbacks: 0,
    feeAcceptances: 0,
    hang: [] as string[], // calls that never answer: 'table:op' or 'fn:name'
    hung: 0,
    updates: 0,
    lookups: 0, // gh-3498: quotes lookups by (claim_id, contractor_id), the page-load query a retry repeats
    hideFromLookup: false, // a landed row the lookup does not see yet (an insert that lands after the lookup)
    noColumn: false, // the idempotency_key column does not exist yet (migration not applied)
  };
  const hang = (signal: AbortSignal | null) => new Promise((_, rej) => {
    signal?.addEventListener('abort', () => { state.aborted++; rej(signal.reason); });
  });
  function builder(table: string) {
    const s: { op: string; payload: Record<string, unknown> | null; eqs: Array<[string, unknown]>; signal: AbortSignal | null } =
      { op: 'select', payload: null, eqs: [], signal: null };
    const b: Record<string, unknown> = {};
    for (const k of ['select', 'order', 'or', 'limit', 'single', 'maybeSingle']) b[k] = () => b;
    b.update = (p: Record<string, unknown>) => { s.op = 'update'; s.payload = p; return b; };
    b.eq = (c: string, v: unknown) => { s.eqs.push([c, v]); return b; };
    b.abortSignal = (sig: AbortSignal) => { s.signal = sig; return b; };
    b.insert = (p: Record<string, unknown>) => { s.op = 'insert'; s.payload = p; return b; };
    const run = async (): Promise<unknown> => {
      if (state.hang.includes(`${table}:${s.op}`)) { state.hung++; return hang(s.signal); }
      if (table === 'quotes' && s.op === 'update') { state.updates++; return { data: [{ id: 'q-1' }], error: null }; }
      if (table === 'quotes' && s.op === 'insert') {
        const key = s.payload!.idempotency_key as string | undefined;
        if (key) state.keyed.push(key);
        if ((state.insert === 'nocolumn' || state.noColumn) && key) return { data: null, error: { code: 'PGRST204', message: "Could not find the 'idempotency_key' column of 'quotes' in the schema cache" } };
        if (key && state.rows.some((r) => r.idempotency_key === key)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "quotes_idempotency_key_uidx"' } };
        }
        if (state.insert === 'hang') return hang(s.signal);
        const row = { id: `quote-${state.rows.length + 1}`, ...s.payload };
        state.rows.push(row);
        if (state.insert === 'land_then_hang') return hang(s.signal);
        return { data: row, error: null };
      }
      if (table === 'quotes' && s.eqs.some(([c]) => c === 'idempotency_key')) {
        state.readbacks++;
        const k = s.eqs.find(([c]) => c === 'idempotency_key')![1];
        return { data: state.rows.find((r) => r.idempotency_key === k) ?? null, error: null };
      }
      if (table === 'quotes' && s.eqs.some(([c]) => c === 'claim_id')) {
        state.lookups++;
        if (state.hideFromLookup) return { data: null, error: null };
        const cid = s.eqs.find(([c]) => c === 'claim_id')![1];
        const ctr = s.eqs.find(([c]) => c === 'contractor_id')?.[1];
        return { data: state.rows.find((r) => r.claim_id === cid && r.contractor_id === ctr) ?? null, error: null };
      }
      if (table === 'fee_acceptances') { state.feeAcceptances++; return { data: { id: 'fa-1' }, error: null }; }
      if (table === 'platform_fee_config') return { data: [{ fee_pct: 5 }], error: null };
      return { data: [], error: null };
    };
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run().then(res, rej);
    return b;
  }
  const supabase = {
    from: (t: string) => builder(t),
    rpc: () => {
      let signal: AbortSignal | null = null;
      const p: Record<string, unknown> = {
        abortSignal: (sig: AbortSignal) => { signal = sig; return p; },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          (state.gate === 'hang' ? hang(signal) : Promise.resolve({ data: { can_submit: true }, error: null })).then(res, rej),
      };
      return p;
    },
    functions: {
      invoke: async (name: string, o?: { signal?: AbortSignal }) => {
        if (state.hang.includes(`fn:${name}`)) { state.hung++; return hang(o?.signal ?? null); }
        return { data: null, error: null };
      },
    },
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
const mount = () => render(<BidForm mode="new" claim={claim as never} contractor={contractor as never} existingQuote={null} flags={flags} claimRcv={null} userId="u1" />);
const priceInput = (c: HTMLElement) => c.querySelector('.oqb-money input') as HTMLInputElement;
const feeBox = (c: HTMLElement) => Array.from(c.querySelectorAll('input[type="checkbox"]'))
  .find((el) => /platform fee/.test(el.parentElement?.textContent || '')) as HTMLInputElement;
const submitBtn = (c: HTMLElement) => Array.from(c.querySelectorAll('button')).find((b) => /Submit|Submitting|Update Bid/.test(b.textContent || '')) as HTMLButtonElement;

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => {
  cleanup(); vi.useRealTimers();
  Object.assign(h.state, { gate: 'ok', insert: 'ok', aborted: 0, readbacks: 0, feeAcceptances: 0, hung: 0, updates: 0, lookups: 0, hideFromLookup: false, noColumn: false });
  h.state.hang.length = 0;
  sentry.captureException.mockClear(); sentry.captureMessage.mockClear();
  h.state.rows.length = 0; h.state.keyed.length = 0;
});

async function ready(c: HTMLElement) {
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  fireEvent.change(priceInput(c), { target: { value: '18500' } });
  fireEvent.click(feeBox(c));
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('gh-3498 React bid form: stalled submit', () => {
  it('control: nothing hung, one bid is filed', async () => {
    const { container } = mount();
    await ready(container);
    await act(async () => { fireEvent.click(submitBtn(container)); await vi.advanceTimersByTimeAsync(4000); });
    expect(h.state.rows.length).toBe(1);
    expect(container.textContent).toContain('Bid submitted');
  });

  it('a bid_can_submit that never answers ends with the existing network-error message and an unlocked form', async () => {
    h.state.gate = 'hang';
    const { container } = mount();
    await ready(container);
    await act(async () => { fireEvent.click(submitBtn(container)); await vi.advanceTimersByTimeAsync(4000); });
    expect(submitBtn(container).textContent).toMatch(/Submitting/);
    await advance(11_000);
    expect(container.textContent).toContain('Network error verifying contract template. Please retry.');
    expect(submitBtn(container).textContent).not.toMatch(/Submitting/);
    expect(feeBox(container).disabled).toBe(false);
    expect(h.state.aborted).toBe(1);
    expect(h.state.rows.length).toBe(0);
  });

  it('a quote insert that never answers ends with the existing error prefix and an unlocked form', async () => {
    h.state.insert = 'hang';
    const { container } = mount();
    await ready(container);
    await act(async () => { fireEvent.click(submitBtn(container)); await vi.advanceTimersByTimeAsync(4000); });
    await advance(21_000);
    expect(container.textContent).toContain('Error submitting bid: ');
    expect(submitBtn(container).textContent).not.toMatch(/Submitting/);
    expect(feeBox(container).disabled).toBe(false);
    expect(h.state.aborted).toBe(1);
  });

  it('a retry after an insert that landed but timed out files no second bid and reads the first back as success', async () => {
    h.state.insert = 'land_then_hang';
    const { container } = mount();
    await ready(container);
    await act(async () => { fireEvent.click(submitBtn(container)); await vi.advanceTimersByTimeAsync(4000); });
    await advance(21_000);
    expect(container.textContent).toContain('Error submitting bid: ');
    expect(h.state.rows.length).toBe(1);

    h.state.insert = 'ok';
    if (!feeBox(container).checked) fireEvent.click(feeBox(container));
    await act(async () => { fireEvent.click(submitBtn(container)); await vi.advanceTimersByTimeAsync(4000); });
    expect(container.textContent).toContain('Bid submitted');
    expect(h.state.rows.length).toBe(1);
    // gh-3498 (REVIEW 6740720167): the retry finds the landed bid by (claim, contractor) before inserting, so no second insert is sent
    expect(h.state.lookups).toBe(1);
    expect(h.state.keyed.length).toBe(1);
    expect(h.state.feeAcceptances).toBe(1); // the earlier attempt died before its acceptance: written once, now
  });

  // -- REVIEW 6740720167 finding 2: a retry after a landed-but-timed-out insert can never file a second bid, and never shows
  // success over terms other than the ones on file. A retry with other content gets the filed bid back as Change Bid. --
  async function landThenTimeOut(c: HTMLElement) {
    h.state.insert = 'land_then_hang';
    await act(async () => { fireEvent.click(submitBtn(c)); await vi.advanceTimersByTimeAsync(4000); });
    await advance(21_000);
    expect(c.textContent).toContain('Error submitting bid: ');
    expect(h.state.rows.length).toBe(1);
    h.state.insert = 'ok';
  }
  async function retry(c: HTMLElement) {
    if (!feeBox(c).checked) fireEvent.click(feeBox(c));
    await act(async () => { fireEvent.click(submitBtn(c)); await vi.advanceTimersByTimeAsync(4000); });
  }
  const isChangeBid = (c: HTMLElement) => /You are editing your existing bid/.test(c.textContent || '') && /Update Bid/.test(submitBtn(c).textContent || '');

  it('finding 2: a price changed after an insert landed and timed out files NO second bid; the filed bid comes back as Change Bid', async () => {
    const { container } = mount();
    await ready(container);
    await landThenTimeOut(container);
    fireEvent.change(priceInput(container), { target: { value: '19000' } });
    await advance(4000);
    await retry(container);
    expect(h.state.rows.length).toBe(1);
    expect(h.state.rows[0].total_price).toBe(18500);
    expect(container.textContent).not.toContain('Bid submitted');
    expect(container.textContent).toContain('Your bid was already filed on an earlier try, so no second bid was sent.');
    expect(isChangeBid(container)).toBe(true);
    expect(priceInput(container).value).toBe('18500'); // the figures on file, not the unsent edit
    expect(submitBtn(container).textContent).not.toMatch(/Submitting/);
    expect(h.state.feeAcceptances).toBe(0);
  });

  it('finding 2: another field changed after an insert landed and timed out shows no success over the old terms', async () => {
    const { container } = mount();
    await ready(container);
    await landThenTimeOut(container);
    const msg = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(msg, { target: { value: 'Different message on the retry' } });
    await retry(container);
    expect(h.state.rows.length).toBe(1);
    expect(container.textContent).not.toContain('Bid submitted');
    expect(container.textContent).toContain('Your bid was already filed on an earlier try');
    expect(isChangeBid(container)).toBe(true);
  });

  it('finding 2: a different-price retry whose first insert lands only after the lookup is refused by the same key', async () => {
    const { container } = mount();
    await ready(container);
    await landThenTimeOut(container);
    h.state.hideFromLookup = true;
    fireEvent.change(priceInput(container), { target: { value: '19000' } });
    await advance(4000);
    await retry(container);
    expect(h.state.keyed.length).toBe(2);
    expect(h.state.keyed[0]).toBe(h.state.keyed[1]); // the key no longer changes with the price
    expect(h.state.readbacks).toBe(1);
    expect(h.state.rows.length).toBe(1);
    expect(container.textContent).not.toContain('Bid submitted');
    expect(isChangeBid(container)).toBe(true);
  });

  it('a same-content retry whose first insert lands only after the lookup reads the filed row back as success', async () => {
    const { container } = mount();
    await ready(container);
    await landThenTimeOut(container);
    h.state.hideFromLookup = true;
    await retry(container);
    expect(h.state.keyed[0]).toBe(h.state.keyed[1]);
    expect(h.state.readbacks).toBe(1);
    expect(h.state.rows.length).toBe(1);
    expect(container.textContent).toContain('Bid submitted');
    expect(h.state.feeAcceptances).toBe(1);
  });

  it('finding 3: without the key column, a retry after an insert that landed and timed out still files no second bid', async () => {
    h.state.noColumn = true;
    const { container } = mount();
    await ready(container);
    await landThenTimeOut(container);
    expect(h.state.rows[0].idempotency_key).toBeUndefined();
    await retry(container);
    expect(h.state.rows.length).toBe(1);
    expect(container.textContent).toContain('Bid submitted');
  });

  it('a database without the column yet: the bid is filed as before, without a key', async () => {
    h.state.insert = 'nocolumn';
    const { container } = mount();
    await ready(container);
    await act(async () => { fireEvent.click(submitBtn(container)); await vi.advanceTimersByTimeAsync(4000); });
    expect(h.state.rows.length).toBe(1);
    expect(h.state.rows[0].idempotency_key).toBeUndefined();
    expect(container.textContent).toContain('Bid submitted');
  });

  // ── Widened closes-on (Marty, REVIEW 6688103147): every await between the submit lock and its finally ──
  const existing = { id: 'q-1', bid_status: 'active', renewals_count: 0, total_price: 18000 };
  const mountChange = () => render(<BidForm mode="change" claim={claim as never} contractor={contractor as never} existingQuote={existing as never} flags={flags} claimRcv={null} userId="u1" />);

  for (const call of ['fee_acceptances:insert', 'fn:send-bid-confirmation']) {
    it(`new bid: ${call} that never answers ends on the success screen (the bid is already filed), once`, async () => {
      const { container } = mount();
      await ready(container);
      h.state.hang.push(call);
      await act(async () => { fireEvent.click(submitBtn(container)); await vi.advanceTimersByTimeAsync(4000); });
      expect(h.state.hung).toBeGreaterThan(0);
      expect(container.textContent).not.toContain('Bid submitted');
      await advance(9_000);
      expect(container.textContent).toContain('Bid submitted');
      expect(container.textContent).not.toContain('Error submitting bid');
      expect(h.state.rows.length).toBe(1);
      expect(h.state.aborted).toBe(1);
      if (call === 'fee_acceptances:insert') { // a lost D-215 acceptance must leave a trace (REVIEW 6692292671)
        expect(sentry.captureException).toHaveBeenCalledTimes(1);
        expect(sentry.captureException.mock.calls[0][1]).toEqual({ extra: { bid_id: 'quote-1', claim_id: 'claim-1', contractor_id: 'c1' } });
      }
    });
  }

  it('change bid: the quotes UPDATE that never answers ends with a message and an unlocked form, and a retry updates once', async () => {
    const { container } = mountChange();
    await ready(container);
    h.state.hang.push('quotes:update');
    await act(async () => { fireEvent.click(submitBtn(container)); await vi.advanceTimersByTimeAsync(4000); });
    expect(h.state.hung).toBeGreaterThan(0);
    await advance(16_000);
    expect(container.textContent).toContain('Error submitting bid: ');
    expect(submitBtn(container).textContent).not.toMatch(/Submitting/);
    expect(feeBox(container).disabled).toBe(false);
    h.state.hang.length = 0;
    if (!feeBox(container).checked) fireEvent.click(feeBox(container));
    await act(async () => { fireEvent.click(submitBtn(container)); await vi.advanceTimersByTimeAsync(4000); });
    expect(container.textContent).toContain('Bid updated');
    expect(h.state.updates).toBe(1);
  });

  for (const call of ['notifications:insert', 'activity_log:insert', 'fn:notify-contractors']) {
    it(`change bid: ${call} that never answers ends on the success screen (the update is already saved)`, async () => {
      const { container } = mountChange();
      await ready(container);
      h.state.hang.push(call);
      await act(async () => { fireEvent.click(submitBtn(container)); await vi.advanceTimersByTimeAsync(4000); });
      expect(h.state.hung).toBeGreaterThan(0);
      await advance(9_000);
      expect(container.textContent).toContain('Bid updated');
      expect(container.textContent).not.toContain('Error submitting bid');
      expect(h.state.updates).toBe(1);
      expect(h.state.aborted).toBe(1);
    });
  }
});
