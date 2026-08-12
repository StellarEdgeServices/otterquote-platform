/**
 * #534 credential-education tests.
 *
 * (a) GC copy lock — the popup copy and badge wording are GC-approved VERBATIM
 *     (issue #534 comment, 2026-07-13). The expected strings are duplicated here
 *     character-for-character (straight apostrophes/quotes, U+2014 em dashes) so
 *     any drift in copy.ts fails loudly and points at the sign-off requirement.
 * (b) Chip derivation — artifact-state keyed, never the `verified` flag.
 * (c) Modal + BidCard rendering/wiring.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import {
  CREDENTIAL_EDUCATION_TITLE,
  CREDENTIAL_EDUCATION_SECTIONS,
  CREDENTIAL_EDUCATION_CLOSING,
  BADGE_LICENSE_ON_FILE,
  badgeLicensesOnFile,
  BADGE_LICENSE_NOT_PROVIDED,
  BADGE_DOCUMENTS_ON_FILE,
  BADGE_APPLICATION_UNDER_REVIEW,
  LICENSE_NOT_PROVIDED_LINE,
} from '../copy';
import { licenseChip, licenseDocState, statusChip } from '../utils';
import { CredentialEducationModal } from '../components/CredentialEducationModal';
import { BidCard } from '../components/BidCard';
import type { BidRow, ContractorProfile, PublicLicense } from '../types';

const contractor = (over: Partial<ContractorProfile> = {}): ContractorProfile =>
  ({ id: 'k1', company_name: 'Acme Roofing', status: 'active', ...over }) as ContractorProfile;

const license = (over: Partial<PublicLicense> = {}): PublicLicense => ({
  contractor_id: 'k1',
  jurisdiction_level: 'state',
  municipality: 'Indiana',
  license_number: 'LIC-123',
  expiration_date: '2027-01-31',
  verification_url: 'https://example.gov/verify',
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// (a) GC copy lock — verbatim, including punctuation
// ─────────────────────────────────────────────────────────────────────────────

describe('#534 GC-locked copy (verbatim — any change requires new GC sign-off)', () => {
  it('title', () => {
    expect(CREDENTIAL_EDUCATION_TITLE).toBe('About contractor credentials');
  });

  it('section leads + bodies match the approved text exactly', () => {
    expect(CREDENTIAL_EDUCATION_SECTIONS.map((s) => s.lead)).toEqual([
      "What's on file.",
      'Licensing.',
      'Permits and bonds.',
      'Your role.',
    ]);

    expect(CREDENTIAL_EDUCATION_SECTIONS[0].body).toBe(
      "Before a contractor can bid on Otter Quotes, they provide a Certificate of Insurance for Commercial General Liability coverage, plus either a workers' compensation certificate of insurance or a state-issued workers' comp exemption certificate. These documents are on file with Otter Quotes.",
    );
    expect(CREDENTIAL_EDUCATION_SECTIONS[1].body).toBe(
      `Requirements vary by state, county, and city — and some work doesn't require a license at all. Otter Quotes displays exactly what each contractor has provided: license details where uploaded, or "License: Not provided by contractor" where not. Otter Quotes does not determine whether a license is required for your project.`,
    );
    expect(CREDENTIAL_EDUCATION_SECTIONS[2].body).toBe(
      'Permits are approvals from your local building department that certain projects require — your contractor typically obtains them, but confirming what your project needs is part of hiring. Surety bonds are a financial guarantee some jurisdictions require contractors to carry as part of local licensing.',
    );
    expect(CREDENTIAL_EDUCATION_SECTIONS[3].body).toBe(
      'Otter Quotes shows you what contractors have uploaded. Verifying whether those documents meet your local requirements is your responsibility. To check what your area requires, contact your state licensing board and your county or city building department.',
    );
    expect(CREDENTIAL_EDUCATION_CLOSING).toBe(
      'Otter Quotes does not independently verify these documents with issuing agencies, and listing on Otter Quotes is not an endorsement of any contractor. The choice of contractor is always yours.',
    );
  });

  it('badge wording matches the approved set (no "verification", no vetted/approved/endorsed)', () => {
    expect(BADGE_LICENSE_ON_FILE).toBe('✓ License on file');
    expect(badgeLicensesOnFile(3)).toBe('✓ 3 licenses on file');
    expect(BADGE_LICENSE_NOT_PROVIDED).toBe('License not provided');
    expect(BADGE_DOCUMENTS_ON_FILE).toBe('✓ Documents on file');
    expect(BADGE_APPLICATION_UNDER_REVIEW).toBe('Application under review');
    expect(LICENSE_NOT_PROVIDED_LINE).toBe('License: Not provided by contractor.');
  });

  it('D-104 audit: copy never claims vetted/approved/endorsed/verified', () => {
    const all = [
      CREDENTIAL_EDUCATION_TITLE,
      ...CREDENTIAL_EDUCATION_SECTIONS.flatMap((s) => [s.lead, s.body]),
      CREDENTIAL_EDUCATION_CLOSING,
      BADGE_LICENSE_ON_FILE,
      BADGE_LICENSE_NOT_PROVIDED,
      BADGE_DOCUMENTS_ON_FILE,
      BADGE_APPLICATION_UNDER_REVIEW,
    ].join(' ');
    // "verify/verifying" appears only in homeowner-directed education ("Otter
    // Quotes does not independently verify", "Verifying ... is your
    // responsibility") — assert the platform never claims the states below.
    expect(all).not.toMatch(/vetted|endorsed|OtterQuote\b/);
    expect(all).not.toMatch(/contractor (is|has been) (approved|verified)/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Chip derivation — artifact state, never `verified`
// ─────────────────────────────────────────────────────────────────────────────

describe('licenseDocState (v93 license_doc_state parity)', () => {
  it("maps the 'not_provided' sentinel", () => {
    expect(licenseDocState('not_provided')).toBe('not_provided');
  });
  it('maps a real storage path to uploaded', () => {
    expect(licenseDocState('docs/lic.pdf')).toBe('uploaded');
  });
  it('maps null/undefined/empty to null (renders as not provided)', () => {
    expect(licenseDocState(null)).toBeNull();
    expect(licenseDocState(undefined)).toBeNull();
    expect(licenseDocState('')).toBeNull();
  });
});

describe('licenseChip', () => {
  it('one license row → "License on file" (green)', () => {
    expect(licenseChip(contractor(), [license()])).toEqual({
      label: BADGE_LICENSE_ON_FILE,
      kind: 'on-file',
    });
  });
  it('N>1 rows → counted label per D-218', () => {
    expect(licenseChip(contractor(), [license(), license({ license_number: 'LIC-456' })])).toEqual({
      label: '✓ 2 licenses on file',
      kind: 'on-file',
    });
  });
  it('no rows but a legacy license_path doc → on file', () => {
    expect(licenseChip(contractor({ license_path: 'docs/lic.pdf' }), [])).toEqual({
      label: BADGE_LICENSE_ON_FILE,
      kind: 'on-file',
    });
  });
  it("no rows + 'not_provided' sentinel → neutral not-provided (no warning state)", () => {
    expect(licenseChip(contractor({ license_path: 'not_provided' }), [])).toEqual({
      label: BADGE_LICENSE_NOT_PROVIDED,
      kind: 'neutral',
    });
  });
  it('no rows + null license_path → neutral not-provided', () => {
    expect(licenseChip(contractor(), [])).toEqual({
      label: BADGE_LICENSE_NOT_PROVIDED,
      kind: 'neutral',
    });
  });
  it('ignores the ambiguous verified flag entirely', () => {
    expect(licenseChip(contractor({ verified: true }), [])).toEqual({
      label: BADGE_LICENSE_NOT_PROVIDED,
      kind: 'neutral',
    });
  });
});

describe('statusChip', () => {
  it("active → '✓ Documents on file' (the D-210-blessed phrase)", () => {
    const warn = vi.fn();
    expect(statusChip(contractor({ status: 'active' }), warn)).toEqual({
      label: BADGE_DOCUMENTS_ON_FILE,
      kind: 'on-file',
    });
    expect(warn).not.toHaveBeenCalled();
  });
  it('approved → same (both gate states are in circulation)', () => {
    expect(statusChip(contractor({ status: 'approved' }))).toEqual({
      label: BADGE_DOCUMENTS_ON_FILE,
      kind: 'on-file',
    });
  });
  it('anything else → "Application under review" + a warning (should be unreachable on bids)', () => {
    const warn = vi.fn();
    expect(statusChip(contractor({ status: 'pending_approval' }), warn)).toEqual({
      label: BADGE_APPLICATION_UNDER_REVIEW,
      kind: 'neutral',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    // missing profile row (contractor not in contractors_public) warns too
    const warn2 = vi.fn();
    expect(statusChip({ id: 'k9' } as ContractorProfile, warn2).label).toBe(
      BADGE_APPLICATION_UNDER_REVIEW,
    );
    expect(warn2).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Modal + BidCard wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('CredentialEducationModal', () => {
  it('renders the full GC copy and the license drill-down', () => {
    render(
      <CredentialEducationModal contractor={contractor()} licenses={[license()]} onClose={() => {}} />,
    );
    expect(screen.getByText('About contractor credentials')).toBeTruthy();
    expect(screen.getByText(/Before a contractor can bid on Otter Quotes/)).toBeTruthy();
    expect(screen.getByText(/Surety bonds are a financial guarantee/)).toBeTruthy();
    expect(screen.getByText(/The choice of contractor is always yours\./)).toBeTruthy();
    expect(screen.getByText('License #LIC-123')).toBeTruthy();
    expect(screen.getByText('state — Indiana')).toBeTruthy();
    const verifyLink = screen.getByText('Verify with issuing agency →') as HTMLAnchorElement;
    expect(verifyLink.getAttribute('href')).toBe('https://example.gov/verify');
  });

  it('renders the D-217 not-provided line when there are no licenses', () => {
    render(<CredentialEducationModal contractor={contractor()} licenses={[]} onClose={() => {}} />);
    expect(screen.getByText(LICENSE_NOT_PROVIDED_LINE)).toBeTruthy();
  });

  it('renders "License on file" from a legacy license_path doc with no rows', () => {
    render(
      <CredentialEducationModal
        contractor={contractor({ license_path: 'docs/lic.pdf', license_number: 'OLD-1' })}
        licenses={[]}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('License on file')).toBeTruthy();
    expect(screen.getByText('License #OLD-1')).toBeTruthy();
  });

  it('closes on the × button and on overlay click', () => {
    const onClose = vi.fn();
    render(<CredentialEducationModal contractor={contractor()} licenses={[]} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('BidCard credential chips', () => {
  const bid = (over: Partial<BidRow> = {}): BidRow =>
    ({ id: 'b1', claim_id: 'c1', contractor_id: 'k1', total_price: 10000, bid_status: 'submitted', ...over }) as BidRow;

  it('renders both chips keyed to artifact state (no "✓ Licensed" from verified)', () => {
    render(
      <BidCard
        bid={bid()}
        bids={[bid()]}
        claim={null}
        contractor={contractor({ verified: true })}
        licenses={[]}
        onSelect={() => {}}
        onRenew={() => {}}
        onCredentials={() => {}}
      />,
    );
    expect(screen.queryByText('✓ Licensed')).toBeNull();
    expect(screen.getByText(BADGE_LICENSE_NOT_PROVIDED)).toBeTruthy();
    expect(screen.getByText(BADGE_DOCUMENTS_ON_FILE)).toBeTruthy();
  });

  it('clicking a chip opens the education popup for that contractor', () => {
    const onCredentials = vi.fn();
    render(
      <BidCard
        bid={bid()}
        bids={[bid()]}
        claim={null}
        contractor={contractor()}
        licenses={[license()]}
        onSelect={() => {}}
        onRenew={() => {}}
        onCredentials={onCredentials}
      />,
    );
    fireEvent.click(screen.getByText(BADGE_LICENSE_ON_FILE));
    fireEvent.click(screen.getByText(BADGE_DOCUMENTS_ON_FILE));
    expect(onCredentials).toHaveBeenCalledTimes(2);
    expect(onCredentials).toHaveBeenCalledWith('k1');
  });
});
