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
 *   • sendContractorNudge asks the send-contractor-nudge EF to text the
 *     contractor (server-side consent lookup) and Dustin's alert line.
 *     gh-1916 RETURNED 5856782745 (Marty, CTO RUN 44) / D-328.
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
  // gh-2105 batch 4: the update chain now ends in `.select('id')` (decision a
  // -- detect a zero-row RLS/filter match instead of trusting `error: null`),
  // so the mock's terminal call is `.select`, not `.eq`; `rows` controls what
  // the update is made to "return" so both the row-written and zero-row
  // paths can be exercised.
  function wireQuotesUpdate(rows: Array<{ id: string }> | null = [{ id: 'q1' }]) {
    const rec: { payload: unknown; eqs: [string, unknown][]; selectCol: string | null } = {
      payload: null,
      eqs: [],
      selectCol: null,
    };
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
          chain.select = (col: string) => {
            rec.selectCol = col;
            return Promise.resolve({ data: rows, error: null });
          };
          return chain;
        },
      };
    });
    return rec;
  }

  it('writes homeowner_signed_at keyed on the quote id and returns true on a row-written match', async () => {
    const rec = wireQuotesUpdate([{ id: 'q1' }]);
    const ok = await recordHomeownerSigned({
      claimId: 'c1',
      quoteId: 'q1',
      contractorId: 'ctr1',
      signedAt: '2026-06-23T00:00:00.000Z',
    });
    expect(ok).toBe(true);
    expect(rec.payload).toEqual({ homeowner_signed_at: '2026-06-23T00:00:00.000Z' });
    expect(rec.eqs).toEqual([['id', 'q1']]);
    expect(rec.selectCol).toBe('id');
  });

  it('falls back to claim_id + contractor_id when no quote id is known', async () => {
    const rec = wireQuotesUpdate([{ id: 'q1' }]);
    const ok = await recordHomeownerSigned({
      claimId: 'c1',
      quoteId: null,
      contractorId: 'ctr1',
      signedAt: '2026-06-23T00:00:00.000Z',
    });
    expect(ok).toBe(true);
    expect(rec.payload).toEqual({ homeowner_signed_at: '2026-06-23T00:00:00.000Z' });
    expect(rec.eqs).toEqual([
      ['claim_id', 'c1'],
      ['contractor_id', 'ctr1'],
    ]);
  });

  it('no-ops (no write) when neither quote id nor contractor id is known', async () => {
    wireQuotesUpdate();
    const ok = await recordHomeownerSigned({ claimId: 'c1', quoteId: null, contractorId: null, signedAt: 'x' });
    expect(ok).toBe(true);
    expect(sb.from).not.toHaveBeenCalled();
  });

  // gh-2105 batch 4 mandatory negative control (mirrors the #2103/batch-1
  // pattern): before the fix, `.update()` with no `.select()` resolved
  // `{ error: null }` on a zero-row RLS/filter match and this function
  // returned `true` even though `quotes.homeowner_signed_at` was never
  // written. After the fix, a zero-row match returns `false`.
  it('gh-2105 negative control: returns false (not true) when the quote-id update matches zero rows', async () => {
    wireQuotesUpdate([]);
    const ok = await recordHomeownerSigned({
      claimId: 'c1',
      quoteId: 'q1',
      contractorId: 'ctr1',
      signedAt: '2026-06-23T00:00:00.000Z',
    });
    expect(ok).toBe(false);
  });

  it('gh-2105 negative control: returns false (not true) when the claim_id+contractor_id update matches zero rows', async () => {
    wireQuotesUpdate([]);
    const ok = await recordHomeownerSigned({
      claimId: 'c1',
      quoteId: null,
      contractorId: 'ctr1',
      signedAt: '2026-06-23T00:00:00.000Z',
    });
    expect(ok).toBe(false);
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
