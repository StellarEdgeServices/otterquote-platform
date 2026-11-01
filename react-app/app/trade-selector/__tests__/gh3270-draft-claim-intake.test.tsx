/**
 * gh-3270 -- trade-selector's returning-user guard and save for a returning
 * homeowner whose latest claim is an address-less draft.
 *
 *   (a) draft claim (property_address NULL): the guard does NOT redirect to the
 *       dashboard, the wizard runs, and the save UPDATEs that claim (no INSERT)
 *       with the cs_signup address
 *   (b) negative control: a claim that finished intake still redirects to the dashboard
 *   (c) the guard's query selects property_address
 *
 * Same harness shape as gh2479-update-payload.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { claimsInsertMock, claimsUpdateMock, claimsMaybeSingleMock, claimsSelectMock } = vi.hoisted(() => ({
  claimsInsertMock: vi.fn((_payload: Record<string, unknown>) => ({
    select: () => ({ single: () => Promise.resolve({ data: { id: 'new-claim-id' }, error: null }) }),
  })),
  claimsUpdateMock: vi.fn((_payload: Record<string, unknown>) => ({
    eq: (_c: string, _v: unknown) => ({ select: () => Promise.resolve({ data: [{ id: 'draft-claim-id' }], error: null }) }),
  })),
  claimsMaybeSingleMock: vi.fn(() => Promise.resolve({ data: null as unknown, error: null })),
  claimsSelectMock: vi.fn(),
}));

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/lib/supabase', () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: claimsMaybeSingleMock,
  };
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'profiles') return { upsert: vi.fn(() => Promise.resolve({ error: null })), select: () => chain };
        if (table === 'claims') {
          return {
            select: (cols: string) => { claimsSelectMock(cols); return chain; },
            insert: claimsInsertMock,
            update: claimsUpdateMock,
          };
        }
        return { select: () => chain };
      },
      rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    },
  };
});

import { useAuthReady } from '@/hooks/use-auth-ready';
import TradeSelectorPage from '../page';

const DASHBOARD = 'https://otterquote.com/dashboard.html';
const CS_SIGNUP = {
  first_name: 'Jane', last_name: 'Doe', phone: '3175551234',
  address: '910 Congress Street, Noblesville, IN 46060',
  address_street: '910 Congress Street', address_city: 'Noblesville', address_state: 'IN', address_zip: '46060',
};

describe('TradeSelectorPage — gh-3270 address-less draft claim', () => {
  let hrefSets: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    claimsMaybeSingleMock.mockReset();
    localStorage.clear();
    sessionStorage.clear();
    hrefSets = [];
    let href = '';
    Object.defineProperty(window, 'location', {
      configurable: true, writable: true,
      value: {
        get href() { return href; },
        set href(v: string) { href = v; hrefSets.push(v); },
        search: '', hostname: 'localhost', protocol: 'http:',
      },
    });
    (useAuthReady as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      user: { id: 'u1', email: 'jane@example.com' }, loading: false, settled: true,
    });
    localStorage.setItem('cs_signup', JSON.stringify(CS_SIGNUP));
    localStorage.setItem('cs_signup_at', String(Date.now()));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('(a) draft claim: no dashboard redirect, and the save UPDATEs the existing claim (no INSERT)', async () => {
    claimsMaybeSingleMock.mockImplementation(() =>
      Promise.resolve({ data: { id: 'draft-claim-id', property_address: null }, error: null }));
    const eqSpy = vi.fn();
    claimsUpdateMock.mockImplementation((_p: Record<string, unknown>) => ({
      eq: (c: string, v: unknown) => {
        eqSpy(c, v);
        return { select: () => Promise.resolve({ data: [{ id: 'draft-claim-id' }], error: null }) };
      },
    }));

    render(<TradeSelectorPage />);
    fireEvent.click(await screen.findByText("I'm paying for this myself (retail/cash)"));
    await waitFor(() => expect(screen.getByText('What do you need done?')).toBeInTheDocument());
    expect(hrefSets).not.toContain(DASHBOARD);

    fireEvent.click(screen.getByText('Roofing'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText('Repair or Replace?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(claimsUpdateMock).toHaveBeenCalledTimes(1));
    expect(claimsInsertMock).not.toHaveBeenCalled();
    expect(eqSpy).toHaveBeenCalledWith('id', 'draft-claim-id');
    const payload = claimsUpdateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.property_address).toBe('910 Congress Street, Noblesville, IN 46060');
    expect(payload.property_zip).toBe('46060');
    expect(payload.funding_type).toBe('cash');
    expect(payload.trades).toEqual(['roofing']);
    // The guard's early redirect never fired at any point.
    expect(hrefSets.indexOf(DASHBOARD)).toBe(-1);
  });

  it('(b) negative control: a claim that finished intake redirects to the dashboard', async () => {
    claimsMaybeSingleMock.mockImplementation(() =>
      Promise.resolve({ data: { id: 'c1', property_address: '1 Main St, Zionsville, IN 46077' }, error: null }));
    render(<TradeSelectorPage />);
    await waitFor(() => expect(hrefSets).toContain(DASHBOARD));
    expect(claimsUpdateMock).not.toHaveBeenCalled();
    expect(claimsInsertMock).not.toHaveBeenCalled();
  });

  it('(c) the returning-user guard selects property_address', async () => {
    claimsMaybeSingleMock.mockImplementation(() => Promise.resolve({ data: null, error: null }));
    render(<TradeSelectorPage />);
    await waitFor(() => expect(claimsSelectMock).toHaveBeenCalledWith(expect.stringContaining('property_address')));
  });
});
