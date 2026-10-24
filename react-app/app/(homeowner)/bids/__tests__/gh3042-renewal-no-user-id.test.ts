import { describe, it, expect, vi, beforeEach } from 'vitest';

// gh-3042: contractors now come from get_contractors_public(), which omits the private
// user_id. The dashboard notification therefore cannot be sent from a homeowner session
// (same as static bids.html); the ops email must say so rather than claim a notification.
const { from, invoke } = vi.hoisted(() => ({ from: vi.fn(), invoke: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { from, functions: { invoke }, rpc: vi.fn().mockResolvedValue({ data: false, error: null }) } }));

import { requestBidRenewal } from '../actions';
import type { BidsClaim, ContractorProfile } from '../types';

const claim = { id: 'claim12345678', user_id: 'u', property_address: '1 Main St' } as BidsClaim;

beforeEach(() => { from.mockReset(); invoke.mockReset(); invoke.mockResolvedValue({ error: null }); });

describe('requestBidRenewal without contractor.user_id', () => {
  it('never inserts from the client, still emails ops when the server notification is refused, and does not claim a notification', async () => {
    const res = await requestBidRenewal({ claim, contractor: { id: 'c', company_name: 'Acme' } as ContractorProfile, bidId: 'b1' });
    expect(from).not.toHaveBeenCalled();
    expect(res).toEqual({ notifOk: false, emailOk: true });
    const msg: string = invoke.mock.calls[0][1].body.message;
    expect(msg).toMatch(/No dashboard notification was sent/);
    expect(msg).not.toMatch(/has been notified/);
  });
});
