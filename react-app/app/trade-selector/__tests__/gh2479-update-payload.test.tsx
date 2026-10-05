/**
 * gh-2479 (companion to PR #2502) -- handleComplete must NOT send
 * claims.referral_id on the UPDATE of an already-existing claim, and MUST
 * still send it on the INSERT of a new claim.
 *
 * PR #2502's BEFORE UPDATE guard raises 42501 when a signed-in client changes
 * claims.referral_id, which would refuse the WHOLE trades save for a returning
 * user whose referral cookie differs from the stored value. Drives the real
 * page and the real oq-ref cookie (same harness shape as
 * gh2062-referral-cookie-clear.test.tsx); only @/lib/supabase and the auth
 * hook are mocked.
 *
 *   (a) existing-claim UPDATE payload has no referral_id   (fails on main)
 *   (b) new-claim INSERT payload still has referral_id     (passes on main)
 *   (c) a never-used cookie referral id is not cleared by an existing-claim save
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { claimsInsertMock, claimsUpdateMock, claimsMaybeSingleMock } = vi.hoisted(() => ({
  claimsInsertMock: vi.fn((_payload: Record<string, unknown>) => ({
    select: () => ({ single: () => Promise.resolve({ data: { id: 'test-claim-id' }, error: null }) }),
  })),
  claimsUpdateMock: vi.fn((_payload: Record<string, unknown>) => ({
    eq: () => ({ select: () => Promise.resolve({ data: [{ id: 'existing-claim-id' }], error: null }) }),
  })),
  claimsMaybeSingleMock: vi.fn(() => Promise.resolve({ data: null, error: null })),
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
        if (table === 'profiles') return { upsert: vi.fn(() => Promise.resolve({ error: null })) };
        if (table === 'claims') return { select: () => chain, insert: claimsInsertMock, update: claimsUpdateMock };
        return { select: () => chain };
      },
      rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    },
  };
});

import { useAuthReady } from '@/hooks/use-auth-ready';
import { readReferralIds, writeReferralIds } from '@/lib/cookie-storage';
import TradeSelectorPage from '../page';

const mockAuth = (v: unknown) => (useAuthReady as unknown as ReturnType<typeof vi.fn>).mockReturnValue(v);

const CS_SIGNUP = {
  first_name: 'Jane', last_name: 'Doe', phone: '3175551234',
  address: '910 Congress Street, Noblesville, IN 46060',
  address_street: '910 Congress Street', address_city: 'Noblesville', address_state: 'IN', address_zip: '46060',
};
const REF_ONLY = { oq_referral_id: 'referral-new-222' };
const REF_AND_AGENT = { oq_referral_id: 'referral-new-222', oq_referral_agent_id: 'agent-9', oq_referral_code: 'PARTNERX' };

function clearAllCookies() {
  document.cookie.split('; ').forEach((c) => {
    const key = c.split('=')[0];
    if (key) document.cookie = `${key}=; Path=/; Max-Age=0`;
  });
}

describe('TradeSelectorPage claim write — gh-2479 referral_id on UPDATE vs INSERT', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimsMaybeSingleMock.mockReset().mockImplementation(() => Promise.resolve({ data: null, error: null }));
    claimsUpdateMock.mockReset().mockImplementation((_p: Record<string, unknown>) => ({
      eq: () => ({ select: () => Promise.resolve({ data: [{ id: 'existing-claim-id' }], error: null }) }),
    }));
    claimsInsertMock.mockReset().mockImplementation((_p: Record<string, unknown>) => ({
      select: () => ({ single: () => Promise.resolve({ data: { id: 'test-claim-id' }, error: null }) }),
    }));
    localStorage.clear();
    sessionStorage.clear();
    clearAllCookies();
    Object.defineProperty(window, 'location', {
      configurable: true, writable: true,
      value: { href: '', search: '', hostname: 'localhost', protocol: 'http:' },
    });
    mockAuth({ user: { id: 'u1', email: 'jane@example.com' }, loading: false, settled: true });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  async function walk(expectMock: typeof claimsInsertMock | typeof claimsUpdateMock) {
    localStorage.setItem('cs_signup', JSON.stringify(CS_SIGNUP));
    localStorage.setItem('cs_signup_at', String(Date.now()));
    render(<TradeSelectorPage />);
    fireEvent.click(screen.getByText("I'm paying for this myself (retail/cash)"));
    await waitFor(() => expect(screen.getByText('What do you need done?')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Roofing'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText('Repair or Replace?')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(expectMock).toHaveBeenCalledTimes(1));
    return expectMock.mock.calls[0][0] as Record<string, unknown>;
  }

  const existingClaim = () =>
    claimsMaybeSingleMock.mockImplementation(() => Promise.resolve({ data: { id: 'existing-claim-id' }, error: null }));

  it('(a) existing claim: the UPDATE payload has NO referral_id (rest of the save unchanged)', async () => {
    writeReferralIds(REF_AND_AGENT, { click: true });
    existingClaim();
    const payload = await walk(claimsUpdateMock);
    expect(claimsInsertMock).not.toHaveBeenCalled();
    expect('referral_id' in payload).toBe(false);
    expect(payload.referral_agent_id).toBe(REF_AND_AGENT.oq_referral_agent_id);
    expect(payload.referral_code).toBe(REF_AND_AGENT.oq_referral_code);
    expect(payload.trades).toEqual(['roofing']);
  });

  it('(b) new claim: the INSERT payload still HAS referral_id', async () => {
    writeReferralIds(REF_AND_AGENT, { click: true });
    const payload = await walk(claimsInsertMock);
    expect(claimsUpdateMock).not.toHaveBeenCalled();
    expect(payload.referral_id).toBe(REF_AND_AGENT.oq_referral_id);
  });

  it('(c) existing claim with ONLY a cookie referral id: the never-used cookie is NOT cleared', async () => {
    writeReferralIds(REF_ONLY, { click: true });
    existingClaim();
    await walk(claimsUpdateMock);
    expect(readReferralIds().oq_referral_id).toBe(REF_ONLY.oq_referral_id);
    expect(document.cookie).toContain('oq-ref=');
  });
});
