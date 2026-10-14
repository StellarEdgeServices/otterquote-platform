/**
 * gh-2105 batch 4 -- BEHAVIOUR tests for the four importable TS modules, fed a mocked zero-row
 * (`{data: [], error: null}`) or error result. Complements gh2105-batch4-static-zero-row.test.ts
 * (source-text checks for the static pages, which have no harness).
 *
 *  - help-estimate/actions.ts, use-help-measurements-data.ts: report-only. A zero-row / error
 *    writeback sends a Sentry event, the flow continues (email still sent), nothing throws.
 *  - use-repair-intake-data.ts: status='submitted' is the user's actual submit. Zero rows / error
 *    -> Sentry event AND throw, so the page's existing error UI shows and Submit re-enables.
 *  - partner-record.ts: class (c), unreachable under RLS; the defensive guard must never report
 *    the record as linked unless a row came back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';

const sendAdjusterEmailMock = vi.fn();
const findOrCreateAdjusterMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getUser: vi.fn() }, from: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock('@/lib/services', () => ({
  Services: {
    sendAdjusterEmail: (...a: unknown[]) => sendAdjusterEmailMock(...a),
    findOrCreateAdjuster: (...a: unknown[]) => findOrCreateAdjusterMock(...a),
  },
  sendAdjusterEmail: (...a: unknown[]) => sendAdjusterEmailMock(...a),
}));
vi.mock('@/lib/track', () => ({ track: vi.fn() }));

import { supabase } from '@/lib/supabase';
import { sendEstimateRequest } from '../(homeowner)/help-estimate/actions';
import { sendMeasurementRequest } from '../(homeowner)/help-measurements/use-help-measurements-data';
import { submitRepairIntake } from '../(homeowner)/repair-intake/use-repair-intake-data';
import { resolvePartnerRecord } from '../lib/partner-record';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;
const capture = Sentry.captureMessage as unknown as ReturnType<typeof vi.fn>;

type Result = { data: unknown; error: { message: string } | null };
const ONE: Result = { data: [{ id: 'c1' }], error: null };
const ZERO: Result = { data: [], error: null };
const ERR: Result = { data: null, error: { message: 'trigger raised' } };

/** claims.update(...).eq(...)[.eq(...)].select('id') resolving per-call from `results`. */
function mockClaimsUpdates(results: Result[]) {
  const updates: unknown[] = [];
  let n = 0;
  sb.from.mockImplementation((table: string) => {
    if (table === 'profiles') {
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
    }
    return {
      update: (payload: unknown) => {
        updates.push(payload);
        const r = results[Math.min(n++, results.length - 1)];
        const chain: Record<string, unknown> = {};
        chain.eq = () => chain;
        chain.select = () => Promise.resolve(r);
        return chain;
      },
    };
  });
  return updates;
}

beforeEach(() => {
  vi.clearAllMocks();
  sendAdjusterEmailMock.mockResolvedValue({ success: true });
  findOrCreateAdjusterMock.mockResolvedValue({ id: 'adj1' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const estimateInput = {
  claimId: 'claim-1', carrierId: null, claimNumber: 'N1', adjusterName: 'Pat', adjusterEmail: 'pat@x.com',
  adjusterPhone: '', homeownerName: 'H', homeownerPhone: '1', alsoMeasurements: false,
};

describe('help-estimate/actions.ts sendEstimateRequest (report-only)', () => {
  it('one row: no Sentry event, email sent', async () => {
    mockClaimsUpdates([ONE]);
    await sendEstimateRequest(estimateInput);
    expect(capture).not.toHaveBeenCalled();
    expect(sendAdjusterEmailMock).toHaveBeenCalledTimes(1);
  });
  it('zero rows: Sentry event with the token, console.error, email STILL sent, no throw', async () => {
    mockClaimsUpdates([ZERO]);
    await expect(sendEstimateRequest(estimateInput)).resolves.toEqual({ success: true });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][0]).toContain('update_zero_rows: claims (adjuster info)');
    expect(capture.mock.calls[0][1]).toMatchObject({ level: 'error', extra: { claim_id: 'claim-1' } });
    expect(console.error).toHaveBeenCalled();
    expect(findOrCreateAdjusterMock).toHaveBeenCalledTimes(1);
    expect(sendAdjusterEmailMock).toHaveBeenCalledTimes(1);
  });
  it('db error: Sentry event carries the error text, email STILL sent', async () => {
    mockClaimsUpdates([ERR]);
    await sendEstimateRequest(estimateInput);
    expect(capture.mock.calls[0][0]).toContain('trigger raised');
    expect(sendAdjusterEmailMock).toHaveBeenCalledTimes(1);
  });
});

describe('use-help-measurements-data.ts sendMeasurementRequest (report-only)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const args: any = {
    claim: { id: 'claim-2', adjuster_name: null, adjuster_email: null, adjuster_phone: null },
    profile: null, adjusterName: 'Pat', adjusterEmail: 'pat@x.com', adjusterPhone: '555',
  };
  it('one row: no Sentry event', async () => {
    mockClaimsUpdates([ONE]);
    await sendMeasurementRequest(args);
    expect(sendAdjusterEmailMock).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
  });
  it('zero rows: Sentry event, no throw, email already sent', async () => {
    mockClaimsUpdates([ZERO]);
    await expect(sendMeasurementRequest(args)).resolves.toBeUndefined();
    expect(sendAdjusterEmailMock).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][0]).toContain('update_zero_rows: claims (adjuster info)');
    expect(capture.mock.calls[0][1]).toMatchObject({ extra: { claim_id: 'claim-2' } });
  });
  it('db error: Sentry event, no throw', async () => {
    mockClaimsUpdates([ERR]);
    await expect(sendMeasurementRequest(args)).resolves.toBeUndefined();
    expect(capture.mock.calls[0][0]).toContain('trigger raised');
  });
});

