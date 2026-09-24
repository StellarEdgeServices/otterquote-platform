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
 * Positive: leadId present -> RPC called with the right ids.
 * Negative control: no leadId (direct/organic visit, the pre-fix-identical
 * case) -> RPC never called. Proves this is additive, not a blind call on
 * every signup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({
  useAuthReady: () => ({ user: null, role: null, loading: false }),
}));

const rpcMock = vi.fn(() => Promise.resolve({ data: null, error: null }));
const signUpMock = vi.fn(() =>
  Promise.resolve({
    data: { user: { id: 'new-user-123', identities: [{ id: 'x' }] }, session: { access_token: 'tok' } },
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
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId;
  });

  afterEach(() => {
    delete (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId;
  });

  it('calls set_lead_converted with the captured leadId and the new user id when ?lead= was present', async () => {
    (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = 'lead-abc-123';

    render(<GetStartedPage />);
    fillStep1AndStep2();
    await screen.findByLabelText('First Name');
    fillAccountFormAndSubmit();

    await waitFor(() => expect(signUpMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith('set_lead_converted', {
        p_lead_id: 'lead-abc-123',
        p_user_id: 'new-user-123',
      }),
    );
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
});
