import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ── Mock the auth + notification hooks the shell depends on (before import). ──
vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: () => ({ count: 0, loading: false, error: null }),
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import { HomeownerShell } from '../../_shell/HomeownerShell';
import {
  buildRebateCard,
  buildSwitchSurveyMessage,
  canSwitchContractor,
  deriveStatusBanner,
  isStateGated,
  isSwitchWithinCutoff,
  shouldShowHomeProfilePrompt,
  shouldShowRebateCard,
  shouldShowWarrantyButton,
} from '../utils';
import type { HomeownerClaim } from '../types';

type AuthVal = ReturnType<typeof vi.fn>;
const mockAuth = (v: unknown) => (useAuthReady as unknown as AuthVal).mockReturnValue(v);

const authed = (over: Record<string, unknown> = {}) => ({
  user: { id: 'u1', email: 'jane@example.com' },
  role: 'homeowner',
  isAdmin: false,
  loading: false,
  settled: true,
  signOut: vi.fn(),
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) Homeowner gate — replicates Auth.requireAuth('homeowner') semantics.
// ─────────────────────────────────────────────────────────────────────────────
describe('HomeownerShell gate', () => {
  let originalLocation: Location;

  beforeEach(() => {
    vi.clearAllMocks();
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: '' },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it('renders content for an authenticated homeowner', () => {
    mockAuth(authed());
    render(<HomeownerShell active="dashboard"><div>DASH_BODY</div></HomeownerShell>);
    expect(screen.getByText('DASH_BODY')).toBeInTheDocument();
    expect(window.location.href).toBe('');
  });

  it('renders content for a null/unresolved role (permissive, like requireAuth)', () => {
    mockAuth(authed({ role: null }));
    render(<HomeownerShell active="dashboard"><div>DASH_BODY</div></HomeownerShell>);
    expect(screen.getByText('DASH_BODY')).toBeInTheDocument();
    expect(window.location.href).toBe('');
  });

  it('redirects an unauthenticated visitor to the static get-started.html (NOT sign-in.html)', async () => {
    mockAuth(authed({ user: null, role: null }));
    render(<HomeownerShell active="dashboard"><div>DASH_BODY</div></HomeownerShell>);
    await waitFor(() => expect(window.location.href).toBe('https://otterquote.com/get-started.html'));
    expect(window.location.href).not.toContain('sign-in.html');
    expect(screen.queryByText('DASH_BODY')).not.toBeInTheDocument();
  });

  it('redirects a contractor to the contractor dashboard', async () => {
    mockAuth(authed({ role: 'contractor' }));
    render(<HomeownerShell active="dashboard"><div>DASH_BODY</div></HomeownerShell>);
    await waitFor(() =>
      expect(window.location.href).toBe('https://otterquote.com/contractor-dashboard.html'),
    );
    expect(screen.queryByText('DASH_BODY')).not.toBeInTheDocument();
  });

  it('shows a spinner and does not redirect while auth is unsettled', () => {
    mockAuth(authed({ user: null, role: null, settled: false, loading: true }));
    render(<HomeownerShell active="dashboard"><div>DASH_BODY</div></HomeownerShell>);
    expect(screen.queryByText('DASH_BODY')).not.toBeInTheDocument();
    expect(window.location.href).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) D-178 — state gate + status-banner stage rendering.
// ─────────────────────────────────────────────────────────────────────────────
const claim = (over: Partial<HomeownerClaim> = {}): HomeownerClaim =>
  ({ id: 'c-abcd1234', user_id: 'u1', status: 'active', ...over }) as HomeownerClaim;

describe('D-178 state gate', () => {
  it('does not gate Indiana', () => {
    expect(isStateGated(claim({ property_state: 'IN' }))).toBe(false);
  });
  it('gates a non-IN state', () => {
    expect(isStateGated(claim({ property_state: 'OH' }))).toBe(true);
  });
  it('does not gate a null/absent property_state (pre-intake draft)', () => {
    expect(isStateGated(claim({ property_state: null }))).toBe(false);
    expect(isStateGated(undefined)).toBe(false);
  });
});

describe('D-178 status banner', () => {
  it('hides the banner until ready_for_bids', () => {
    expect(deriveStatusBanner(claim({ ready_for_bids: false }), 0)).toBeNull();
  });
  it('shows the live state with no bids', () => {
    const b = deriveStatusBanner(claim({ ready_for_bids: true }), 0);
    expect(b?.variant).toBe('live');
    expect(b?.title).toBe('Your project is live!');
  });
  it('shows a singular/plural bid count', () => {
    expect(deriveStatusBanner(claim({ ready_for_bids: true }), 1)?.title).toBe('You have 1 bid!');
    expect(deriveStatusBanner(claim({ ready_for_bids: true }), 3)?.title).toBe('You have 3 bids!');
  });
  it('prioritises contract_signed', () => {
    const b = deriveStatusBanner(claim({ ready_for_bids: true, status: 'contract_signed' }), 5);
    expect(b?.variant).toBe('contract_signed');
    expect(b?.title).toBe('Contract signed!');
  });
  it('still hides for a contract_signed claim that is not ready_for_bids', () => {
    expect(deriveStatusBanner(claim({ ready_for_bids: false, status: 'contract_signed' }), 0)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Key card states — warranty button, switch survey, home-profile prompt.
// ─────────────────────────────────────────────────────────────────────────────
describe('W3-P4 warranty button', () => {
  const signed = { status: 'contract_signed', completion_date: '2026-06-01' } as Partial<HomeownerClaim>;
  it('shows on a completed contract_signed claim with a warranty url', () => {
    expect(shouldShowWarrantyButton(claim(signed), 'contractor-documents/x.pdf')).toBe(true);
  });
  it('hides without a warranty url', () => {
    expect(shouldShowWarrantyButton(claim(signed), null)).toBe(false);
  });
  it('hides before completion', () => {
    expect(shouldShowWarrantyButton(claim({ status: 'contract_signed' }), 'x.pdf')).toBe(false);
  });
  it('hides for a non-contract_signed claim', () => {
    expect(shouldShowWarrantyButton(claim({ status: 'active', completion_date: '2026-06-01' }), 'x.pdf')).toBe(false);
  });
});

describe('D-171 switch contractor', () => {
  const now = new Date('2026-06-22T12:00:00Z');
  it('only offers switching on a contract_signed claim', () => {
    expect(canSwitchContractor(claim({ status: 'contract_signed' }))).toBe(true);
    expect(canSwitchContractor(claim({ status: 'active' }))).toBe(false);
  });
  it('disables switching within the 3-day install cutoff', () => {
    expect(isSwitchWithinCutoff(claim({ estimated_start_date: '2026-06-24' }), now)).toBe(true);
  });
  it('allows switching well before install', () => {
    expect(isSwitchWithinCutoff(claim({ estimated_start_date: '2026-07-30' }), now)).toBe(false);
  });
  it('allows switching when no install date is set', () => {
    expect(isSwitchWithinCutoff(claim({}), now)).toBe(false);
  });
  it('builds the support-email body with the job ref, reasons and notes', () => {
    const msg = buildSwitchSurveyMessage(claim({ id: 'claim-abcd1234' }), ['unresponsive', 'other'], 'too slow');
    expect(msg).toBe('Job #ABCD1234\nReasons: unresponsive, other\nNotes: too slow');
  });
  it('falls back to (none) when notes are empty', () => {
    const msg = buildSwitchSurveyMessage(claim({ id: 'claim-abcd1234' }), ['unresponsive'], '');
    expect(msg).toContain('Notes: (none)');
  });
});

describe('D-231 home-profile prompt', () => {
  const base = {
    claim: claim({ status: 'contract_signed', completion_date: '2026-06-01' }),
    profileId: 'u1',
    hasHomeProfile: false,
    dismissed: false,
  };
  it('shows when complete, no profile yet, not dismissed', () => {
    expect(shouldShowHomeProfilePrompt(base)).toBe(true);
  });
  it('hides once a home profile exists', () => {
    expect(shouldShowHomeProfilePrompt({ ...base, hasHomeProfile: true })).toBe(false);
  });
  it('hides once dismissed', () => {
    expect(shouldShowHomeProfilePrompt({ ...base, dismissed: true })).toBe(false);
  });
  it('hides before completion', () => {
    expect(
      shouldShowHomeProfilePrompt({ ...base, claim: claim({ status: 'contract_signed' }) }),
    ).toBe(false);
  });
  it('hides without a profile id', () => {
    expect(shouldShowHomeProfilePrompt({ ...base, profileId: null })).toBe(false);
  });
});

describe('D-181 rebate card (display-only)', () => {
  it('hides until a payment intent is on file', () => {
    expect(shouldShowRebateCard({ id: 'h1' })).toBe(false);
    expect(shouldShowRebateCard(null)).toBe(false);
  });
  it('shows once a payment intent is recorded', () => {
    expect(shouldShowRebateCard({ id: 'h1', homeowner_stripe_payment_intent_id: 'pi_1' })).toBe(true);
  });
  it('renders the rebated / pending / on-file variants', () => {
    expect(
      buildRebateCard({ id: 'h1', homeowner_stripe_payment_intent_id: 'pi', homeowner_charge_amount: 4900, rebate_paid_at: '2026-06-10' }).variant,
    ).toBe('rebated');
    expect(
      buildRebateCard({ id: 'h1', homeowner_stripe_payment_intent_id: 'pi', homeowner_charge_amount: 4900, rebate_due: true }).variant,
    ).toBe('pending');
    expect(
      buildRebateCard({ id: 'h1', homeowner_stripe_payment_intent_id: 'pi', homeowner_charge_amount: 4900 }).variant,
    ).toBe('on_file');
  });
  it('formats the amount from cents', () => {
    expect(
      buildRebateCard({ id: 'h1', homeowner_stripe_payment_intent_id: 'pi', homeowner_charge_amount: 4900 }).amountLabel,
    ).toBe('$49');
  });
});
