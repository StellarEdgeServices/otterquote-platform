/**
 * Tests for the contractor-track shell gate + nav (D-211 Phase 2).
 *
 * The gate is the security-critical part: only an authenticated CONTRACTOR sees
 * page content; everyone else is redirected to /contractor/login (the normalized
 * auth-failure target). Auth is mocked — the shell reuses the shared
 * AuthProvider/useAuthReady and does not re-implement it.
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

type AuthVal = ReturnType<typeof vi.fn>;
const mockAuth = (v: unknown) =>
  (useAuthReady as unknown as AuthVal).mockReturnValue(v);
const mockCount = (count: number) =>
  (useNotificationCount as unknown as AuthVal).mockReturnValue({ count, loading: false, error: null });

beforeEach(() => {
  vi.clearAllMocks();
  mockCount(0);
});

describe('ContractorShell gate', () => {
  it('shows a spinner and does not redirect while auth is resolving', () => {
    mockAuth({ user: null, role: null, isAdmin: false, loading: true, signOut: vi.fn() });
    render(<ContractorShell active="home"><div>secret</div></ContractorShell>);
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('redirects an unauthenticated user to /contractor/login', () => {
    mockAuth({ user: null, role: null, isAdmin: false, loading: false, signOut: vi.fn() });
    render(<ContractorShell active="home"><div>secret</div></ContractorShell>);
    expect(replace).toHaveBeenCalledWith('/contractor/login');
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('redirects an authenticated non-contractor (homeowner) to /contractor/login', () => {
    mockAuth({ user: { id: 'u1' }, role: 'homeowner', isAdmin: false, loading: false, signOut: vi.fn() });
    render(<ContractorShell active="home"><div>secret</div></ContractorShell>);
    expect(replace).toHaveBeenCalledWith('/contractor/login');
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('renders nav + children for an authenticated contractor', () => {
    mockAuth({ user: { id: 'c1' }, role: 'contractor', isAdmin: false, loading: false, signOut: vi.fn() });
    render(<ContractorShell active="home"><div>secret</div></ContractorShell>);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText('secret')).toBeInTheDocument();
    CONTRACTOR_NAV_LINKS.forEach((l) =>
      expect(screen.getByRole('link', { name: l.label })).toBeInTheDocument(),
    );
  });

  it('marks the active nav item with aria-current=page', () => {
    mockAuth({ user: { id: 'c1' }, role: 'contractor', isAdmin: false, loading: false, signOut: vi.fn() });
    render(<ContractorShell active="opportunities"><div>x</div></ContractorShell>);
    expect(screen.getByText('Opportunities').closest('a')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Home').closest('a')).not.toHaveAttribute('aria-current');
  });

  it('wires sign-out to the shared signOut', () => {
    const signOut = vi.fn();
    mockAuth({ user: { id: 'c1' }, role: 'contractor', isAdmin: false, loading: false, signOut });
    render(<ContractorShell active="home"><div>x</div></ContractorShell>);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('shows the unread-notification badge when count > 0', () => {
    mockCount(3);
    mockAuth({ user: { id: 'c1' }, role: 'contractor', isAdmin: false, loading: false, signOut: vi.fn() });
    render(<ContractorShell active="home"><div>x</div></ContractorShell>);
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});
