/**
 * gh-2004 — a returning homeowner who reaches /trade-selector with no
 * `cs_signup` in localStorage (new device, cleared storage, or a plain
 * sign-in that skipped get-started) previously created a claim with
 * `property_address`/`property_city`/`property_state`/`property_zip` all
 * NULL. Example: claim `9bea2213` (issue body). Root cause: the claims-
 * write path only ever read `cs_signup`; it never looked at the signed-in
 * user's own profile, and never asked when neither had an address.
 *
 * Fix (react-app/app/trade-selector/page.tsx):
 *   1. No cs_signup address -> fall back to the profile's
 *      address_street/city/state/zip (verified live against Supabase via
 *      the Management API: those four columns exist on `profiles`, all
 *      nullable text).
 *   2. Profile also empty -> show the same four split fields (Street /
 *      City / State select / ZIP) get-started uses (#1993/#1998), block
 *      Continue until they validate, and write them back to the profile.
 *   3. Every write site reads the single resolved `resolvedAddress` value,
 *      so a claim from this page is never inserted with a NULL address
 *      field — not just never all four NULL.
 *
 * These tests fail on `main` (pre-gh-2004): the profile-select mock below
 * does not exist on main's page.tsx (nothing there ever calls
 * `supabase.from('profiles').select(...)`), there is no 'address' step to
 * find text on, and `completeCashSingleTradeWalkNoCsSignup()`'s claim
 * payload is `property_address: null, property_city: null,
 * property_state: null, property_zip: null` on main — see the negative
 * control asserted directly in the third test below, and the CI evidence
 * comment on #2004 for the same suite run against main's HEAD.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { claimsInsertMock, profilesUpsertMock, profilesSelectMock } = vi.hoisted(() => ({
  claimsInsertMock: vi.fn((_payload: Record<string, unknown>) => ({
    select: () => ({
      single: () => Promise.resolve({ data: { id: 'test-claim-id' }, error: null }),
    }),
  })),
  profilesUpsertMock: vi.fn(() => Promise.resolve({ error: null })),
  // Overridden per-test via .mockResolvedValueOnce/.mockResolvedValue below.
  profilesSelectMock: vi.fn(() => Promise.resolve({ data: null, error: null })),
}));

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
        if (table === 'profiles') {
          return {
            upsert: profilesUpsertMock,
            select: () => ({ eq: () => ({ maybeSingle: profilesSelectMock }) }),
          };
        }
        if (table === 'claims') {
          return {
            select: () => claimsSelectChain,
            insert: claimsInsertMock,
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          };
        }
        return { select: () => claimsSelectChain };
      },
      rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    },
  };
});

import { useAuthReady } from '@/hooks/use-auth-ready';
import TradeSelectorPage from '../page';

type AuthVal = ReturnType<typeof vi.fn>;
const mockAuth = (v: unknown) => (useAuthReady as unknown as AuthVal).mockReturnValue(v);

const FULL_PROFILE_ADDRESS = {
  address_street: '910 Congress Street',
  address_city: 'Noblesville',
  address_state: 'IN',
  address_zip: '46060',
};

const EMPTY_PROFILE_ADDRESS = {
  address_street: null,
  address_city: null,
  address_state: null,
  address_zip: null,
};

async function goFundingToRepairAndComplete() {
  // Cash path: Funding -> Trades directly (no Policy step).
  fireEvent.click(screen.getByText("I'm paying for this myself (retail/cash)"));
  await waitFor(() => expect(screen.getByText('What do you need done?')).toBeInTheDocument());

  fireEvent.click(screen.getByText('Roofing'));
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  await waitFor(() => expect(screen.getByText('Repair or Replace?')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  await waitFor(() => expect(claimsInsertMock).toHaveBeenCalledTimes(1));
  return claimsInsertMock.mock.calls[0][0] as Record<string, unknown>;
}

describe('TradeSelectorPage — gh-2004 no-cs_signup address fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    profilesSelectMock.mockResolvedValue({ data: null, error: null });
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

  it('falls back to the profile address when cs_signup is absent (positive)', async () => {
    // No cs_signup at all — the exact bug shape (a second-session sign-in
    // that never went through get-started in this browser).
    profilesSelectMock.mockResolvedValue({ data: FULL_PROFILE_ADDRESS, error: null });

    render(<TradeSelectorPage />);

    // Resolves via the profile fallback before any step renders — lands
    // straight on 'funding', no address step shown.
    await waitFor(() => expect(screen.getByText('How is this job being funded?')).toBeInTheDocument());
    expect(screen.queryByText("What's the property address?")).not.toBeInTheDocument();

    const payload = await goFundingToRepairAndComplete();
    expect(payload.property_address).toBe('910 Congress Street, Noblesville, IN 46060');
    expect(payload.property_city).toBe('Noblesville');
    expect(payload.property_state).toBe('IN');
    expect(payload.property_zip).toBe('46060');
  });

  it('shows the four split address fields when both cs_signup and the profile are empty, and blocks Continue until they validate', async () => {
    profilesSelectMock.mockResolvedValue({ data: EMPTY_PROFILE_ADDRESS, error: null });

    render(<TradeSelectorPage />);

    await waitFor(() => expect(screen.getByText("What's the property address?")).toBeInTheDocument());

    // Same field labels as get-started (#1993/#1998).
    expect(screen.getByLabelText('Street Address')).toBeInTheDocument();
    expect(screen.getByLabelText('City')).toBeInTheDocument();
    expect(screen.getByLabelText('State')).toBeInTheDocument();
    expect(screen.getByLabelText('ZIP Code')).toBeInTheDocument();

    // Blocked: clicking Continue with every field empty shows a validation
    // error and does NOT advance past the address step.
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Please enter your street address.'));
    expect(screen.getByText("What's the property address?")).toBeInTheDocument();
    expect(screen.queryByText('How is this job being funded?')).not.toBeInTheDocument();
    expect(profilesUpsertMock).not.toHaveBeenCalled();

    // Fill in a valid address -> Continue now advances to funding and
    // writes the address back to the profile.
    fireEvent.change(screen.getByLabelText('Street Address'), { target: { value: '12345 North Meridian Street' } });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'North Little Rock' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'IN' } });
    fireEvent.change(screen.getByLabelText('ZIP Code'), { target: { value: '46060' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(screen.getByText('How is this job being funded?')).toBeInTheDocument());
    expect(profilesUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'u1',
      address_street: '12345 North Meridian Street',
      address_city: 'North Little Rock',
      address_state: 'IN',
      address_zip: '46060',
    }));
  });

  it('never inserts a claim with a NULL address field from this page (positive, via the address step)', async () => {
    profilesSelectMock.mockResolvedValue({ data: EMPTY_PROFILE_ADDRESS, error: null });

    render(<TradeSelectorPage />);
    await waitFor(() => expect(screen.getByText("What's the property address?")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Street Address'), { target: { value: '9000 Windpointe Pass' } });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Zionsville' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'IN' } });
    fireEvent.change(screen.getByLabelText('ZIP Code'), { target: { value: '46077' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText('How is this job being funded?')).toBeInTheDocument());

    const payload = await goFundingToRepairAndComplete();
    expect(payload.property_address).toBe('9000 Windpointe Pass, Zionsville, IN 46077');
    expect(payload.property_city).toBe('Zionsville');
    expect(payload.property_state).toBe('IN');
    expect(payload.property_zip).toBe('46077');
    // Negative control — this is the exact all-NULL shape claim `9bea2213`
    // had on main before this fix.
    expect(payload.property_address).not.toBeNull();
    expect(payload.property_city).not.toBeNull();
    expect(payload.property_state).not.toBeNull();
    expect(payload.property_zip).not.toBeNull();
  });

  it('rejects an invalid ZIP the same way get-started does (5-digit check)', async () => {
    profilesSelectMock.mockResolvedValue({ data: EMPTY_PROFILE_ADDRESS, error: null });
    render(<TradeSelectorPage />);
    await waitFor(() => expect(screen.getByText("What's the property address?")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Street Address'), { target: { value: '1 Main St' } });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Anytown' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'IN' } });
    fireEvent.change(screen.getByLabelText('ZIP Code'), { target: { value: '460' } });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Please enter a valid 5-digit ZIP code.'));
    expect(screen.getByText("What's the property address?")).toBeInTheDocument();
  });
});
