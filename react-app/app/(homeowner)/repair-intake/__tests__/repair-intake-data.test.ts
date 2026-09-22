import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Mock ONLY the supabase singleton — the data layer under test is the real thing.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getUser: vi.fn() },
    from: vi.fn(),
    rpc: vi.fn(),
    storage: { from: vi.fn() },
  },
}));

import { supabase } from '@/lib/supabase';
import {
  MissingAddressError,
  SessionExpiredError,
  submitRepairIntake,
  useRepairContractors,
} from '../use-repair-intake-data';
import type { RepairSubmission } from '../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

interface SetupOpts {
  user?: string | null;
  newClaimId?: string;
  insertError?: { message: string } | null;
  updateError?: { message: string } | null;
  uploadError?: { message: string } | null;
  // gh-2004: the profiles row submitRepairIntake reads for its
  // hasFullAddress() gate on the no-claim-id (create) branch. Defaults to a
  // complete address so every pre-existing test in this file keeps
  // exercising the insert path unchanged; pass nulls to exercise the
  // MissingAddressError branch instead.
  profileAddress?: {
    address_street: string | null;
    address_city: string | null;
    address_state: string | null;
    address_zip: string | null;
  } | null;
}

function setup(opts: SetupOpts = {}) {
  const {
    user = 'u1',
    newClaimId = 'new-claim',
    insertError = null,
    updateError = null,
    uploadError = null,
    profileAddress = {
      address_street: '1 Main St',
      address_city: 'Noblesville',
      address_state: 'IN',
      address_zip: '46060',
    },
  } = opts;

  const rec: {
    inserts: unknown[];
    updates: unknown[];
    uploads: { path: string; file: File; opts: unknown }[];
  } = { inserts: [], updates: [], uploads: [] };

  sb.auth.getUser.mockResolvedValue({
    data: { user: user ? { id: user } : null },
    error: null,
  });

  sb.from.mockImplementation((table: string) => {
    if (table === 'profiles') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: profileAddress ? { full_name: null, ...profileAddress } : null,
                error: null,
              }),
          }),
        }),
      };
    }
    if (table === 'claims') {
      return {
        insert: (payload: unknown) => {
          rec.inserts.push(payload);
          return {
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: insertError ? null : { id: newClaimId },
                  error: insertError,
                }),
            }),
          };
        },
        update: (payload: unknown) => {
          rec.updates.push(payload);
          const chain: Record<string, unknown> = {};
          chain.eq = () => chain;
          chain.then = (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ error: updateError }).then(resolve);
          return chain;
        },
      };
    }
    return {};
  });

  const upload = vi.fn((path: string, file: File, options: unknown) => {
    rec.uploads.push({ path, file, opts: options });
    return Promise.resolve({ error: uploadError });
  });
  sb.storage.from.mockReturnValue({ upload });

  return { rec, upload };
}

const baseSub = (over: Partial<RepairSubmission> = {}): RepairSubmission => ({
  userId: 'u1',
  claimId: null,
  trade: 'roofing',
  repairType: 'leak',
  material: { brand: 'GAF', product: 'Timberline', color: 'Weathered Wood' },
  notes: 'ceiling drip',
  photos: [],
  ...over,
});

