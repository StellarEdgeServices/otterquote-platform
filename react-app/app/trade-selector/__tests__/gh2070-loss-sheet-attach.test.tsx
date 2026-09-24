/**
 * gh-2070 (Ben, CEO RUN 57, comment 5767950147) — the trade-selector
 * "Upload Your Loss Sheet and We'll Help" stub uploads the file and then
 * does nothing: no claims.has_estimate/estimate_filename write-back, no
 * parse-loss-sheet invoke, no admin queue entry.
 *
 * This ports the dashboard checklist's move -> PATCH -> parse flow (see
 * `(homeowner)/dashboard/actions.ts`'s `uploadClaimDocument`) onto the
 * trade-selector stub: the upload handler stages `{storagePath, filename,
 * userId, timestamp}` in sessionStorage (the claim doesn't exist yet at
 * that step), and `attachPendingLossSheetToClaim` — called from both
 * places `handleComplete` learns `savedClaimId` — moves the object to
 * `{user}/{claim}/{timestamp}-{filename}`, PATCHes
 * `has_estimate`/`estimate_filename`, then invokes `parse-loss-sheet`
 * fire-and-forget.
 *
 * Drives the real wizard end to end: Funding "insurance" -> Policy "I'm Not
 * Sure" (surfaces the loss-sheet upload) -> upload a file -> Trades ->
 * Repair/Replace -> Continue (handleComplete).
 *
 * PR #2080 REVIEW: FAIL fixed here — the first round `await`ed the
 * parse-loss-sheet invoke inside attachPendingLossSheetToClaim, which is
 * itself awaited from handleComplete. parse-loss-sheet makes a synchronous,
 * non-streaming Claude vision call (15-60s routine, 150s EF wall clock) or,
 * worst case (proven by the refuter with a never-settling mock), hangs
 * forever — stalling the homeowner's redirect indefinitely. The
 * "does NOT fail completion" test below only ever exercised a *rejection*,
 * which settles instantly and proves nothing about latency/hanging — its
 * old name claimed otherwise. The new "never settles" test below is the one
 * that actually catches a re-introduced `await`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const {
  claimsInsertMock,
  claimsUpdateMock,
  claimsMaybeSingleMock,
  storageUploadMock,
  storageMoveMock,
  functionsInvokeMock,
  callOrder,
} = vi.hoisted(() => {
  const callOrder: string[] = [];
  return {
    callOrder,
    claimsInsertMock: vi.fn((_payload: Record<string, unknown>) => ({
      select: () => ({
        single: () => Promise.resolve({ data: { id: 'test-claim-id' }, error: null }),
      }),
    })),
    // gh-2062 round 3: the real claims.update() call site inside
    // handleComplete's existing-claim branch now chains .select('id') (to
    // check rows actually affected, not just that no error came back) —
    // this mock's .eq() result must therefore be BOTH directly awaitable
    // (attachPendingLossSheetToClaim's has_estimate/estimate_filename PATCH
    // below, which does not chain .select()) AND chainable with .select()
    // (the referral-consuming update). A thenable object satisfies both:
    // `await update(...).eq(...)` resolves it directly, while
    // `await update(...).eq(...).select('id')` calls the extra method.
    claimsUpdateMock: vi.fn((_payload: Record<string, unknown>) => {
      callOrder.push('patch');
      return {
        eq: () => ({
          then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
          select: () => Promise.resolve({ data: [{ id: 'existing-claim-id' }], error: null }),
        }),
      };
    }),
    // Default: no existing claim for this user -> handleComplete's insert
    // branch. Individual tests override the NEXT call with
    // mockResolvedValueOnce to drive the existing-claim (update) branch.
    claimsMaybeSingleMock: vi.fn(() => Promise.resolve({ data: null, error: null })),
    storageUploadMock: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    storageMoveMock: vi.fn((_from: string, _to: string) => {
      callOrder.push('move');
      return Promise.resolve({ data: {}, error: null });
    }),
    functionsInvokeMock: vi.fn((_fn: string, _opts: unknown) => {
      callOrder.push('invoke');
      return Promise.resolve({ data: {}, error: null });
    }),
  };
});

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/lib/supabase', () => {
  const claimsSelectChain = {
    select: () => claimsSelectChain,
    eq: () => claimsSelectChain,
    order: () => claimsSelectChain,
    limit: () => claimsSelectChain,
    maybeSingle: claimsMaybeSingleMock,
  };
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'profiles') return { upsert: vi.fn(() => Promise.resolve({ error: null })) };
        if (table === 'claims') {
          return {
            select: () => claimsSelectChain,
            insert: claimsInsertMock,
            update: claimsUpdateMock,
          };
        }
        return { select: () => claimsSelectChain };
      },
      storage: {
        from: () => ({ upload: storageUploadMock, move: storageMoveMock }),
      },
      functions: { invoke: functionsInvokeMock },
      rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    },
  };
});

import { useAuthReady } from '@/hooks/use-auth-ready';
import TradeSelectorPage from '../page';

type AuthVal = ReturnType<typeof vi.fn>;
const mockAuth = (v: unknown) => (useAuthReady as unknown as AuthVal).mockReturnValue(v);

const PENDING_KEY = 'oq_pending_loss_sheet_v1';

// No project_type key on purpose — gh-1991's pre-select effect would
// otherwise pre-select a trade before this walk's own explicit click runs
// (see gh1993-claims-address-write.test.tsx, same note).
const CS_SIGNUP = {
  first_name: 'Jane',
  last_name: 'Doe',
  phone: '3175551234',
  address: '910 Congress Street, Noblesville, IN 46060',
  address_street: '910 Congress Street',
  address_city: 'Noblesville',
  address_state: 'IN',
  address_zip: '46060',
};

function makeLossSheetFile() {
  return new File(['%PDF-1.4 dummy'], 'loss-sheet.pdf', { type: 'application/pdf' });
}

describe('TradeSelectorPage loss-sheet attach — gh-2070', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    localStorage.clear();
    sessionStorage.clear();
    claimsMaybeSingleMock.mockResolvedValue({ data: null, error: null });
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: '', search: '' },
    });
    mockAuth({ user: { id: 'u1', email: 'jane@example.com' }, loading: false, settled: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Funding "insurance" -> Policy "I'm Not Sure" -> uploads a loss sheet. */
  async function walkToUploadedLossSheet() {
    localStorage.setItem('cs_signup', JSON.stringify(CS_SIGNUP));
    render(<TradeSelectorPage />);

    fireEvent.click(screen.getByText('I have an insurance claim'));
    await waitFor(() => expect(screen.getByText('What type of insurance policy do you have?')).toBeInTheDocument());

    fireEvent.click(screen.getByText("I'm Not Sure"));
    await waitFor(() => expect(screen.getByText(/Upload your insurance estimate/i)).toBeInTheDocument());

    const input = screen.getByLabelText(/upload loss sheet/i) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeLossSheetFile()] } });
    await waitFor(() => expect(storageUploadMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/uploaded successfully/i)).toBeInTheDocument());
  }

  /** Continues from the Policy step through Trades/Repair into handleComplete. */
  async function completeWalk() {
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText('What do you need done?')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Roofing'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText('Repair or Replace?')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  }

  it('attaches the staged loss sheet in order: move -> PATCH has_estimate/estimate_filename -> parse-loss-sheet invoke', async () => {
    await walkToUploadedLossSheet();
    await completeWalk();

    await waitFor(() => expect(functionsInvokeMock).toHaveBeenCalledTimes(1));

    expect(storageMoveMock).toHaveBeenCalledTimes(1);
    expect(claimsUpdateMock).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['move', 'patch', 'invoke']);

    // move goes from the pre-claim staged path to the claim-scoped,
    // timestamp-prefixed path; PATCH writes has_estimate + the MOVED (not
    // the pre-move) storage path; invoke passes claim_id + that same
    // moved path.
    const [fromPath, toPath] = storageMoveMock.mock.calls[0];
    expect(fromPath).toMatch(/^u1\/loss-sheets\/\d+-loss-sheet\.pdf$/);
    expect(toPath).toMatch(/^u1\/test-claim-id\/\d+-loss-sheet\.pdf$/);
    expect(claimsUpdateMock.mock.calls[0][0]).toEqual({ has_estimate: true, estimate_filename: toPath });
    expect(functionsInvokeMock.mock.calls[0]).toEqual([
      'parse-loss-sheet',
      { body: { claim_id: 'test-claim-id', storage_path: toPath } },
    ]);

    // The staged sessionStorage entry is cleared only after a successful
    // move + PATCH.
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('drives the EXISTING-claim branch too — attach fires there, not just on new-claim insert', async () => {
    // Not `mockResolvedValueOnce`: page.tsx's own mount-time "returning-user
    // guard" (page.tsx:502-539) queries claims.select().maybeSingle() first
    // (harmlessly, since it only flips window.location.href, which this
    // jsdom mock doesn't actually navigate on) — a single queued value gets
    // consumed there instead of by handleComplete's own fetch. Resolving
    // every call to the same existing claim matches a real returning
    // homeowner, where both queries legitimately see the same row.
    claimsMaybeSingleMock.mockResolvedValue({ data: { id: 'existing-claim-id' }, error: null });

    await walkToUploadedLossSheet();
    await completeWalk();

    await waitFor(() => expect(functionsInvokeMock).toHaveBeenCalledTimes(1));

    // The existing-claim branch never inserts a new row.
    expect(claimsInsertMock).not.toHaveBeenCalled();
    expect(storageMoveMock).toHaveBeenCalledTimes(1);
    const [, toPath] = storageMoveMock.mock.calls[0];
    expect(toPath).toMatch(/^u1\/existing-claim-id\/\d+-loss-sheet\.pdf$/);

    // Two claims.update calls happen on this branch: the property-fields
    // write-back, then the has_estimate/estimate_filename PATCH. Assert the
    // PATCH specifically fired with the right claim id and payload, rather
    // than assuming call order between the two.
    const patchCall = claimsUpdateMock.mock.calls.find(
      (call) => (call[0] as Record<string, unknown>).has_estimate === true,
    );
    expect(patchCall?.[0]).toEqual({ has_estimate: true, estimate_filename: toPath });
    expect(functionsInvokeMock.mock.calls[0][1]).toEqual({
      body: { claim_id: 'existing-claim-id', storage_path: toPath },
    });
  });

  it('a parse-loss-sheet REJECTION (fast failure) does not fail completion', async () => {
    functionsInvokeMock.mockImplementationOnce(() => {
      callOrder.push('invoke');
      return Promise.reject(new Error('parse-loss-sheet down'));
    });

    await walkToUploadedLossSheet();
    await completeWalk();

    await waitFor(() => expect(functionsInvokeMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.location.href).toContain('claim_id=test-claim-id'));
    expect(callOrder).toEqual(['move', 'patch', 'invoke']);
  });

  // PR #2080 REVIEW: FAIL — this is the case the review's refuter used to
  // prove the bug. A rejection (above) settles instantly and says nothing
  // about a call that never settles at all, which is what a slow/hung
  // parse-loss-sheet (or a genuinely stuck network request) looks like.
  // Before the fix (attachPendingLossSheetToClaim `await`ing this invoke),
  // this test times out: window.location.href is never assigned. After the
  // fix (fire-and-forget `void ...catch(...)`), the redirect proceeds
  // without waiting on it at all.
  it('completion still redirects even when parse-loss-sheet never settles (fire-and-forget, not awaited)', async () => {
    functionsInvokeMock.mockImplementationOnce(() => {
      callOrder.push('invoke');
      return new Promise(() => { /* never resolves or rejects */ });
    });

    await walkToUploadedLossSheet();
    await completeWalk();

    await waitFor(() => expect(functionsInvokeMock).toHaveBeenCalledTimes(1));
    // The redirect must not wait on the never-settling invoke.
    await waitFor(() => expect(window.location.href).toContain('claim_id=test-claim-id'), { timeout: 3000 });
    expect(callOrder).toEqual(['move', 'patch', 'invoke']);
  }, 10000);

  it('a move failure surfaces the page-level error banner, skips PATCH/invoke, and keeps the staged entry', async () => {
    storageMoveMock.mockImplementationOnce(() => {
      callOrder.push('move');
      return Promise.resolve({ data: null, error: new Error('storage move failed') });
    });

    await walkToUploadedLossSheet();
    await completeWalk();

    // The page-level error banner (rendered regardless of wizard step,
    // unlike the "I'm Not Sure" panel's own status line, which is
    // unmounted by this point) shows the attach failure.
    await waitFor(
      () => expect(screen.getByRole('alert')).toHaveTextContent(/couldn't attach your loss sheet/i),
      { timeout: 3000 },
    );

    // A failed move must not proceed to PATCH or invoke.
    expect(claimsUpdateMock).not.toHaveBeenCalled();
    expect(functionsInvokeMock).not.toHaveBeenCalled();

    // Kept (not cleared) — see the code comment on why this is not an
    // active retry today.
    expect(sessionStorage.getItem(PENDING_KEY)).not.toBeNull();

    // Completion still redirects — after the longer, error-visible delay.
    await waitFor(() => expect(window.location.href).toContain('claim_id=test-claim-id'), { timeout: 6000 });
  }, 10000);

  it('discards a staged entry belonging to a different user (stale/shared-machine guard)', async () => {
    await walkToUploadedLossSheet();

    // Simulate a stale entry from a different signed-in user (e.g. a
    // previous session on a shared machine) by overwriting the staged
    // userId directly.
    const staged = JSON.parse(sessionStorage.getItem(PENDING_KEY) as string);
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...staged, userId: 'someone-else' }));

    await completeWalk();

    await waitFor(() => expect(claimsInsertMock).toHaveBeenCalledTimes(1));
    expect(storageMoveMock).not.toHaveBeenCalled();
    expect(claimsUpdateMock).not.toHaveBeenCalled();
    expect(functionsInvokeMock).not.toHaveBeenCalled();
  });

  it('with no loss sheet staged, no attach calls fire (move/PATCH/invoke all silent)', async () => {
    localStorage.setItem('cs_signup', JSON.stringify(CS_SIGNUP));
    render(<TradeSelectorPage />);

    fireEvent.click(screen.getByText("I'm paying for this myself (retail/cash)"));
    await waitFor(() => expect(screen.getByText('What do you need done?')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Roofing'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText('Repair or Replace?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(claimsInsertMock).toHaveBeenCalledTimes(1));
    expect(storageMoveMock).not.toHaveBeenCalled();
    expect(claimsUpdateMock).not.toHaveBeenCalled();
    expect(functionsInvokeMock).not.toHaveBeenCalled();
  });
});
