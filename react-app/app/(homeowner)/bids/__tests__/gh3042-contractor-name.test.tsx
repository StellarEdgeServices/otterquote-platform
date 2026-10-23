import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// gh-3042: a homeowner cannot SELECT the `contractors` base table (RLS), so the
// profile read must go through the get_contractors_public() RPC or the company
// name is blank on the card AND in the select-confirmation modal.
const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { rpc, from } }));
vi.mock('../actions', () => ({
  awardClaimToContractor: vi.fn(),
  checkContractorPaymentMethod: vi.fn(),
  notifyContractorPaymentNeeded: vi.fn(),
  resolveOwnerPhotoUrl: vi.fn(),
}));

import { fetchBidContractors } from '../use-bids-data';
import { SelectContractorModal } from '../components/SelectContractorModal';
import { BidCard } from '../components/BidCard';
import { licenseChip } from '../utils';
import type { BidRow, BidsClaim, ContractorProfile } from '../types';

const ROW = {
  id: '2bc792be-0000-0000-0000-000000000000',
  company_name: 'Video Walk Test Roofing 2 LLC',
  status: 'active',
  license_doc_state: 'uploaded',
};
const bid = { id: 'b1', claim_id: 'c1', contractor_id: ROW.id, bid_status: 'submitted' } as BidRow;
const claim = { id: 'c1', user_id: 'u1', status: 'bidding' } as BidsClaim;

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
});

describe('fetchBidContractors reads the homeowner-safe RPC', () => {
  it('uses rpc(get_contractors_public), never the contractors base table, and keys rows by id', async () => {
    const inFn = vi.fn().mockResolvedValue({ data: [ROW], error: null });
    const select = vi.fn().mockReturnValue({ in: inFn });
    rpc.mockReturnValue({ select });
    const map = await fetchBidContractors([ROW.id]);
    expect(rpc).toHaveBeenCalledWith('get_contractors_public');
    expect(from).not.toHaveBeenCalled();
    expect(select.mock.calls[0][0]).not.toMatch(/\buser_id\b|license_path/);
    expect(inFn).toHaveBeenCalledWith('id', [ROW.id]);
    expect(map?.[ROW.id].company_name).toBe('Video Walk Test Roofing 2 LLC');
  });

  it('returns null on an RPC error (no silent empty map)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    rpc.mockReturnValue({ select: () => ({ in: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) });
    expect(await fetchBidContractors([ROW.id])).toBeNull();
    err.mockRestore();
  });
});

describe('company name renders in modal and card from the same profile', () => {
  const contractor = ROW as unknown as ContractorProfile;

  it('modal confirmation names the contractor', () => {
    render(<SelectContractorModal bid={bid} claim={claim} contractor={contractor} onClose={() => {}} />);
    expect(screen.getByText('Video Walk Test Roofing 2 LLC').tagName).toBe('STRONG');
    expect(screen.queryByText('this contractor')).toBeNull();
  });

  it('modal only falls back to "this contractor" when the name is truly absent/blank', () => {
    render(<SelectContractorModal bid={bid} claim={claim} contractor={{ id: ROW.id, company_name: '  ' }} onClose={() => {}} />);
    expect(screen.getByText('this contractor')).toBeInTheDocument();
  });

  it('bid card shows the same name', () => {
    render(
      <BidCard bid={bid} bids={[bid]} claim={claim} contractor={contractor} licenses={[]}
        onSelect={() => {}} onRenew={() => {}} onCredentials={() => {}} renewalState="idle" />,
    );
    expect(screen.getAllByText('Video Walk Test Roofing 2 LLC').length).toBeGreaterThan(0);
  });

  it('license chip honours RPC license_doc_state (license_path is not in the view)', () => {
    expect(licenseChip(contractor, []).kind).toBe('on-file');
  });
});

import { CredentialEducationModal } from '../components/CredentialEducationModal';
import { hasLicenseOnFile } from '../utils';

describe('credential modal agrees with the chip (license_doc_state)', () => {
  const c = { id: 'x', license_doc_state: 'uploaded' } as ContractorProfile;
  it('hasLicenseOnFile honours license_doc_state', () => {
    expect(hasLicenseOnFile(c, [])).toBe(true);
    expect(hasLicenseOnFile({ id: 'x', license_doc_state: 'not_provided' } as ContractorProfile, [])).toBe(false);
  });
  it('modal does not claim "not provided" when the chip says on file', () => {
    const { container: onFile } = render(<CredentialEducationModal contractor={c} licenses={[]} onClose={() => {}} />);
    const { container: none } = render(
      <CredentialEducationModal contractor={{ id: 'y', license_doc_state: 'not_provided' } as ContractorProfile} licenses={[]} onClose={() => {}} />,
    );
    expect(onFile.textContent).not.toEqual(none.textContent);
  });
});
