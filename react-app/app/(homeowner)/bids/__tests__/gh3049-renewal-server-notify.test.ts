import { describe, it, expect, vi, beforeEach } from 'vitest';

// gh-3049: a homeowner session cannot read contractors.user_id nor insert a notification for
// another user, so requestBidRenewal must hand the lookup + insert to the server-side RPC
// request_bid_renewal(p_quote_id) and never touch the notifications table itself.
const { from, invoke, rpc } = vi.hoisted(() => ({ from: vi.fn(), invoke: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { from, functions: { invoke }, rpc } }));

import { requestBidRenewal } from '../actions';
import type { BidsClaim, ContractorProfile } from '../types';

const claim = { id: 'claim12345678', user_id: 'u', property_address: '1 Main St' } as BidsClaim;
// get_contractors_public shape: NO user_id (private column).
const contractor = { id: 'c', company_name: 'Acme' } as ContractorProfile;

beforeEach(() => {
  from.mockReset(); invoke.mockReset(); rpc.mockReset();
  invoke.mockResolvedValue({ error: null });
});

describe('requestBidRenewal server-side notify (gh-3049)', () => {
  it('homeowner path (no contractor.user_id) calls request_bid_renewal with the quote id and reports notified', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const res = await requestBidRenewal({ claim, contractor, bidId: 'quote-1' });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('request_bid_renewal', { p_quote_id: 'quote-1' });
    expect(res).toEqual({ notifOk: true, emailOk: true });
    expect(invoke.mock.calls[0][1].body.message).toMatch(/has been notified via their dashboard/);
  });

  it('never reads or writes the notifications table from the client', async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await requestBidRenewal({ claim, contractor: { ...contractor, user_id: 'leaked-user-id' }, bidId: 'quote-1' });
    expect(from).not.toHaveBeenCalled();
    // and the private id is never sent to the server by the client
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('leaked-user-id');
  });

  it('negative control: RPC refusal (false) or error -> no notification claimed, ops email says so', async () => {
    for (const reply of [{ data: false, error: null }, { data: null, error: { message: 'boom' } }]) {
      rpc.mockResolvedValueOnce(reply);
      invoke.mockClear();
      const res = await requestBidRenewal({ claim, contractor, bidId: 'quote-9' });
      expect(res.notifOk).toBe(false);
      const msg: string = invoke.mock.calls[0][1].body.message;
      expect(msg).toMatch(/No dashboard notification was sent/);
      expect(msg).not.toMatch(/has been notified/);
    }
  });

  it('RPC throwing is non-fatal; the ops email still goes out', async () => {
    rpc.mockRejectedValue(new Error('network'));
    const res = await requestBidRenewal({ claim, contractor, bidId: 'quote-1' });
    expect(res).toEqual({ notifOk: false, emailOk: true });
  });
});
