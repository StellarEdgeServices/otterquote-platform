/**
 * Unit tests for the homeowner contract-signing data layer (H3, PR 2/2).
 * Mocks ONLY the supabase singleton — the data layer under test is the real thing.
 *
 * Covers the brief's self-verify assertions for the impure layer:
 *   • createHomeownerEnvelope sends the create-docusign-envelope body that equals
 *     the (PR1, tested) pure buildHomeownerEnvelopeRequest — INCLUDING the React-
 *     route return_url — and returns its signing_url.
 *   • (gh-2864) no recordHomeownerSigned: the stamp is written only by the docusign-webhook.
 *   • buildPostSignUrl targets the dashboard (D-407: no Project Confirmation step).
 *   • sendContractorNudge asks the send-contractor-nudge EF to text the
 *     contractor (server-side consent lookup) and Dustin's alert line.
 *     gh-1916 RETURNED 5856782745 (Marty, CTO RUN 44) / D-328.
 *   • requestBidRenewal notifies the contractor + emails support.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));

import { supabase } from '@/lib/supabase';
import { buildHomeownerEnvelopeRequest } from '../utils';
import {
  buildPostSignUrl,
  createHomeownerEnvelope,
  requestBidRenewal,
  sendContractorNudge,
} from '../use-contract-signing-data';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createHomeownerEnvelope', () => {
  const ARGS = {
    claimId: 'abc-123',
    contractorId: 'ctr-1',
    quoteId: 'q-1',
    signer: { email: 'home@owner.com', name: 'Home Owner' },
    origin: 'https://app.otterquote.com',
  };

  it('invokes create-docusign-envelope with the buildHomeownerEnvelopeRequest body (incl. return_url)', async () => {
    sb.functions.invoke.mockResolvedValue({
      data: { signing_url: 'https://ds/sign?token=x', envelope_id: 'env-1' },
      error: null,
    });

    const res = await createHomeownerEnvelope(ARGS);

    expect(res.signingUrl).toBe('https://ds/sign?token=x');
    expect(sb.functions.invoke).toHaveBeenCalledWith('create-docusign-envelope', {
      body: buildHomeownerEnvelopeRequest(ARGS),
    });
    // Spell out the return_url so the React-route delta is explicitly asserted.
    expect(sb.functions.invoke.mock.calls[0][1].body.return_url).toBe(
      'https://app.otterquote.com/contract-signing?claim_id=abc-123&signed=true',
    );
    expect(sb.functions.invoke.mock.calls[0][1].body.document_type).toBe('homeowner_sign');
  });

  it('throws when the EF returns an error', async () => {
    sb.functions.invoke.mockResolvedValue({
      data: null,
      error: { message: 'contractor must sign first' },
    });
    await expect(createHomeownerEnvelope(ARGS)).rejects.toThrow('contractor must sign first');
  });

  it('throws when no signing_url is returned', async () => {
    sb.functions.invoke.mockResolvedValue({ data: { envelope_id: 'env-1' }, error: null });
    await expect(createHomeownerEnvelope(ARGS)).rejects.toThrow(/signing URL/i);
  });
});

describe('use-contract-signing-data exports (gh-2864)', () => {
  it('has no signature-stamp writer: homeowner_signed_at is platform-only', async () => {
    const mod = await import('../use-contract-signing-data');
    expect('recordHomeownerSigned' in mod).toBe(false);
  });
});

describe('buildPostSignUrl', () => {
  it('targets the dashboard, never a Project Confirmation page (D-407)', () => {
    expect(buildPostSignUrl()).toBe('https://otterquote.com/dashboard.html');
    expect(buildPostSignUrl()).not.toMatch(/project-confirmation/);
  });
});

describe('sendContractorNudge', () => {
  // gh-1916 RETURNED 5856782745 (Marty, CTO RUN 44) / D-328: this no longer
  // builds SMS text or takes the contractor/claim rows — the phone number
  // and consent lookup happen entirely inside send-contractor-nudge, which
  // this client never sees the outcome of beyond "did the call succeed".

  it('invokes send-contractor-nudge with the claim + contractor ids', async () => {
    sb.functions.invoke.mockResolvedValue({ data: { ok: true }, error: null });

    const ok = await sendContractorNudge({ claimId: 'c1', contractorId: 'ctr-1' });

    expect(ok).toBe(true);
    expect(sb.functions.invoke).toHaveBeenCalledWith('send-contractor-nudge', {
      body: { claim_id: 'c1', contractor_id: 'ctr-1' },
    });
  });

  it('never passes a phone number or consent field — the EF looks those up itself', async () => {
    sb.functions.invoke.mockResolvedValue({ data: { ok: true }, error: null });
    await sendContractorNudge({ claimId: 'c1', contractorId: 'ctr-1' });
    const [, invokeArgs] = sb.functions.invoke.mock.calls[0];
    expect(invokeArgs.body).toEqual({ claim_id: 'c1', contractor_id: 'ctr-1' });
    expect(JSON.stringify(invokeArgs.body)).not.toMatch(/phone|sms_opt_in|consent/i);
  });

  it('returns false when the EF call returns an error', async () => {
    sb.functions.invoke.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const ok = await sendContractorNudge({ claimId: 'c1', contractorId: 'ctr-1' });
    expect(ok).toBe(false);
  });

  it('returns false when the EF call rejects', async () => {
    sb.functions.invoke.mockRejectedValue(new Error('network down'));
    const ok = await sendContractorNudge({ claimId: 'c1', contractorId: null });
    expect(ok).toBe(false);
  });
});

describe('requestBidRenewal', () => {
  const ARGS = {
    bidId: 'q-1',
    contractor: { user_id: 'cu1', company_name: 'Acme Roofing' },
    claim: { id: 'c1', property_address: '1 Main St' },
    claimId: 'c1',
  };

  it('notifies the contractor via the request_bid_renewal RPC (never a client notifications insert) and emails support', async () => {
    sb.rpc.mockResolvedValue({ data: true, error: null });
    sb.functions.invoke.mockResolvedValue({ data: {}, error: null });

    const ok = await requestBidRenewal(ARGS);

    expect(ok).toBe(true);
    expect(sb.rpc).toHaveBeenCalledWith('request_bid_renewal', { p_quote_id: 'q-1' });
    // gh-3049: production RLS refuses a homeowner inserting a notification for another user.
    expect(sb.from).not.toHaveBeenCalled();
    // the contractor's private user_id is never sent
    expect(JSON.stringify(sb.rpc.mock.calls)).not.toContain('cu1');
    expect(sb.functions.invoke).toHaveBeenCalledWith(
      'send-support-email',
      expect.objectContaining({
        body: expect.objectContaining({ subject: expect.stringContaining('Acme Roofing') }),
      }),
    );
  });

  it('still emails support (safe fallback) when the RPC is not yet applied', async () => {
    sb.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not found' } });
    sb.functions.invoke.mockResolvedValue({ data: {}, error: null });
    const ok = await requestBidRenewal(ARGS);
    expect(ok).toBe(true);
    expect(sb.from).not.toHaveBeenCalled();
    expect(sb.functions.invoke).toHaveBeenCalledWith('send-support-email', expect.anything());
  });

  it('still emails support when the RPC throws', async () => {
    sb.rpc.mockRejectedValue(new Error('network down'));
    sb.functions.invoke.mockResolvedValue({ data: {}, error: null });
    expect(await requestBidRenewal(ARGS)).toBe(true);
  });

  it('returns false when the RPC returns false and the support email fails', async () => {
    sb.rpc.mockResolvedValue({ data: false, error: null });
    sb.functions.invoke.mockResolvedValue({ data: null, error: new Error('boom') });
    expect(await requestBidRenewal(ARGS)).toBe(false);
  });

  it('returns true on RPC-only success when the support email fails', async () => {
    sb.rpc.mockResolvedValue({ data: true, error: null });
    sb.functions.invoke.mockResolvedValue({ data: null, error: new Error('boom') });
    expect(await requestBidRenewal(ARGS)).toBe(true);
  });
});
