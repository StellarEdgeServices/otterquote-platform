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
 * REVIEW: FAIL correction — the first version of this fix (and this test
 * file) assumed `window.__oqRouterLeadId` survives a reload. It does not: a
 * reload tears down the JS context, and the `?lead=` param the strip script
 * already removed from the URL on the FIRST load isn't there for a reload
 * to re-populate the global from either. The corrected fix persists the id
 * itself to `sessionStorage.oq_lead_id` at the one instant it still exists
 * (inside LEAD_STRIP_SCRIPT, app/layout.tsx), and get-started/page.tsx now
 * resolves the id from the window global first, falling back to that
 * sessionStorage entry. `simulateStripCapture()` below mirrors the real
 * script's capture (both writes, together) so no test here can quietly
 * reintroduce the refuted premise by setting the window global alone.
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
const LEAD_ID_KEY = 'oq_lead_id';

function valueDump() {
  return Array.from(document.querySelectorAll('input')).map((i) => [
    i.id || i.name,
    (i as HTMLInputElement).value,
  ]);
}

/**
 * Mirrors LEAD_STRIP_SCRIPT (app/layout.tsx) exactly: on the ONE load that
 * still carries `?lead=`, it captures the id into BOTH the window global
 * (read first — the fast path, no storage round-trip) AND the `oq_lead_id`
 * sessionStorage entry (the ONLY thing that survives a reload, since the
 * window global does not and the URL no longer carries `lead` to
 * re-capture it from). Every "first load" test below uses this instead of
 * setting the window global alone, so no test quietly reintroduces the
 * refuted premise.
 */
function simulateStripCapture(leadId: string) {
  (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = leadId;
  sessionStorage.setItem(LEAD_ID_KEY, leadId);
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
    simulateStripCapture(LEAD_ID);

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

  it('REAL reload (window global torn down, only sessionStorage survives): applies the cached payload WITHOUT re-calling the RPC', async () => {
    // gh-2054 REVIEW: FAIL correction — the original version of this test
    // "simulated" a reload by re-setting window.__oqRouterLeadId before the
    // second render. That encoded the exact FALSE premise the refuter found:
    // a real reload tears down the JS context, so the window global is
    // GONE, and the `?lead=` param the strip already removed from the URL
    // on the first load isn't there for a reload to re-populate it from
    // either. A real reload only leaves sessionStorage behind. This test
    // now models that precisely: LEAD_STRIP_SCRIPT (app/layout.tsx) writes
    // BOTH the window global AND `sessionStorage.oq_lead_id` at capture
    // time, so setup here does the same; the "reload" step deletes ONLY the
    // window global (what a real reload actually destroys) and leaves
    // sessionStorage untouched (what a real reload actually preserves) —
    // proven against a real browser in the PR's evidence (a genuine
    // `location.reload()`, confirmed via
    // `performance.getEntriesByType('navigation')[0].type === 'reload'`).
    rpcMock.mockResolvedValueOnce({
      data: [{ name: 'Jane Homeowner', email: 'jane.h@example.com', phone: '3175551234' }],
      error: null,
    });
    simulateStripCapture(LEAD_ID);

    const first = render(<GetStartedPage />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    first.unmount();

    // The reload itself: only the window global is destroyed. sessionStorage
    // (both oq_lead_id and the oq_prefill_<id> cache written by the first
    // mount's RPC response) is left exactly as a real reload would leave it.
    delete (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId;

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
    simulateStripCapture(otherLeadId);

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
    simulateStripCapture(LEAD_ID);

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

  it('clears BOTH the cached prefill and the oq_lead_id entry once signUp() genuinely creates a new account', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ name: 'Jane Homeowner', email: 'jane.h@example.com', phone: '3175551234' }],
      error: null,
    });
    simulateStripCapture(LEAD_ID);

    render(<GetStartedPage />);
    await waitFor(() => expect(sessionStorage.getItem(CACHE_KEY)).not.toBeNull());
    expect(sessionStorage.getItem(LEAD_ID_KEY)).toBe(LEAD_ID);

    fillStep1AndContinue();
    await screen.findByLabelText('First Name');

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-1' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'correct-horse-1' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create My Free Account' }));

    await waitFor(() => expect(signUpMock).toHaveBeenCalledTimes(1));
    // gh-2054 REVIEW: FAIL correction, item 3 — clearing the payload alone
    // is not enough; the id used to look it up must go too.
    await waitFor(() => expect(sessionStorage.getItem(CACHE_KEY)).toBeNull());
    expect(sessionStorage.getItem(LEAD_ID_KEY)).toBeNull();
  });

  it('resolves no id at all when the window global is absent and sessionStorage.getItem throws (private mode surviving to a reload)', async () => {
    // Belt-and-suspenders for readRouterLeadId()'s own fallback read: even
    // with no window global (a real reload) AND a storage access failure
    // (private mode / blocked site data), the page must render the
    // no-prefill path instead of throwing.
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new DOMException('blocked');
    };
    try {
      render(<GetStartedPage />);
      fillStep1AndContinue();
      await screen.findByLabelText('First Name');

      expect(rpcMock).not.toHaveBeenCalled();
      expect(valueDump().every(([, v]) => v !== 'jane.h@example.com')).toBe(true);
    } finally {
      Storage.prototype.getItem = originalGetItem;
    }
  });
});
