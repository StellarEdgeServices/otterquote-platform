/**
 * gh-1993 FIX ROUND 1 (CEO RUN 48) — regression test for REVIEW: FAIL B1/B2
 * on PR #1998 (comment 5698654086) and the CEO ruling that reversed them
 * (comment 5698876771).
 *
 * The first round of this PR wrote `claims.property_address` as the STREET
 * LINE ONLY. The refuter showed every real reader of that column
 * (notify-contractors, check-siding-design-completion, the contractor
 * opportunities card, agreement_requested email/SMS, DocuSign
 * customer_address, color-selection.html's ZIP extraction) expects the full
 * combined line, and a street-only value broke contractor notification
 * outright and exposed the homeowner's street address pre-selection
 * (D-074). The ruling: property_address stays the combined line;
 * property_city/property_zip are ADDITIVE alongside it.
 *
 * This test drives the actual `handleComplete` claims-insert path (cash
 * funding, one trade, default "replace" — no extra steps needed) with a
 * cs_signup payload shaped exactly like get-started/page.tsx now writes it,
 * and asserts the captured `claims.insert()` payload matches the CEO
 * ruling: property_address === the COMBINED cs_signup.address string
 * (never just the street), plus property_city/property_state/property_zip
 * populated from the split fields. Negative control: asserts
 * property_address is NOT the street-only value that the failed first
 * round would have produced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { claimsInsertMock } = vi.hoisted(() => ({
  claimsInsertMock: vi.fn((_payload: Record<string, unknown>) => ({
    select: () => ({
      single: () => Promise.resolve({ data: { id: 'test-claim-id' }, error: null }),
    }),
  })),
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
          return { upsert: vi.fn(() => Promise.resolve({ error: null })) };
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

// Exactly get-started/page.tsx's post-fix cs_signup shape: fullAddress()'s
// combined line PLUS the four split fields it also carries.
const CS_SIGNUP_COMBINED = '910 Congress Street, Noblesville, IN 46060';
const CS_SIGNUP = {
  first_name: 'Jane',
  last_name: 'Doe',
  phone: '3175551234',
  address: CS_SIGNUP_COMBINED,
  address_street: '910 Congress Street',
  address_city: 'Noblesville',
  address_state: 'IN',
  address_zip: '46060',
  // No project_type here on purpose: gh-1991's pre-select effect would
  // otherwise pre-select Roofing before this walk's own explicit click on
  // the Roofing card runs, and clicking an already-selected trade card
  // toggles it OFF — leaving trades empty and Continue disabled. This test
  // is about the address write, not the pre-select (see
  // gh1991-project-type-preselect.test.tsx for that).
};

describe('TradeSelectorPage claims write — gh-1993 FIX ROUND 1 (property_address stays combined)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  async function completeCashSingleTradeWalk() {
    localStorage.setItem('cs_signup', JSON.stringify(CS_SIGNUP));
    render(<TradeSelectorPage />);

    // Funding: cash -> lands directly on Trades (no Policy step).
    fireEvent.click(screen.getByText("I'm paying for this myself (retail/cash)"));
    await waitFor(() => expect(screen.getByText('What do you need done?')).toBeInTheDocument());

    // One trade (Roofing) -> Continue -> Repair/Replace (defaults to "replace").
    fireEvent.click(screen.getByText('Roofing'));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText('Repair or Replace?')).toBeInTheDocument());

    // Final step: Continue triggers handleComplete -> the claims insert.
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(claimsInsertMock).toHaveBeenCalledTimes(1));
    return claimsInsertMock.mock.calls[0][0] as Record<string, unknown>;
  }

  it('writes property_address as the COMBINED line, not the street alone (positive)', async () => {
    const payload = await completeCashSingleTradeWalk();
    expect(payload.property_address).toBe(CS_SIGNUP_COMBINED);
  });

  it('negative control: property_address is NOT the street-only value the failed first round wrote', async () => {
    const payload = await completeCashSingleTradeWalk();
    expect(payload.property_address).not.toBe('910 Congress Street');
  });

  it('populates property_city/property_state/property_zip alongside the combined property_address', async () => {
    const payload = await completeCashSingleTradeWalk();
    expect(payload.property_city).toBe('Noblesville');
    expect(payload.property_state).toBe('IN');
    expect(payload.property_zip).toBe('46060');
  });

  it('the combined property_address parses correctly downstream (mirrors notify-contractors\' own derivation)', async () => {
    const payload = await completeCashSingleTradeWalk();
    const addr = payload.property_address as string;
    // Same regex/split logic as supabase/functions/notify-contractors/index.ts:1449-1467
    const zipMatch = addr.match(/\b(\d{5})(?:-\d{4})?\s*$/);
    const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
    expect(zipMatch?.[1]).toBe('46060');
    expect(parts[1]).toBe('Noblesville'); // city — NOT the street (D-074)
  });
});
