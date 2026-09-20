/**
 * gh-2054 — sessionStorage rehydration for the single-use `get_lead_prefill`
 * RPC.
 *
 * #2046 shipped the RPC as single-use (server-side `prefill_used_at` guard,
 * unchanged by this fix). #2054 found that a reload lost the prefill anyway,
 * because the payload the RPC returned lived only in React state — nothing
 * survived the remount. Fixed (RW-DESIGN, issue #2054 comment 5752255257) by
 * caching the RPC's first successful response in `sessionStorage`, keyed by
 * lead id, and checking that cache BEFORE ever calling the RPC.
 *
 * Assertions are on a VALUE DUMP of every input's name/value, per the
 * issue's own verification trap: screen 4's placeholders are Jane / Smith /
 * jane@example.com, so an empty form and a prefilled one are indistinguishable
 * on a screenshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({
  useAuthReady: () => ({ user: null, role: null, loading: false }),
}));

const rpcMock = vi.fn();
const signUpMock = vi.fn(() =>
  Promise.resolve({ data: { user: { identities: [{ id: 'x' }] } }, error: null }),
);

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    auth: {
      signUp: (...args: unknown[]) => signUpMock(...args),
      signInWithOAuth: vi.fn(() => Promise.resolve({ error: null })),
    },
    from: vi.fn(() => ({ insert: vi.fn(() => Promise.resolve({ error: null })) })),
  },
}));

vi.mock('@/lib/cookie-storage', () => ({
  readReferralIds: vi.fn(() => ({})),
  writeReferralIds: vi.fn(),
}));

import GetStartedPage from '../page';

const LEAD_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const CACHE_KEY = `oq_prefill_${LEAD_ID}`;

function valueDump() {
  return Array.from(document.querySelectorAll('input')).map((i) => [
    i.id || i.name,
    (i as HTMLInputElement).value,
  ]);
}

function fillStep1AndContinue() {
  fireEvent.change(screen.getByLabelText('Street Address'), { target: { value: '1 Otter Way' } });
  fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Austin' } });
  fireEvent.change(screen.getByLabelText('State'), { target: { value: 'TX' } });
  fireEvent.change(screen.getByLabelText('ZIP Code'), { target: { value: '78701' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('gh-2054: sessionStorage rehydration of the single-use prefill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks()` resets call counts but NOT a queued
    // `mockResolvedValueOnce` — and the reload test below deliberately
    // leaves one queued (unconsumed) to prove a cache hit never calls the
    // RPC. Without this reset, that leftover value bleeds into whichever
    // test calls rpcMock next. signUpMock is left alone: its default
    // implementation is set once at module scope and every test relies on
    // it rather than pushing its own.
    rpcMock.mockReset();
    sessionStorage.clear();
    localStorage.clear();
    delete (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId;
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId;
  });

  it('cold mount: calls the RPC once, applies the prefill, and caches it', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ name: 'Jane Homeowner', email: 'jane.h@example.com', phone: '3175551234' }],
      error: null,
    });
    (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = LEAD_ID;

    render(<GetStartedPage />);
    // The prefilled fields (name/email/phone) live on Step 2 — advance past
    // Step 1 before dumping input values, exactly like a real visitor would
    // land on the account screen after the router hop.
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    fillStep1AndContinue();
    await screen.findByLabelText('First Name');

    await waitFor(() => {
      expect(valueDump().some(([, v]) => v === 'jane.h@example.com')).toBe(true);
    });

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('get_lead_prefill', { p_lead_id: LEAD_ID });

    const cached = sessionStorage.getItem(CACHE_KEY);
    expect(cached).not.toBeNull();
    expect(JSON.parse(cached as string)).toMatchObject({ email: 'jane.h@example.com' });
  });

  it('reload (remount, same tab): applies the cached payload WITHOUT re-calling the RPC', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ name: 'Jane Homeowner', email: 'jane.h@example.com', phone: '3175551234' }],
      error: null,
    });
    (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = LEAD_ID;

    const first = render(<GetStartedPage />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    first.unmount();

    // Simulate the server-side single-use guard: a second RPC call for the
    // same lead id now legitimately comes back empty. If the component fell
    // through to the RPC instead of the cache on reload, the value dump
    // below would come back blank and this test would fail.
    rpcMock.mockResolvedValueOnce({ data: [], error: null });

    render(<GetStartedPage />);
    fillStep1AndContinue();
    await screen.findByLabelText('First Name');

    await waitFor(() => {
      expect(valueDump().some(([, v]) => v === 'jane.h@example.com')).toBe(true);
    });

    // The cache hit must not have burned the single use a second time.
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it('negative control: a different visitor\'s lead id (RPC comes back empty) leaves Step 2 blank, not crashed', async () => {
    rpcMock.mockResolvedValueOnce({ data: [], error: null });
    const otherLeadId = 'bbbbbbbb-9999-8888-7777-666666666666';
    (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = otherLeadId;

    render(<GetStartedPage />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    fillStep1AndContinue();
    await screen.findByLabelText('First Name');

    expect(valueDump().every(([, v]) => v !== 'jane.h@example.com')).toBe(true);
    expect(sessionStorage.getItem(`oq_prefill_${otherLeadId}`)).toBeNull();
  });

  it('renders the no-prefill path correctly when sessionStorage.getItem throws (private mode / blocked site data)', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ name: 'Jane Homeowner', email: 'jane.h@example.com', phone: '3175551234' }],
      error: null,
    });
    (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = LEAD_ID;

    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.getItem = () => {
      throw new DOMException('blocked');
    };
    Storage.prototype.setItem = () => {
      throw new DOMException('blocked');
    };
    try {
      render(<GetStartedPage />);
      // Falls through to the RPC (cache read failed => treated as a miss)
      // and still applies the prefill — the write failing afterward must
      // not crash the render.
      await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
      fillStep1AndContinue();
      await screen.findByLabelText('First Name');

      await waitFor(() => {
        expect(valueDump().some(([, v]) => v === 'jane.h@example.com')).toBe(true);
      });
      expect(rpcMock).toHaveBeenCalledTimes(1);
    } finally {
      Storage.prototype.getItem = originalGetItem;
      Storage.prototype.setItem = originalSetItem;
    }
  });

  it('renders exactly as today (no prefill) when there is no lead id at all', async () => {
    render(<GetStartedPage />);
    fillStep1AndContinue();
    await screen.findByLabelText('First Name');

    expect(rpcMock).not.toHaveBeenCalled();
    expect(valueDump().every(([, v]) => v !== 'jane.h@example.com')).toBe(true);
  });

  it('clears the cached prefill once signUp() genuinely creates a new account', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ name: 'Jane Homeowner', email: 'jane.h@example.com', phone: '3175551234' }],
      error: null,
    });
    (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = LEAD_ID;

    render(<GetStartedPage />);
    await waitFor(() => expect(sessionStorage.getItem(CACHE_KEY)).not.toBeNull());

    fillStep1AndContinue();
    await screen.findByLabelText('First Name');

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-1' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'correct-horse-1' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create My Free Account' }));

    await waitFor(() => expect(signUpMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(sessionStorage.getItem(CACHE_KEY)).toBeNull());
  });
});
