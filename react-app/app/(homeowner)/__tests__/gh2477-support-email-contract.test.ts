/**
 * gh-2477 -- contract test for the two React callers of send-support-email.
 * Runs the REAL requestBidRenewal functions (only the supabase singleton is mocked) and hands
 * the body each one passes to functions.invoke('send-support-email', ...) to the function's own
 * validator (validatePayload in supabase/functions/send-support-email/caller-gate.ts).
 * On main both bodies were rejected (400): bids/actions.ts sent {subject, message};
 * use-contract-signing-data.ts sent {subject, body}.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));

import { supabase } from '@/lib/supabase';
import { requestBidRenewal as bidsRenewal } from '../bids/actions';
import { requestBidRenewal as signingRenewal } from '../contract-signing/use-contract-signing-data';
import { validatePayload } from '../../../../supabase/functions/send-support-email/caller-gate';

const sb = supabase as any;

function supportBody(): unknown {
  const call = sb.functions.invoke.mock.calls.find((c: unknown[]) => c[0] === 'send-support-email');
  expect(call).toBeDefined();
  return call[1].body;
}

beforeEach(() => {
  vi.clearAllMocks();
  sb.from.mockImplementation(() => ({ insert: async () => ({ error: null }) }));
  sb.functions.invoke.mockResolvedValue({ data: {}, error: null });
});

describe('gh-2477 send-support-email callers send what the function validates', () => {
  it('bids/actions.ts requestBidRenewal', async () => {
    await bidsRenewal({
      claim: { id: 'abcdef1234567890', property_address: '1 Main St' } as never,
      contractor: { user_id: 'cu1', company_name: 'Acme Roofing' } as never,
      bidId: 'q-1',
    });
    const body = supportBody() as Record<string, unknown>;
    const r = validatePayload(body);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(Object.keys(body).sort()).toEqual(['from_email', 'from_name', 'message', 'subject']);
  });

  it('bids/actions.ts: a newline in user-sourced subject data is sanitised, not refused', async () => {
    await bidsRenewal({
      claim: { id: 'abcdef1234567890', property_address: '1 Main\nSt' } as never,
      contractor: { user_id: 'cu1', company_name: 'Acme\r\nBcc: evil@example.com' } as never,
      bidId: 'q-1',
    });
    const r = validatePayload(supportBody());
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('use-contract-signing-data.ts requestBidRenewal', async () => {
    await signingRenewal({
      bidId: 'q-1',
      contractor: { user_id: 'cu1', company_name: 'Acme Roofing' } as never,
      claim: { id: 'c1', property_address: '1 Main St' } as never,
      claimId: 'c1',
    });
    const body = supportBody() as Record<string, unknown>;
    const r = validatePayload(body);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(Object.keys(body).sort()).toEqual(['from_email', 'from_name', 'message', 'subject']);
  });

  it('use-contract-signing-data.ts: a newline in the company name is sanitised, not refused', async () => {
    await signingRenewal({
      bidId: 'q-1',
      contractor: { user_id: 'cu1', company_name: 'Acme\nBcc: evil@example.com' } as never,
      claim: { id: 'c1', property_address: '1 Main St' } as never,
      claimId: 'c1',
    });
    const r = validatePayload(supportBody());
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});
