/**
 * Tests for RequireAdmin — D-211 Phase 8 admin shell gate.
 *
 * Gate-on-settled contract (postmortem 2026-06-16): the gate must NOT render
 * children OR the Unauthorized panel until auth is DEFINITIVELY resolved
 * (`settled`). The provider's 1.5s blank-screen fallback can flip `loading` to
 * false with a null user mid-hydration; we wait for `settled`, not `loading`.
 *
 * No-redirect contract: on unauthorized, an inline panel is shown. The edge
 * middleware (middleware.ts) already redirects non-admins before render, so a
 * client-side redirect would risk a loop.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/providers/auth-provider', () => ({ useAuth: vi.fn() }));

import { useAuth } from '@/providers/auth-provider';
import { RequireAdmin } from '../RequireAdmin';

type AuthVal = ReturnType<typeof vi.fn>;
const mockAuth = (v: unknown) =>
  (useAuth as unknown as AuthVal).mockReturnValue(v);

const SUPER_USER = { id: 'u1', email: 'dustinstohler1@gmail.com' };
const SECOND_SUPER = { id: 'u2', email: 'dustin@otterquote.com' };
const REVIEWER_USER = { id: 'u3', email: 'reviewer@example.com' };
const PLAIN_USER = { id: 'u4', email: 'nobody@example.com' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RequireAdmin — gate-on-settled (no flash)', () => {
  it('renders neither children nor the Unauthorized panel while not settled (unauthenticated)', () => {
    mockAuth({ user: null, isAdmin: false, settled: false });
    render(<RequireAdmin tier="super"><div>secret</div></RequireAdmin>);
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    expect(screen.queryByText(/Unauthorized/i)).not.toBeInTheDocument();
  });

  it('renders neither children nor the Unauthorized panel while not settled (with a super-admin user)', () => {
    mockAuth({ user: SUPER_USER, isAdmin: true, settled: false });
    render(<RequireAdmin tier="super"><div>secret</div></RequireAdmin>);
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    expect(screen.queryByText(/Unauthorized/i)).not.toBeInTheDocument();
  });

  it('renders neither children nor Unauthorized panel while not settled (reviewer tier)', () => {
    mockAuth({ user: REVIEWER_USER, isAdmin: true, settled: false });
    render(<RequireAdmin tier="reviewer"><div>secret</div></RequireAdmin>);
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    expect(screen.queryByText(/Unauthorized/i)).not.toBeInTheDocument();
  });
});

describe('RequireAdmin tier=super', () => {
  it('admits a user in the ADMIN_EMAILS allow-list (primary email)', () => {
    mockAuth({ user: SUPER_USER, isAdmin: true, settled: true });
    render(<RequireAdmin tier="super"><div>admin content</div></RequireAdmin>);
    expect(screen.getByText('admin content')).toBeInTheDocument();
    expect(screen.queryByText(/Unauthorized/i)).not.toBeInTheDocument();
  });

  it('admits the second allow-list email', () => {
    mockAuth({ user: SECOND_SUPER, isAdmin: true, settled: true });
    render(<RequireAdmin tier="super"><div>admin content</div></RequireAdmin>);
    expect(screen.getByText('admin content')).toBeInTheDocument();
    expect(screen.queryByText(/Unauthorized/i)).not.toBeInTheDocument();
  });

  it('rejects a user not in the ADMIN_EMAILS allow-list', () => {
    mockAuth({ user: PLAIN_USER, isAdmin: false, settled: true });
    render(<RequireAdmin tier="super"><div>admin content</div></RequireAdmin>);
    expect(screen.queryByText('admin content')).not.toBeInTheDocument();
    expect(screen.getByText(/Unauthorized/i)).toBeInTheDocument();
    expect(screen.getByText(/restricted to administrators/i)).toBeInTheDocument();
  });

  it('rejects a reviewer-only user (template_review_role=admin, not in allow-list)', () => {
    // isAdmin=true via template_review_role, but email not in ADMIN_EMAILS — super tier must deny
    mockAuth({ user: REVIEWER_USER, isAdmin: true, settled: true });
    render(<RequireAdmin tier="super"><div>admin content</div></RequireAdmin>);
    expect(screen.queryByText('admin content')).not.toBeInTheDocument();
    expect(screen.getByText(/Unauthorized/i)).toBeInTheDocument();
  });

  it('shows the Unauthorized panel (no redirect) when settled and unauthenticated', () => {
    mockAuth({ user: null, isAdmin: false, settled: true });
    render(<RequireAdmin tier="super"><div>secret</div></RequireAdmin>);
    expect(screen.getByText(/Unauthorized/i)).toBeInTheDocument();
    expect(screen.getByText(/restricted to administrators/i)).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });
});

describe('RequireAdmin tier=reviewer', () => {
  it('admits a user with isAdmin=true (template_review_role path)', () => {
    mockAuth({ user: REVIEWER_USER, isAdmin: true, settled: true });
    render(<RequireAdmin tier="reviewer"><div>reviewer content</div></RequireAdmin>);
    expect(screen.getByText('reviewer content')).toBeInTheDocument();
    expect(screen.queryByText(/Unauthorized/i)).not.toBeInTheDocument();
  });

  it('admits a super-admin user (also isAdmin via allow-list)', () => {
    mockAuth({ user: SUPER_USER, isAdmin: true, settled: true });
    render(<RequireAdmin tier="reviewer"><div>reviewer content</div></RequireAdmin>);
    expect(screen.getByText('reviewer content')).toBeInTheDocument();
    expect(screen.queryByText(/Unauthorized/i)).not.toBeInTheDocument();
  });

  it('rejects a user with isAdmin=false', () => {
    mockAuth({ user: PLAIN_USER, isAdmin: false, settled: true });
    render(<RequireAdmin tier="reviewer"><div>reviewer content</div></RequireAdmin>);
    expect(screen.queryByText('reviewer content')).not.toBeInTheDocument();
    expect(screen.getByText(/Unauthorized/i)).toBeInTheDocument();
    expect(screen.getByText(/restricted to administrators/i)).toBeInTheDocument();
  });

  it('rejects unauthenticated user', () => {
    mockAuth({ user: null, isAdmin: false, settled: true });
    render(<RequireAdmin tier="reviewer"><div>reviewer content</div></RequireAdmin>);
    expect(screen.queryByText('reviewer content')).not.toBeInTheDocument();
    expect(screen.getByText(/Unauthorized/i)).toBeInTheDocument();
  });
});