describe('(d) submitRepairIntake — claim write + photo upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no claim id → INSERTs the exact draft payload (incl. gh-2004 address from the profile), then marks submitted', async () => {
    const { rec } = setup({ newClaimId: 'c-new' });
    const res = await submitRepairIntake(baseSub());

    expect(rec.inserts).toHaveLength(1);
    expect(rec.inserts[0]).toEqual({
      user_id: 'u1',
      job_type: 'repair',
      funding_type: 'insurance',
      status: 'draft',
      trades: ['roofing'],
      existing_shingle_brand: 'GAF',
      existing_shingle_product: 'Timberline',
      existing_shingle_color: 'Weathered Wood',
      homeowner_notes: 'ceiling drip',
      // gh-2004: resolved from the (mocked, complete) profiles row.
      property_address: '1 Main St, Noblesville, IN 46060',
      property_city: 'Noblesville',
      property_state: 'IN',
      property_zip: '46060',
      // gh-397/#689 (PR #785): is_test is now stamped on every claims insert.
      // The mock user has no email, so isTestEmail(undefined) is false.
      is_test: false,
    });
    // Final write marks the claim submitted.
    expect(rec.updates).toEqual([{ status: 'submitted' }]);
    expect(res.claimId).toBe('c-new');
  });

  it('gh-2004: no claim id + incomplete profile address → throws MissingAddressError, never inserts', async () => {
    const { rec } = setup({
      newClaimId: 'c-new',
      profileAddress: { address_street: null, address_city: null, address_state: null, address_zip: null },
    });
    await expect(submitRepairIntake(baseSub())).rejects.toBeInstanceOf(MissingAddressError);
    expect(rec.inserts).toHaveLength(0);
  });

  // REVIEW fix (PR #2109, finding 4): a whitespace-only field is truthy
  // (`' ' || null` keeps the space) but not a real value — the gate must
  // .trim() before deciding hasFullAddress(), matching trade-selector's own
  // gate, or this profile would be silently accepted as "complete".
  it('gh-2004 REVIEW fix: a whitespace-only profile field is NOT treated as a complete address', async () => {
    const { rec } = setup({
      newClaimId: 'c-new',
      profileAddress: { address_street: '   ', address_city: 'Noblesville', address_state: 'IN', address_zip: '46060' },
    });
    await expect(submitRepairIntake(baseSub())).rejects.toBeInstanceOf(MissingAddressError);
    expect(rec.inserts).toHaveLength(0);
  });

  it('existing claim id → UPDATEs (no user_id/funding_type/status), then marks submitted', async () => {
    const { rec } = setup();
    const res = await submitRepairIntake(baseSub({ claimId: 'c-existing', notes: null }));

    expect(rec.inserts).toHaveLength(0);
    expect(rec.updates[0]).toEqual({
      job_type: 'repair',
      trades: ['roofing'],
      existing_shingle_brand: 'GAF',
      existing_shingle_product: 'Timberline',
      existing_shingle_color: 'Weathered Wood',
      homeowner_notes: null,
    });
    expect(rec.updates[1]).toEqual({ status: 'submitted' });
    expect(res.claimId).toBe('c-existing');
  });

  it('uploads each photo to the UID-first scoped path with {upsert:false}', async () => {
    const { rec } = setup({ newClaimId: 'c-new' });
    const f1 = new File(['x'], 'roof.png', { type: 'image/png' });
    const f2 = new File(['y'], 'label.jpg', { type: 'image/jpeg' });
    await submitRepairIntake(
      baseSub({
        photos: [
          { tier: 'main', file: f1 },
          { tier: 'tier2', file: f2 },
        ],
      }),
    );

    expect(rec.uploads).toHaveLength(2);
    // First folder segment MUST be the user id (RLS: foldername[1] = auth.uid()).
    expect(rec.uploads[0].path).toMatch(/^u1\/c-new\/repair-main-\d+-[a-z0-9]+\.png$/);
    expect(rec.uploads[1].path).toMatch(/^u1\/c-new\/repair-tier2-\d+-[a-z0-9]+\.jpg$/);
    rec.uploads.forEach((u) => {
      expect(u.opts).toEqual({ contentType: expect.any(String), upsert: false });
    });
    expect(rec.uploads[0].opts).toMatchObject({ contentType: 'image/png', upsert: false });
  });

  it('a single failed upload is swallowed (does not abort submission)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { rec } = setup({ uploadError: { message: 'denied' } });
    const f1 = new File(['x'], 'roof.png', { type: 'image/png' });
    const res = await submitRepairIntake(baseSub({ photos: [{ tier: 'main', file: f1 }] }));

    expect(res.claimId).toBe('new-claim');
    expect(rec.updates).toEqual([{ status: 'submitted' }]); // still marked submitted
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('no live session → throws SessionExpiredError (caller redirects)', async () => {
    setup({ user: null });
    await expect(submitRepairIntake(baseSub())).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('claim insert failure → throws (caller re-enables Submit)', async () => {
    setup({ insertError: { message: 'rls denied' } });
    await expect(submitRepairIntake(baseSub())).rejects.toThrow(/rls denied/);
  });
});

describe('(d) useRepairContractors — public-safe view query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries get_contractors_public RPC (repairs_accepted + trade) only once enabled', async () => {
    const limit = vi.fn(() =>
      Promise.resolve({
        data: [{ id: 'k1', company_name: 'Acme', years_in_business: 9, rating: 4.7 }],
        error: null,
      }),
    );
    const contains = vi.fn(() => ({ limit }));
    const eq = vi.fn(() => ({ contains }));
    const select = vi.fn(() => ({ eq }));
    sb.rpc.mockReturnValue({ select });

    const { result, rerender } = renderHook(
      ({ enabled }) => useRepairContractors('roofing', enabled),
      { initialProps: { enabled: false } },
    );
    // Disabled → no query.
    expect(sb.rpc).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => {
      expect(result.current.contractors).toHaveLength(1);
    });
    expect(sb.rpc).toHaveBeenCalledWith('get_contractors_public');
    expect(select).toHaveBeenCalledWith(
      'id, company_name, years_in_business, rating, service_counties',
    );
    expect(eq).toHaveBeenCalledWith('repairs_accepted', true);
    expect(contains).toHaveBeenCalledWith('trades', ['roofing']);
    expect(limit).toHaveBeenCalledWith(10);
    expect(result.current.contractors[0].company_name).toBe('Acme');
  });

  it('query error surfaces as error state, empty contractors', async () => {
    const limit = vi.fn(() => Promise.resolve({ data: null, error: { message: 'boom' } }));
    const contains = vi.fn(() => ({ limit }));
    const eq = vi.fn(() => ({ contains }));
    const select = vi.fn(() => ({ eq }));
    sb.rpc.mockReturnValue({ select });

    const { result } = renderHook(() => useRepairContractors('roofing', true));
    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.contractors).toHaveLength(0);
  });
});
