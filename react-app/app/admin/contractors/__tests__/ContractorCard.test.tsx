/**
 * XSS-fold + action-wiring tests for ContractorCard (D-211 Phase 8, §6.1 finding).
 *
 * The static renderContractors() interpolated contractor-controlled values into an
 * HTML string and into onclick="…('${c.company_name}')" handlers — a quote/markup in
 * a value broke out and injected JS. These tests pin the React fix:
 *   • a malicious company_name renders as INERT TEXT (no injected <img>/<script>);
 *   • every action fires as an onClick closure receiving the contractor OBJECT,
 *     never a string-built handler.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContractorCard } from '../ContractorCard';
import type { Contractor } from '../utils';

const XSS = `"><img src=x onerror=alert(1)><script>alert('pwn')</script>`;

function makeContractor(over: Partial<Contractor> = {}): Contractor {
  return {
    id: 'c-1',
    status: 'pending_approval',
    created_at: '2026-06-01T00:00:00Z',
    company_name: XSS,
    contact_name: XSS,
    email: 'evil@example.com',
    service_counties: ['Marion-IN'],
    ...over,
  };
}

function noopProps() {
  return {
    onMarkLicenseVerified: vi.fn(),
    onSearchLicenseBoard: vi.fn(),
    onRequestInsurance: vi.fn(),
    onMarkInsuranceVerified: vi.fn(),
    onSaveNotes: vi.fn(async () => true),
    onApprove: vi.fn(),
    onReject: vi.fn(),
  };
}

describe('ContractorCard — XSS fold', () => {
  it('renders a malicious company_name as inert text (no injected nodes)', () => {
    const c = makeContractor();
    const { container } = render(
      <ContractorCard contractor={c} expanded onToggleExpand={vi.fn()} {...noopProps()} />,
    );
    // The payload appears as literal text…
    expect(screen.getAllByText(/onerror=alert\(1\)/).length).toBeGreaterThan(0);
    // …but no actual <img> or <script> was injected into the DOM.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('mailto href is a literal attribute value, not an injection vector', () => {
    const c = makeContractor({ email: 'a@b.com' });
    const { container } = render(
      <ContractorCard contractor={c} expanded onToggleExpand={vi.fn()} {...noopProps()} />,
    );
    const link = container.querySelector('a[href^="mailto:"]') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('mailto:a@b.com');
  });
});

describe('ContractorCard — actions are onClick closures over the contractor', () => {
  it('Approve / Reject pass the contractor object', () => {
    const c = makeContractor();
    const props = noopProps();
    render(<ContractorCard contractor={c} expanded onToggleExpand={vi.fn()} {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Approve Contractor/i }));
    expect(props.onApprove).toHaveBeenCalledWith(c);

    fireEvent.click(screen.getByRole('button', { name: /Reject Application/i }));
    expect(props.onReject).toHaveBeenCalledWith(c);
  });

  it('License board + mark-verified pass the contractor object', () => {
    const c = makeContractor({ license_verified: false, insurance_verified: false });
    const props = noopProps();
    render(<ContractorCard contractor={c} expanded onToggleExpand={vi.fn()} {...props} />);

    fireEvent.click(screen.getByRole('button', { name: /Search State License Board/i }));
    expect(props.onSearchLicenseBoard).toHaveBeenCalledWith(c);

    fireEvent.click(screen.getByRole('button', { name: /Request Verification Email/i }));
    expect(props.onRequestInsurance).toHaveBeenCalledWith(c);
  });

  it('does not render approve/reject for a non-pending contractor', () => {
    const c = makeContractor({ status: 'active' });
    render(<ContractorCard contractor={c} expanded onToggleExpand={vi.fn()} {...noopProps()} />);
    expect(screen.queryByRole('button', { name: /Approve Contractor/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reject Application/i })).toBeNull();
  });
});
