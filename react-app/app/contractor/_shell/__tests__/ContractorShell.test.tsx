/**
 * Tests for the contractor-track shell gate + nav (D-211 Phase 2; hardened in the
 * 2026-06-16 re-ship). The gate is the security-critical part: only an
 * authenticated CONTRACTOR sees page content; everyone else is redirected to
 * /contractor/login. Auth is mocked — the shell reuses the shared AuthProvider/
 * useAuthReady and does not re-implement it.
 *
 * Blocker-1 contract (postmortem 2026-06-16): the gate must NOT bounce until auth
 * is DEFINITIVELY resolved (`settled`), so the provider's 1.5s blank-screen
 * fallback (loading:false while a slow cold load / token refresh is still in
 * flight) can never eject an authenticated contractor mid-hydration.
 * Blocker-2 contract: when it DOES bounce, the shell drops a sessionStorage
 * one-shot marker that survives the client-side router.replace.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: vi.fn(() => ({ count: 0, loading: false, error: null })),
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import { useNotificationCount } from '@/hooks/use-notification-count';
import { ContractorShell, CONTRACTOR_NAV_LINKS } from '../ContractorShell';
import { consumeContractorGateBounce } from '@/lib/contractor-gate';

type AuthVal = ReturnType<typeof vi.fn>;
const mockAuth = (v: unknown) =>
  (useAuthReady as unknown as AuthVal).mockReturnValue(v);
const mockCount = (count: number) =>
  (useNotificationCount as unknown as AuthVal).mockReturnValue({ count, loading: false, error: null });

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mockCount(0);
});

describe('ContractorShell gate', () => {
  it('shows a spinner and does not redirect while auth is loading', () => {
    mockAuth({ user: null, role: null, isAdmin: false, loading: true, settled: false, signOut: vi.fn() });
    render(<ContractorShell active="home"><div>secret</div></ContractorShell>);
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('does NOT redirect during the cold-load hydration window (loading:false but not settled)', () => {
    // Regression guard for 2026-06-16: the provider's 1.5s fallback flips loading
    // → false with a null user before the real session resolves. The gate must
    // wait for `settled`, not bounce. (#291 → #292 root cause.)
    mockAuth({ user: null, role: null, isAdmin: false, loading: false, settled: false, signOut: vi.fn() });
    render(<ContractorShell active="home"><div>secret</div></ContractorShell>);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('redirects an unauthenticated user once settled, and drops a gate-bounce marker', () => {
    mockAuth({ user: null, role: null, isAdmin: false, loading: false, settled: true, signOut: vi.fn() });
    render(<ContractorShell active="home"><div>secret</div></ContractorShell>);
    expect(replace).toHaveBeenCalledWith('/contractor/login');
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    // Blocker-2: the one-shot marker survives the client-side bounce.
    expect(consumeContractorGateBounce()).toBe(true);
  });

  it('redirects an authenticated non-contractor (homeowner) once settled', () => {
    mockAuth({ user: { id: 'u1' }, role: 'homeowner', isAdmin: false, loading: false, settled: true, signOut: vi.fn() });
    render(<ContractorShell active="home"><div>secret</div></ContractorShell>);
    expect(replace).toHaveBeenCalledWith('/contractor/login');
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('renders nav + children for an authenticated contractor (no bounce, no marker)', () => {
    mockAuth({ user: { id: 'c1' }, role: 'contractor', isAdmin: false, loading: false, settled: true, signOut: vi.fn() });
    render(<ContractorShell active="home"><div>secret</div></ContractorShell>);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText('secret')).toBeInTheDocument();
    expect(consumeContractorGateBounce()).toBe(false);
    CONTRACTOR_NAV_LINKS.forEach((l) =>
      expect(screen.getByRole('link', { name: l.label })).toBeInTheDocument(),
    );
  });

  it('marks the active nav item with aria-current=page', () => {
    mockAuth({ user: { id: 'c1' }, role: 'contractor', isAdmin: false, loading: false, settled: true, signOut: vi.fn() });
    render(<ContractorShell active="opportunities"><div>x</div></ContractorShell>);
    expect(screen.getByText('Opportunities').closest('a')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Home').closest('a')).not.toHaveAttribute('aria-current');
  });

  it('wires sign-out to the shared signOut', () => {
    const signOut = vi.fn();
    mockAuth({ user: { id: 'c1' }, role: 'contractor', isAdmin: false, loading: false, settled: true, signOut });
    render(<ContractorShell active="home"><div>x</div></ContractorShell>);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('shows the unread-notification badge when count > 0', () => {
    mockCount(3);
    mockAuth({ user: { id: 'c1' }, role: 'contractor', isAdmin: false, loading: false, settled: true, signOut: vi.fn() });
    render(<ContractorShell active="home"><div>x</div></ContractorShell>);
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
