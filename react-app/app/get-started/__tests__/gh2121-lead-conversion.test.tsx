/**
 * gh-2121 (LRS HO-1 S16): goal/activation write-back from an Arm-F-style
 * `?lead=<uuid>` deep link to the account it produces.
 *
 * Before this change, window.__oqRouterLeadId (set by the gh-2046 strip
 * script in app/layout.tsx whenever `?lead=` is present) was read exactly
 * once, by the prefill effect, and never persisted anywhere — leads.
 * converted_user_id was documented as "reserved... not written anywhere in
 * phase 1" (supabase/migrations/20260916132127_gh1994_router_leads_columns.sql,
 * COMMENT ON COLUMN) and nothing in the repo ever set it. This is the fix:
 * a successful password sign-up now calls the new set_lead_converted RPC
 * (this PR's migration) with the captured leadId, so a later $15 measurement
 * purchase or loss-sheet upload — which already join to `claims` by
 * `user_id` — can be traced back to the originating `leads` row via
 * `leads.converted_user_id = claims.user_id`.
 *
 * Positive: leadId present -> RPC called.
 * Negative control: no leadId (direct/organic visit, the pre-fix-identical
 * case) -> RPC never called. Proves this is additive, not a blind call on
 * every signup.
 *
 * Updated 2026-09-24 (PR #2163 REVIEW: FAIL fix, comment 5821864061, S1):
 * set_lead_converted no longer takes a client-supplied p_user_id (an anon
 * caller could previously link ANY lead to ANY guessed user id) — the RPC
 * now derives the account from auth.uid() server-side, so the call here is
 * `{ p_lead_id }` only. See lib/lead-capture.ts's linkPendingLeadOnce().
 *
 * Updated again 2026-09-24 (PR #2163 REVIEW: FAIL fix, comment 5822978578,
 * M2): a live session means this page navigates to /auth-callback in the
 * same tick, and that navigation used to cancel the in-flight RPC before
 * it resolved — the capture was already deleted, so nothing was left to
 * retry, and a real `?lead=` link was silently lost. The fix is a split:
 * when signUp() hands back a session (auto-confirm, the production
 * default), get-started SKIPS the in-page call and defers to
 * /auth-callback, which links it with nothing racing it (see that page's
 * own test suite for the "still links" half of the negative control).
 * When there is no session (email confirmation required), nothing
 * navigates away here, so the in-page call is still safe and still fires.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({
  useAuthReady: () => ({ user: null, role: null, loading: false }),
}));

const rpcMock = vi.fn(() => Promise.resolve({ data: null, error: null }));
// Default mock: NO live session (email confirmation required) — the
// branch where get-started still links in-page. Individual tests below
// override this for the "session already live" (M2) scenario.
const signUpMock = vi.fn(() =>
  Promise.resolve({
    data: { user: { id: 'new-user-123', identities: [{ id: 'x' }] }, session: null },
    error: null,
  }),
);

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { signUp: (...args: unknown[]) => signUpMock(...args) },
    from: vi.fn(() => ({
      insert: vi.fn(() => ({ then: (cb: (r: unknown) => void) => cb({ error: null }) })),
    })),
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

vi.mock('@/lib/cookie-storage', () => ({
  readReferralIds: vi.fn(() => ({})),
  writeReferralIds: vi.fn(),
}));

import GetStartedPage from '../page';

function fillStep1AndStep2() {
  fireEvent.change(screen.getByLabelText('Street Address'), { target: { value: '1 Otter Way' } });
  fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Austin' } });
  fireEvent.change(screen.getByLabelText('State'), { target: { value: 'TX' } });
  fireEvent.change(screen.getByLabelText('ZIP Code'), { target: { value: '78701' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

function fillAccountFormAndSubmit() {
  fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Jane' } });
  fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Doe' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'jane@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-1' } });
  fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'correct-horse-1' } });
  fireEvent.click(screen.getByRole('button', { name: /Create My Free Account/i }));
}

describe('gh-2121: get-started password sign-up writes lead conversion back', () => {
  let hrefSpy: ReturnType<typeof vi.fn>;
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId;
    hrefSpy = vi.fn();
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, set href(v: string) { hrefSpy(v); } },
    });
  });

  afterEach(() => {
    delete (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId;
    if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
  });

  it('no live session yet (email confirmation required): calls set_lead_converted with the captured leadId in-page', async () => {
    (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = 'lead-abc-123';
    // signUpMock's default (module-level) already returns session: null.

    render(<GetStartedPage />);
    fillStep1AndStep2();
    await screen.findByLabelText('First Name');
    fillAccountFormAndSubmit();

    await waitFor(() => expect(signUpMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith('set_lead_converted', {
        p_lead_id: 'lead-abc-123',
      }),
    );
    // S1: no p_user_id anywhere in the call — the server derives the
    // account from auth.uid(), never a client-supplied id.
    expect(rpcMock.mock.calls[0][1]).not.toHaveProperty('p_user_id');
    // No session was returned, so no auth-callback navigation happens here.
    expect(hrefSpy).not.toHaveBeenCalled();
  });

  it('negative control: no ?lead= captured -> set_lead_converted is never called', async () => {
    // window.__oqRouterLeadId deliberately left unset (beforeEach), matching
    // a direct/organic visit — the exact pre-fix behaviour for every signup.
    render(<GetStartedPage />);
    fillStep1AndStep2();
    await screen.findByLabelText('First Name');
    fillAccountFormAndSubmit();

    await waitFor(() => expect(signUpMock).toHaveBeenCalled());
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('M2 negative control: a live session (auto-confirm) means this page SKIPS the in-page call and navigates to /auth-callback, which links it instead (see auth-callback/__tests__/page.test.tsx for that half)', async () => {
    (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = 'lead-def-456';
    signUpMock.mockResolvedValueOnce({
      data: { user: { id: 'new-user-123', identities: [{ id: 'x' }] }, session: { access_token: 'tok' } },
      error: null,
    });

    render(<GetStartedPage />);
    fillStep1AndStep2();
    await screen.findByLabelText('First Name');
    fillAccountFormAndSubmit();

    await waitFor(() => expect(signUpMock).toHaveBeenCalled());
    // The navigation to auth-callback still happens...
    await waitFor(() => expect(hrefSpy).toHaveBeenCalledWith('https://app.otterquote.com/auth-callback'));
    // ...but this page itself never called set_lead_converted — that used
    // to be the M2 race (this call racing the navigation that cancels it).
    // (The page's separate get_lead_prefill RPC, unrelated to lead-capture,
    // still fires — this asserts the specific call, not "no RPC at all".)
    expect(rpcMock).not.toHaveBeenCalledWith('set_lead_converted', expect.anything());
  });
});
