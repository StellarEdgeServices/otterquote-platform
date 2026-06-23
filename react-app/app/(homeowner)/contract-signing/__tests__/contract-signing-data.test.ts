/**
 * Unit tests for the homeowner contract-signing data layer (H3, PR 2/2).
 * Mocks ONLY the supabase singleton — the data layer under test is the real thing.
 *
 * Covers the brief's self-verify assertions for the impure layer:
 *   • createHomeownerEnvelope sends the create-docusign-envelope body that equals
 *     the (PR1, tested) pure buildHomeownerEnvelopeRequest — INCLUDING the React-
 *     route return_url — and returns its signing_url.
 *   • recordHomeownerSigned writes quotes.homeowner_signed_at (quote-id path) and
 *     uses the claim_id+contractor_id fallback when no quote id is known.
 *   • buildProjectConfirmationUrl targets the static project-confirmation page.
 *   • sendContractorNudge SMSes the contractor + the hardcoded Dustin number.
 *   • requestBidRenewal notifies the contractor + emails support.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}));

import { supabase } from '@/lib/supabase';
import { buildHomeownerEnvelopeRequest } from '../utils';
import {
  NUDGE_DUSTIN_PHONE,
  buildProjectConfirmationUrl,
  createHomeownerEnvelope,
  recordHomeownerSigned,
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

describe('recordHomeownerSigned', () => {
  function wireQuotesUpdate() {
    const rec: { payload: unknown; eqs: [string, unknown][] } = { payload: null, eqs: [] };
    sb.from.mockImplementation((table: string) => {
      if (table !== 'quotes') return {};
      return {
        update: (payload: unknown) => {
          rec.payload = payload;
          const chain: Record<string, unknown> = {};
          chain.eq = (col: string, val: unknown) => {
            rec.eqs.push([col, val]);
            return chain;
          };
          (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ error: null }).then(resolve);
          return chain;
        },
      };
    });
    return rec;
  }

  it('writes homeowner_signed_at keyed on the quote id', async () => {
    const rec = wireQuotesUpdate();
    await recordHomeownerSigned({
      claimId: 'c1',
      quoteId: 'q1',
      contractorId: 'ctr1',
      signedAt: '2026-06-23T00:00:00.000Z',
    });
    expect(rec.payload).toEqual({ homeowner_signed_at: '2026-06-23T00:00:00.000Z' });
    expect(rec.eqs).toEqual([['id', 'q1']]);
  });

  it('falls back to claim_id + contractor_id when no quote id is known', async () => {
    const rec = wireQuotesUpdate();
    await recordHomeownerSigned({
      claimId: 'c1',
      quoteId: null,
      contractorId: 'ctr1',
      signedAt: '2026-06-23T00:00:00.000Z',
    });
    expect(rec.payload).toEqual({ homeowner_signed_at: '2026-06-23T00:00:00.000Z' });
    expect(rec.eqs).toEqual([
      ['claim_id', 'c1'],
      ['contractor_id', 'ctr1'],
    ]);
  });

  it('no-ops (no write) when neither quote id nor contractor id is known', async () => {
    wireQuotesUpdate();
    await recordHomeownerSigned({ claimId: 'c1', quoteId: null, contractorId: null, signedAt: 'x' });
    expect(sb.from).not.toHaveBeenCalled();
  });
});

describe('buildProjectConfirmationUrl', () => {
  it('targets the static project-confirmation page (coexistence — React route is Phase 26)', () => {
    expect(buildProjectConfirmationUrl('abc-123')).toBe(
      'https://otterquote.com/project-confirmation.html?claim_id=abc-123',
    );
  });
});

describe('sendContractorNudge', () => {
  it('SMSes every contractor number AND the hardcoded Dustin alert line', async () => {
    sb.functions.invoke.mockResolvedValue({ data: {}, error: null });

    const ok = await sendContractorNudge({
      contractor: {
        company_name: 'Acme Roofing',
        phone: '+15551234567',
        notification_phones: ['+15559998888'],
      },
      claim: { id: 'c1', homeowner_name: 'Jane', property_address: '1 Main St', contract_signed_at: null },
      claimId: 'c1',
    });

    expect(ok).toBe(true);
    const smsTos = sb.functions.invoke.mock.calls
      .filter((c: unknown[]) => c[0] === 'send-sms')
      .map((c: [string, { body: { to: string } }]) => c[1].body.to);
    expect(smsTos).toContain('+15559998888');
    expect(smsTos).toContain('+15551234567');
    expect(smsTos).toContain(NUDGE_DUSTIN_PHONE);
    expect(NUDGE_DUSTIN_PHONE).toBe('+13175019215');
  });

  it('still notifies Dustin when the contractor has no phone numbers', async () => {
    sb.functions.invoke.mockResolvedValue({ data: {}, error: null });
    const ok = await sendContractorNudge({
      contractor: { company_name: 'Acme Roofing' },
      claim: { id: 'c1' },
      claimId: 'c1',
    });
    expect(ok).toBe(true);
    const smsTos = sb.functions.invoke.mock.calls
      .filter((c: unknown[]) => c[0] === 'send-sms')
      .map((c: [string, { body: { to: string } }]) => c[1].body.to);
    expect(smsTos).toEqual([NUDGE_DUSTIN_PHONE]);
  });

  it('returns false when a send rejects', async () => {
    sb.functions.invoke.mockRejectedValue(new Error('sms down'));
    const ok = await sendContractorNudge({
      contractor: { company_name: 'Acme' },
      claim: { id: 'c1' },
      claimId: 'c1',
    });
    expect(ok).toBe(false);
  });
});

describe('requestBidRenewal', () => {
  it('inserts a contractor dashboard notification and emails support', async () => {
    const inserts: unknown[] = [];
    sb.from.mockImplementation((table: string) => {
      if (table === 'notifications') {
        return {
          insert: (payload: unknown) => {
            inserts.push(payload);
            return Promise.resolve({ error: null });
          },
        };
      }
      return {};
    });
    sb.functions.invoke.mockResolvedValue({ data: {}, error: null });

    const ok = await requestBidRenewal({
      bidId: 'q-1',
      contractor: { user_id: 'cu1', company_name: 'Acme Roofing' },
      claim: { id: 'c1', property_address: '1 Main St' },
      claimId: 'c1',
    });

    expect(ok).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      user_id: 'cu1',
      notification_type: 'bid_renewal_requested',
      channel: 'dashboard',
    });
    expect(sb.functions.invoke).toHaveBeenCalledWith(
      'send-support-email',
      expect.objectContaining({
        body: expect.objectContaining({ subject: expect.stringContaining('Acme Roofing') }),
      }),
    );
  });

  it('returns true on email-only success when the notification step is skipped (no user_id)', async () => {
    sb.from.mockImplementation(() => ({}));
    sb.functions.invoke.mockResolvedValue({ data: {}, error: null });
    const ok = await requestBidRenewal({
      bidId: 'q-1',
      contractor: { company_name: 'Acme' },
      claim: { id: 'c1' },
      claimId: 'c1',
    });
    expect(ok).toBe(true);
  });
});
