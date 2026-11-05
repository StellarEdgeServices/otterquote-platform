import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: () => ({ count: 0, loading: false, error: null }),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      getSession: vi.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      signOut: vi.fn(),
    },
  },
}));
vi.mock('../../_d407/use-d407-claim', () => ({
  useD407Data: vi.fn(),
  saveClaim: vi.fn(() => Promise.resolve()),
  saveContact: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../help-materials/use-help-materials-data', () => ({
  useDesignerProducts: () => ({ products: [], loading: false, error: null }),
  useCurrentClaimId: vi.fn(),
  saveMaterialSelection: vi.fn(),
}));
vi.mock('../../dashboard/actions', () => ({ uploadClaimDocument: vi.fn(() => Promise.resolve({ ok: true })) }));

import { useAuthReady } from '@/hooks/use-auth-ready';
import { useD407Data, saveClaim, saveContact } from '../../_d407/use-d407-claim';
import { uploadClaimDocument } from '../../dashboard/actions';
import Page from '../page';

const authed = {
  user: { id: 'u1', email: 'jane@example.com' },
  role: 'homeowner',
  isAdmin: false,
  loading: false,
  settled: true,
  signOut: vi.fn(),
};

function wire(claim: Record<string, unknown>, profile: Record<string, unknown> = { full_name: 'Jane Doe', phone: '317-555-0100' }) {
  (useAuthReady as unknown as ReturnType<typeof vi.fn>).mockReturnValue(authed);
  (useD407Data as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    claim: { id: 'c1', user_id: 'u1', property_address: '1 Main St', property_city: 'Indianapolis', property_state: 'IN', property_zip: '46201', ...claim },
    profile,
    loading: false,
    error: null,
  });
}

async function pickShingle3Tab() {
  fireEvent.click(await screen.findByText('Shingles'));
  fireEvent.click(await screen.findByText('3-Tab Shingle'));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RCV page', () => {
  it('NEGATIVE CONTROL: required items missing -> Continue does not save', async () => {
    wire({ policy_type: 'rcv', has_estimate: false });
    render(<Page />);
    fireEvent.click(await screen.findByTestId('d407-continue'));
    const list = await screen.findByTestId('d407-missing');
    expect(list.textContent).toContain('Insurance estimate upload');
    expect(list.textContent).toContain('Material selection');
    expect(saveClaim).not.toHaveBeenCalled();
    expect(saveContact).not.toHaveBeenCalled();
  });

  it('missing phone blocks advance even with estimate and materials', async () => {
    wire({ policy_type: 'rcv', has_estimate: true }, { full_name: 'Jane Doe', phone: '' });
    render(<Page />);
    await pickShingle3Tab();
    fireEvent.click(screen.getByTestId('d407-continue'));
    expect((await screen.findByTestId('d407-missing')).textContent).toContain('Phone');
    expect(saveClaim).not.toHaveBeenCalled();
  });

  it('complete page saves contact + one claims write with no policy_type', async () => {
    wire({ policy_type: 'rcv', has_estimate: true });
    render(<Page />);
    await pickShingle3Tab();
    fireEvent.click(screen.getByTestId('d407-continue'));
    await waitFor(() => expect(saveClaim).toHaveBeenCalledTimes(1));
    expect(saveContact).toHaveBeenCalledWith('u1', 'Jane Doe', '317-555-0100');
    const [claimId, update] = (saveClaim as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(claimId).toBe('c1');
    expect(update.job_type).toBe('insurance_rcv');
    expect(update.has_material_selection).toBe(true);
    expect('policy_type' in update).toBe(false);
  });

  it('estimate upload uses the existing uploadClaimDocument (kind estimate) and flips to done', async () => {
    wire({ policy_type: 'rcv', has_estimate: false });
    render(<Page />);
    const input = await screen.findByTestId('d407-estimate-input');
    const file = new File(['x'], 'estimate.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId('d407-estimate-done')).toBeTruthy());
    expect((uploadClaimDocument as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      kind: 'estimate',
      claimId: 'c1',
      userId: 'u1',
    });
  });

  it('stored rcv shows the Replacement Cost Value banner', async () => {
    wire({ policy_type: 'rcv' });
    render(<Page />);
    expect((await screen.findByTestId('d407-policy-banner')).textContent).toContain('Replacement Cost Value');
  });

  it.each([['idk'], [null], ['acv']])('stored policy %s: NO policy-type assertion and no overwrite', async (stored) => {
    wire({ policy_type: stored, has_estimate: true });
    const { container } = render(<Page />);
    await screen.findByTestId('d407-continue');
    expect(screen.queryByTestId('d407-policy-banner')).toBeNull();
    expect(container.textContent).not.toMatch(/Replacement Cost/i);
    await pickShingle3Tab();
    fireEvent.click(screen.getByTestId('d407-continue'));
    await waitFor(() => expect(saveClaim).toHaveBeenCalledTimes(1));
    const update = (saveClaim as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect('policy_type' in update).toBe(false);
    expect('job_type' in update).toBe(false);
  });
});
