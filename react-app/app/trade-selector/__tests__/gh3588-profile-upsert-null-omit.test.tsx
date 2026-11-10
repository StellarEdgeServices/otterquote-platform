/**
 * gh-3588 — the wizard's final profiles upsert must not wipe a returning
 * homeowner's saved name/phone. A returning homeowner reaches handleComplete
 * with no name/phone in cs_signup; the upsert used to send
 * `full_name: null, phone: null`, which overwrote the saved values on
 * ON CONFLICT UPDATE. Null/undefined fields must be OMITTED from the payload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { profilesUpsertMock, claimsInsertMock } = vi.hoisted(() => ({
  profilesUpsertMock: vi.fn((_payload: Record<string, unknown>) => Promise.resolve({ error: null })),
  claimsInsertMock: vi.fn((_payload: Record<string, unknown>) => ({
    select: () => ({
      single: () => Promise.resolve({ data: { id: 'test-claim-id' }, error: null }),
    }),
  })),
}));

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/lib/supabase', () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
  };
  return {
    supabase: {
      from: (table: string) => {
        if (table === 'profiles') return { upsert: profilesUpsertMock };
        if (table === 'claims') {
          return {
            select: () => chain,
            insert: claimsInsertMock,
            update: () => ({ eq: () => Promise.resolve({ error: null }) }),
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

const mockAuth = (v: unknown) => (useAuthReady as unknown as ReturnType<typeof vi.fn>).mockReturnValue(v);

// Returning homeowner: address in cs_signup, but NO name / phone / consent.
const CS_SIGNUP_NO_IDENTITY = {
  address: '910 Congress Street, Noblesville, IN 46060',
  address_street: '910 Congress Street',
  address_city: 'Noblesville',
  address_state: 'IN',
  address_zip: '46060',
};

async function walk(csSignup: Record<string, unknown>) {
  localStorage.setItem('cs_signup', JSON.stringify(csSignup));
  localStorage.setItem('cs_signup_at', String(Date.now()));
  render(<TradeSelectorPage />);
  fireEvent.click(screen.getByText("I'm paying for this myself (retail/cash)"));
  await waitFor(() => expect(screen.getByText('What do you need done?')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Roofing'));
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  await waitFor(() => expect(screen.getByText('Repair or Replace?')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  await waitFor(() => expect(claimsInsertMock).toHaveBeenCalledTimes(1));
  // The profile upsert runs before the claims insert; find the full one.
  const full = profilesUpsertMock.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(p => p.role === 'homeowner');
  return full as Record<string, unknown>;
}

describe('gh-3588 profiles upsert omits null identity fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: { href: '', search: '' } });
    mockAuth({ user: { id: 'u1', email: 'jane@example.com' }, loading: false, settled: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it('returning homeowner (no name/phone in cs_signup): payload has NO full_name/phone keys', async () => {
    const payload = await walk(CS_SIGNUP_NO_IDENTITY);
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty('full_name');
    expect(payload).not.toHaveProperty('phone');
    expect(payload).not.toHaveProperty('referral_source');
    expect(payload).not.toHaveProperty('sms_consent_ts');
    expect(Object.values(payload).some(v => v === null || v === undefined)).toBe(false);
  });

  it('fresh signup: name and phone are still written', async () => {
    const payload = await walk({ ...CS_SIGNUP_NO_IDENTITY, first_name: 'Jane', last_name: 'Doe', phone: '3175551234' });
    expect(payload.full_name).toBe('Jane Doe');
    expect(payload.phone).toBe('3175551234');
    expect(payload.address_zip).toBe('46060');
  });
});
