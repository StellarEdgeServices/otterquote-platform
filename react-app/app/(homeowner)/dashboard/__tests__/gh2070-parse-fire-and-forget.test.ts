/**
 * gh-2070 (Kevin, Code lane, comment 5768456008 / 5778016986) — PR #2080 fixed
 * the trade-selector's loss-sheet attach so its parse-loss-sheet invoke is
 * fire-and-forget (`void ...invoke().catch(...)`), never `await`ed inside the
 * homeowner's completion path. The same `await`ed invoke was flagged, twice,
 * as still present at this file's uploadClaimDocument (dashboard checklist
 * upload path) and in dashboard.html — parse-loss-sheet makes a synchronous,
 * non-streaming Claude vision call (routinely 15-60s, bounded only by the
 * ~150s Edge Function wall clock), so an `await` here can stall the
 * homeowner's upload indefinitely on a slow or hung call, exactly as #2080's
 * refuter proved for the trade-selector surface.
 *
 * This is the "never settles" regression test for THIS surface, mirroring
 * trade-selector's gh2070-loss-sheet-attach.test.tsx. Before the fix
 * (`await supabase.functions.invoke(...)`), it times out — the promise
 * uploadClaimDocument returns never settles. After the fix (fire-and-forget),
 * it resolves immediately regardless of how long (or whether) parse-loss-sheet
 * ever settles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { storageUploadMock, claimsUpdateMock, functionsInvokeMock } = vi.hoisted(() => ({
  storageUploadMock: vi.fn(() => Promise.resolve({ data: {}, error: null })),
  claimsUpdateMock: vi.fn(() => ({ eq: () => Promise.resolve({ error: null }) })),
  functionsInvokeMock: vi.fn(() => new Promise(() => {
    /* never resolves or rejects — mirrors a hung parse-loss-sheet call */
  })),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    storage: { from: () => ({ upload: storageUploadMock }) },
    from: () => ({ update: claimsUpdateMock }),
    functions: { invoke: functionsInvokeMock },
  },
}));

import { uploadClaimDocument } from '../actions';

describe('uploadClaimDocument parse-loss-sheet invoke — gh-2070', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves even when parse-loss-sheet never settles (fire-and-forget, not awaited)', async () => {
    const result = await uploadClaimDocument({
      userId: 'u1',
      claimId: 'claim-1',
      file: new File(['%PDF-1.4 dummy'], 'estimate.pdf', { type: 'application/pdf' }),
      timestamp: 12345,
      kind: 'estimate',
    });

    expect(result.ok).toBe(true);
    expect(functionsInvokeMock).toHaveBeenCalledWith('parse-loss-sheet', {
      body: { claim_id: 'claim-1', storage_path: 'u1/claim-1/12345-estimate.pdf' },
    });
  }, 3000);
});