describe('use-repair-intake-data.ts submitRepairIntake status=submitted (THROW + Sentry)', () => {
  const sub = {
    userId: 'u1', claimId: 'c-1', trade: 'roofing', repairType: 'leak',
    material: { brand: 'GAF', product: 'T', color: 'W' }, notes: 'n', photos: [],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  beforeEach(() => {
    sb.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
  });
  it('both writes land: resolves with the claim id, no Sentry event', async () => {
    const updates = mockClaimsUpdates([ONE, ONE]);
    await expect(submitRepairIntake(sub)).resolves.toEqual({ claimId: 'c-1' });
    expect(updates[updates.length - 1]).toEqual({ status: 'submitted' });
    expect(capture).not.toHaveBeenCalled();
  });
  it('status write matches zero rows: Sentry event AND throws (user is not told it was submitted)', async () => {
    mockClaimsUpdates([ONE, ZERO]);
    await expect(submitRepairIntake(sub)).rejects.toThrow(/update_zero_rows: claims \(repair status\)/);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][0]).toContain('update_zero_rows: claims (repair status)');
    expect(capture.mock.calls[0][1]).toMatchObject({ level: 'error', extra: { claim_id: 'c-1' } });
  });
  it('status write returns a db error: Sentry event AND throws that error', async () => {
    mockClaimsUpdates([ONE, ERR]);
    await expect(submitRepairIntake(sub)).rejects.toThrow(/trigger raised/);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

describe('partner-record.ts resolvePartnerRecord (class (c), defensive guard)', () => {
  function mockPartner(linkResult: Result) {
    const row = { id: 'p1', email: 'a@b.com', user_id: null };
    sb.from.mockImplementation(() => ({
      select: () => {
        const q: Record<string, unknown> = {};
        q.eq = (col: string) => {
          // first lookup is by user_id (miss), second by email (hit)
          if (col === 'user_id') return { single: () => Promise.resolve({ data: null, error: { message: 'none' } }) };
          return q;
        };
        q.is = () => q;
        q.single = () => Promise.resolve({ data: row, error: null });
        return q;
      },
      update: () => ({ eq: () => ({ select: () => Promise.resolve(linkResult) }) }),
    }));
  }
  it('zero rows: returns the record WITHOUT the local user_id (never reports linked)', async () => {
    mockPartner(ZERO);
    const r = await resolvePartnerRecord('u9', 'a@b.com');
    expect(r.kind).toBe('ok');
    expect(r.kind === 'ok' && r.partner.user_id).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
  it('db error: also returns the record without user_id', async () => {
    mockPartner(ERR);
    const r = await resolvePartnerRecord('u9', 'a@b.com');
    expect(r.kind === 'ok' && r.partner.user_id).toBeNull();
  });
  it('one row: reports the linked user_id', async () => {
    mockPartner(ONE);
    const r = await resolvePartnerRecord('u9', 'a@b.com');
    expect(r.kind === 'ok' && r.partner.user_id).toBe('u9');
  });
});
