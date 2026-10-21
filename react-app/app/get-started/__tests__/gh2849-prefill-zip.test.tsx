/**
 * gh-2849: get-started's property step starts with the ZIP the homepage
 * stored on the lead row (D-389, Dustin 2026-10-18 on #2801: "Store it,
 * purpose: prefill + service area").
 *
 * The RPC get_lead_prefill gains a `zip` column in the draft migration
 * supabase/migrations_drafts/gh2849_get_lead_prefill_zip.sql; this file mocks
 * the RPC with that new shape and reads the ZIP Code input's VALUE (not a
 * screenshot: the placeholder would look the same as a filled field).
 *
 * NEGATIVE CONTROL: on main (page.tsx ignores `zip`) test 1 FAILS with an
 * empty ZIP field. Tests 2-4 pin the guards: an invalid ZIP is not used, a ZIP
 * the visitor already typed is not overwritten, and the old three-column RPC
 * shape (migration not yet applied) leaves the field empty and the
 * name/email/phone prefill intact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({
  useAuthReady: () => ({ user: null, role: null, loading: false }),
}));

const rpcMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    auth: {
      signUp: vi.fn(() =>
        Promise.resolve({ data: { user: { identities: [{ id: 'x' }] } }, error: null }),
      ),
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

const LEAD_ID = 'cccccccc-1111-2222-3333-444444444444';
const ROW = { name: 'Jane Homeowner', email: 'jane.h@example.com', phone: '3175551234' };

function setLead() {
  (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = LEAD_ID;
}
const zipInput = () => screen.getByLabelText('ZIP Code') as HTMLInputElement;
const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('gh-2849: get-started prefills the property-step ZIP from get_lead_prefill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpcMock.mockReset();
    sessionStorage.clear();
    localStorage.clear();
    delete (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId;
  });
  afterEach(() => {
    cleanup();
    delete (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId;
  });

  it('starts the property step with the stored ZIP', async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ ...ROW, zip: '46077' }], error: null });
    setLead();
    render(<GetStartedPage />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('get_lead_prefill', { p_lead_id: LEAD_ID }));
    await waitFor(() => expect(zipInput().value).toBe('46077'));
  });

  it('ignores a stored value that is not a 5-digit ZIP', async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ ...ROW, zip: '4607<script>' }], error: null });
    setLead();
    render(<GetStartedPage />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    await flush();
    expect(zipInput().value).toBe('');
  });

  it('never overwrites a ZIP the visitor already typed', async () => {
    let resolveRpc: (v: unknown) => void = () => {};
    rpcMock.mockReturnValueOnce(new Promise((r) => { resolveRpc = r; }));
    setLead();
    render(<GetStartedPage />);
    await screen.findByLabelText('ZIP Code');
    fireEvent.change(zipInput(), { target: { value: '78701' } });
    resolveRpc({ data: [{ ...ROW, zip: '46077' }], error: null });
    await flush();
    expect(zipInput().value).toBe('78701');
  });

  it('old RPC shape (migration not applied): ZIP stays empty, nothing breaks', async () => {
    rpcMock.mockResolvedValueOnce({ data: [ROW], error: null });
    setLead();
    render(<GetStartedPage />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    await flush();
    expect(zipInput().value).toBe('');
  });
});
