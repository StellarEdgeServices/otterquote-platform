/**
 * Tests for AdminNav — D-211 Phase 8 admin shell nav bar.
 *
 * next/link is mocked so both React-route links and static <a> links render as
 * <a> elements in jsdom; we distinguish them by the data-nextlink attribute.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} data-nextlink="true" {...props}>
      {children}
    </a>
  ),
}));

import { AdminNav } from '../AdminNav';
import { ADMIN_NAV_LINKS } from '../admin-nav-links';

describe('AdminNav', () => {
  it('renders all canonical links', () => {
    render(<AdminNav active="contractors" />);
    ADMIN_NAV_LINKS.forEach((link) => {
      expect(screen.getByRole('link', { name: link.label })).toBeInTheDocument();
    });
  });

  it('applies aria-current=page to the active key and not to others', () => {
    render(<AdminNav active="referrals" />);
    expect(screen.getByRole('link', { name: 'Referrals' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Contractors' })).not.toHaveAttribute(
      'aria-current',
    );
    expect(screen.getByRole('link', { name: 'Payouts' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('emits a next/link (data-nextlink) for React-route links (Contractors, Payouts)', () => {
    render(<AdminNav active="contractors" />);
    const contractorsLink = screen.getByRole('link', { name: 'Contractors' });
    expect(contractorsLink).toHaveAttribute('data-nextlink', 'true');
    expect(contractorsLink).toHaveAttribute('href', '/admin/contractors');

    // Payouts migrated to a React route in D-211 Phase 10 (was a static cross-stack link).
    const payoutsLink = screen.getByRole('link', { name: 'Payouts' });
    expect(payoutsLink).toHaveAttribute('data-nextlink', 'true');
    expect(payoutsLink).toHaveAttribute('href', '/admin/payouts');
  });

  it('emits a next/link (data-nextlink) for Referrals (migrated to a React route in D-211 Phase 11)', () => {
    render(<AdminNav active="contractors" />);

    // Referrals migrated to the React route /admin/referrals in D-211 Phase 11
    // (it was the LAST static cross-stack link). Every canonical admin nav link
    // is now a React route; AdminNav's plain-<a> branch is retained but no longer
    // exercised by the real ADMIN_NAV_LINKS list.
    const referralsLink = screen.getByRole('link', { name: 'Referrals' });
    expect(referralsLink).toHaveAttribute('data-nextlink', 'true');
    expect(referralsLink).toHaveAttribute('href', '/admin/referrals');
  });

  it('emits a next/link (data-nextlink) for the Warranty Drift React route', () => {
    render(<AdminNav active="warranty-drift" />);
    const wdLink = screen.getByRole('link', { name: 'Warranty Drift' });
    expect(wdLink).toHaveAttribute('data-nextlink', 'true');
    expect(wdLink).toHaveAttribute('href', '/admin/warranty-drift');
  });

  it('applies active styling class (is-active) to the active key', () => {
    render(<AdminNav active="payouts" />);
    expect(screen.getByRole('link', { name: 'Payouts' }).className).toContain('is-active');
    expect(screen.getByRole('link', { name: 'Contractors' }).className).not.toContain('is-active');
    expect(screen.getByRole('link', { name: 'Referrals' }).className).not.toContain('is-active');
  });
});
