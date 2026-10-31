import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

describe('Out-of-pocket page', () => {
  it('NEGATIVE CONTROL: no measurement and no materials -> Continue does not save', async () => {
    wire({ has_measurements: false });
    render(<Page />);
    fireEvent.click(await screen.findByTestId('d407-continue'));
    const list = await screen.findByTestId('d407-missing');
    expect(list.textContent).toContain('Measurement report');
    expect(list.textContent).toContain('Material selection');
    expect(saveClaim).not.toHaveBeenCalled();
    expect(saveContact).not.toHaveBeenCalled();
  });

  it('missing measurement alone blocks advance (materials and contact present)', async () => {
    wire({ has_measurements: false });
    render(<Page />);
    await pickShingle3Tab();
    fireEvent.click(screen.getByTestId('d407-continue'));
    expect((await screen.findByTestId('d407-missing')).textContent).toContain('Measurement report');
    expect(saveClaim).not.toHaveBeenCalled();
  });

  it('missing phone blocks advance', async () => {
    wire({ has_measurements: true }, { full_name: 'Jane Doe', phone: '' });
    render(<Page />);
    await pickShingle3Tab();
    fireEvent.click(screen.getByTestId('d407-continue'));
    expect((await screen.findByTestId('d407-missing')).textContent).toContain('Phone');
    expect(saveClaim).not.toHaveBeenCalled();
  });

  it('upload path: uploadClaimDocument kind measurements, then the page can finish with one claims write', async () => {
    wire({ has_measurements: false });
    render(<Page />);
    const input = await screen.findByTestId('d407-measurement-input');
    fireEvent.change(input, { target: { files: [new File(['x'], 'report.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(screen.getByTestId('d407-measurement-done')).toBeTruthy());
    expect((uploadClaimDocument as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      kind: 'measurements',
      claimId: 'c1',
      userId: 'u1',
    });
    await pickShingle3Tab();
    fireEvent.click(screen.getByTestId('d407-continue'));
    await waitFor(() => expect(saveClaim).toHaveBeenCalledTimes(1));
    const [claimId, update] = (saveClaim as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(claimId).toBe('c1');
    expect(update.job_type).toBe('retail');
    expect(update.funding_type).toBe('cash');
    expect(update.has_material_selection).toBe(true);
  });

  it('purchase path: links to the existing help-measurements flow with the claim id', async () => {
    wire({ has_measurements: false });
    render(<Page />);
    const link = (await screen.findByTestId('d407-purchase-link')) as HTMLAnchorElement;
    expect(link.href).toBe('https://otterquote.com/help-measurements.html?claim_id=c1');
  });

  it('a claim that already has a measurement shows it attached', async () => {
    wire({ has_measurements: true });
    render(<Page />);
    expect(await screen.findByTestId('d407-measurement-done')).toBeTruthy();
    expect(screen.queryByTestId('d407-purchase-link')).toBeNull();
  });

  it('MONEY: no price is typed in this route (no dollar amount in copy.ts or page.tsx)', () => {
    for (const f of ['copy.ts', 'page.tsx']) {
      const src = readFileSync(join(__dirname, '..', f), 'utf-8');
      expect(src).not.toMatch(/\$\s?\d/);
    }
  });
});
