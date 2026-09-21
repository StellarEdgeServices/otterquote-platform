/**
 * gh-2070 (Ben, CEO RUN 57, comment 5767950147) — the trade-selector
 * "Upload Your Loss Sheet and We'll Help" stub uploads the file and then
 * does nothing: no claims.has_estimate/estimate_filename write-back, no
 * parse-loss-sheet invoke, no admin queue entry.
 *
 * This ports the dashboard checklist's move -> PATCH -> parse flow (see
 * `(homeowner)/dashboard/actions.ts`'s `uploadClaimDocument`) onto the
 * trade-selector stub: the upload handler stages `{storagePath, filename,
 * userId}` in sessionStorage (the claim doesn't exist yet at that step),
 * and `attachPendingLossSheetToClaim` — called from both places
 * `handleComplete` learns `savedClaimId` — moves the object to
 * `{user}/{claim}/…`, PATCHes `has_estimate`/`estimate_filename`, then
 * invokes `parse-loss-sheet` best-effort.
 *
 * Drives the real wizard end to end: Funding "insurance" -> Policy "I'm Not
 * Sure" (surfaces the loss-sheet upload) -> upload a file -> Trades ->
 * Repair/Replace -> Continue (handleComplete, the new-claim insert path,
 * since the mocked claims select returns no existing row).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { claimsInsertMock, claimsUpdateMock, storageUploadMock, storageMoveMock, functionsInvokeMock, callOrder } =
  vi.hoisted(() => {
    const callOrder: string[] = [];
    return {
      callOrder,
      claimsInsertMock: vi.fn((_payload: Record<string, unknown>) => ({
        select: () => ({
          single: () => Promise.resolve({ data: { id: 'test-claim-id' }, error: null }),
        }),
      })),
      claimsUpdateMock: vi.fn((_payload: Record<string, unknown>) => {
        callOrder.push('patch');
        return { eq: () => Promise.resolve({ error: null }) };
      }),
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
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
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

    // move goes from the pre-claim staged path to the claim-scoped path;
    // PATCH writes has_estimate + the MOVED (not the pre-move) storage
    // path; invoke passes claim_id + that same moved path.
    const [fromPath, toPath] = storageMoveMock.mock.calls[0];
    expect(fromPath).toMatch(/^u1\/loss-sheets\//);
    expect(toPath).toBe('u1/test-claim-id/loss-sheet.pdf');
    expect(claimsUpdateMock.mock.calls[0][0]).toEqual({ has_estimate: true, estimate_filename: toPath });
    expect(functionsInvokeMock.mock.calls[0]).toEqual([
      'parse-loss-sheet',
      { body: { claim_id: 'test-claim-id', storage_path: toPath } },
    ]);

    // Retry-ability: the staged sessionStorage entry is cleared only after
    // a successful attach.
    expect(sessionStorage.getItem('oq_pending_loss_sheet_v1')).toBeNull();
  });

  it('a parse-loss-sheet rejection does NOT fail completion (best-effort, never blocks)', async () => {
    functionsInvokeMock.mockImplementationOnce(() => {
      callOrder.push('invoke');
      return Promise.reject(new Error('parse-loss-sheet down'));
    });

    await walkToUploadedLossSheet();
    await completeWalk();

    await waitFor(() => expect(functionsInvokeMock).toHaveBeenCalledTimes(1));
    // Completion still redirected with the claim id — proof the rejection
    // was swallowed rather than left to fail (or hang) handleComplete.
    await waitFor(() => expect(window.location.href).toContain('claim_id=test-claim-id'));
    // move + PATCH both still ran, in order, before the invoke that rejected.
    expect(callOrder).toEqual(['move', 'patch', 'invoke']);
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
