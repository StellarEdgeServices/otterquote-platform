/**
 * Render + flow tests for the homeowner project-confirmation page (D-211 Phase 26, PR 2/2).
 *
 * Mirrors contract-signing-page.test.tsx strategy: mock the shell's auth + notification
 * hooks, the supabase singleton, and the data layer — drive the data hook's return value
 * directly. Asserts the brief's render-level self-verify requirements.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: () => ({ count: 0, loading: false, error: null }),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() } },
}));

// Mock the data layer — the page test drives its return values directly.
vi.mock('../use-project-confirmation-data', () => ({
  useProjectConfirmationData: vi.fn(),
  saveProjectConfirmation: vi.fn(() => Promise.resolve()),
  createProjectConfirmationEnvelope: vi.fn(),
}));

// Mock docusign-embed so runSigningReturnBridge is a spy.
vi.mock('@/components/docusign-embed', () => ({
  DocuSignEmbed: ({ signingUrl, onComplete }: { signingUrl: string; onComplete: () => void }) => (
    <div>
      <iframe id="docusignFrame" title="DocuSign" src={signingUrl} />
      <button onClick={onComplete} data-testid="complete-signing">Complete</button>
    </div>
  ),
  isSigningCompleteReturn: vi.fn(() => false),
  runSigningReturnBridge: vi.fn(() => false),
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import {
  useProjectConfirmationData,
  saveProjectConfirmation,
  createProjectConfirmationEnvelope,
} from '../use-project-confirmation-data';
import { runSigningReturnBridge } from '@/components/docusign-embed';
import { CONFIRM_COPY as C } from '../copy';
import ProjectConfirmationPage from '../page';

type Fn = ReturnType<typeof vi.fn>;

const authed = (over: Record<string, unknown> = {}) => ({
  user: { id: 'u1', email: 'jane@example.com', user_metadata: { full_name: 'Jane Doe' } },
  role: 'homeowner',
  isAdmin: false,
  loading: false,
  settled: true,
  signOut: vi.fn(),
  ...over,
});

const readyData = (over: Record<string, unknown> = {}) => ({
  claim: {
    id: 'c1',
    status: 'contract_signed',
    selected_contractor_id: 'ctr1',
    user_id: 'u1',
    property_address: '123 Oak St',
    shingle_manufacturer: 'GAF',
    shingle_type: 'Timberline HDZ',
    parsed_line_items: null,
    selected_trades: ['roofing'],
    funding_type: 'insurance',
    job_type: null,
    project_confirmation: null,
  },
  contractor: { id: 'ctr1', company_name: 'Acme Roofing', years_in_business: 10, logo_url: null },
  quote: { brand: 'GAF', product_line: 'Timberline HDZ', decking_price_per_sheet: 75, status: 'awarded' },
  contractorId: 'ctr1',
  homeownerName: 'Jane Doe',
  depreciation: 1500,
  deckingRatePerSheet: 75,
  existingConfirmation: null,
  gate: 'ready',
  loading: false,
  error: null,
  ...over,
});

beforeEach(() => {
  (useAuthReady as unknown as Fn).mockReturnValue(authed());
  (useProjectConfirmationData as unknown as Fn).mockReturnValue(readyData());
  (runSigningReturnBridge as unknown as Fn).mockReturnValue(false);
  window.history.replaceState({}, '', '/project-confirmation?claim_id=c1');
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── 1. Verbatim disclosure copy from copy.ts renders on the form ───────────────

describe('project-confirmation page — verbatim disclosure copy', () => {
  it('renders the Bad Decking disclosure (TIER-3 verbatim)', async () => {
    render(<ProjectConfirmationPage />);
    // Bad decking disclosure text is rendered
    expect(await screen.findByText(C.badDeckingDisclosure)).toBeTruthy();
  });

  it('renders the Bad Decking ack label verbatim', async () => {
    render(<ProjectConfirmationPage />);
    await screen.findByText(C.badDeckingDisclosure);
    expect(screen.getByText(C.badDeckingAckLabel)).toBeTruthy();
  });

  it('renders the Payment Terms disclosure verbatim', async () => {
    render(<ProjectConfirmationPage />);
    expect(await screen.findByText(C.paymentTermsDisclosure)).toBeTruthy();
    expect(screen.getByText(C.paymentTermsAckLabel)).toBeTruthy();
  });

  it('renders the Project Changes disclosure verbatim', async () => {
    render(<ProjectConfirmationPage />);
    await screen.findByText(C.paymentTermsDisclosure);
    expect(screen.getByText(C.projectChangesDisclosure)).toBeTruthy();
    expect(screen.getByText(C.projectChangesAckLabel)).toBeTruthy();
  });

  it('renders Info Correct ack label verbatim', async () => {
    render(<ProjectConfirmationPage />);
    await screen.findByText(C.paymentTermsDisclosure);
    expect(screen.getByText(C.infoCorrectLabel)).toBeTruthy();
    expect(screen.getByText(C.infoCorrectSublabel)).toBeTruthy();
  });

  it('renders the depreciation disclosure when isInsurance=true', async () => {
    render(<ProjectConfirmationPage />);
    await screen.findByText(C.paymentTermsDisclosure);
    expect(screen.getByText(C.depreciationAckLabel)).toBeTruthy();
    expect(screen.getByText(C.depreciationAckSublabel)).toBeTruthy();
  });

  it('hides the depreciation ack when claim is NOT insurance', async () => {
    (useProjectConfirmationData as unknown as Fn).mockReturnValue(
      readyData({
        claim: {
          id: 'c1', status: 'contract_signed', selected_contractor_id: 'ctr1',
          user_id: 'u1', property_address: '123 Oak St', shingle_manufacturer: null,
          shingle_type: null, parsed_line_items: null, selected_trades: ['roofing'],
          funding_type: 'retail', job_type: null, project_confirmation: null,
        },
      }),
    );
    render(<ProjectConfirmationPage />);
    await screen.findByText(C.paymentTermsDisclosure);
    expect(screen.queryByText(C.depreciationAckLabel)).toBeNull();
  });
});

// ── 2. Submit is gated until all applicable acks checked AND shingle color present ──

describe('project-confirmation page — submit gate', () => {
  it('submit button is disabled initially (no acks checked, no color)', async () => {
    render(<ProjectConfirmationPage />);
    const btn = (await screen.findByRole('button', { name: /Submit Project Confirmation/ })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('submit button is still disabled with acks checked but no shingle color', async () => {
    render(<ProjectConfirmationPage />);
    await screen.findByRole('button', { name: /Submit Project Confirmation/ });

    // Check all visible acks
    const checkboxes = document.querySelectorAll('.oqpc-ack-checkbox');
    checkboxes.forEach((cb) => fireEvent.click(cb));

    const btn = document.getElementById('submitBtn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('submit button enables when acks checked AND shingle color entered', async () => {
    render(<ProjectConfirmationPage />);
    await screen.findByRole('button', { name: /Submit Project Confirmation/ });

    // Enter shingle color
    const colorInput = document.getElementById('shingleColor') as HTMLInputElement;
    fireEvent.change(colorInput, { target: { value: 'Charcoal' } });

    // Check all ack checkboxes
    const checkboxes = document.querySelectorAll('.oqpc-ack-checkbox');
    checkboxes.forEach((cb) => fireEvent.click(cb));

    await waitFor(() => {
      const btn = document.getElementById('submitBtn') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
  });
});

// ── 3. Submit saves first THEN calls createProjectConfirmationEnvelope ─────────

describe('project-confirmation page — submit flow', () => {
  it('calls saveProjectConfirmation THEN createProjectConfirmationEnvelope, then shows iframe', async () => {
    (createProjectConfirmationEnvelope as unknown as Fn).mockResolvedValue({
      signingUrl: 'https://ds/sign?token=proj',
      envelopeId: 'env-1',
    });

    render(<ProjectConfirmationPage />);
    await screen.findByRole('button', { name: /Submit Project Confirmation/ });

    // Fill shingle color
    const colorInput = document.getElementById('shingleColor') as HTMLInputElement;
    fireEvent.change(colorInput, { target: { value: 'Charcoal' } });

    // Check all acks
    const checkboxes = document.querySelectorAll('.oqpc-ack-checkbox');
    checkboxes.forEach((cb) => fireEvent.click(cb));

    // Click submit
    await waitFor(() => {
      const btn = document.getElementById('submitBtn') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
    fireEvent.click(document.getElementById('submitBtn') as HTMLButtonElement);

    // saveProjectConfirmation called first
    await waitFor(() =>
      expect(saveProjectConfirmation as unknown as Fn).toHaveBeenCalledTimes(1),
    );
    expect((saveProjectConfirmation as unknown as Fn).mock.calls[0][0]).toBe('c1');

    // createProjectConfirmationEnvelope called with correct args
    await waitFor(() =>
      expect(createProjectConfirmationEnvelope as unknown as Fn).toHaveBeenCalledTimes(1),
    );
    const efArg = (createProjectConfirmationEnvelope as unknown as Fn).mock.calls[0][0];
    expect(efArg).toMatchObject({
      claimId: 'c1',
      contractorId: 'ctr1',
    });
    expect(efArg.origin).toBe(window.location.origin);

    // DocuSign iframe appears with the signing URL
    await waitFor(() => {
      const frame = document.getElementById('docusignFrame') as HTMLIFrameElement | null;
      expect(frame?.getAttribute('src')).toBe('https://ds/sign?token=proj');
    });
  });
});

// ── 4. onComplete → success screen "Confirmation Submitted!" ──────────────────

describe('project-confirmation page — onComplete success screen', () => {
  it('shows the success screen with /dashboard link after onComplete fires', async () => {
    (createProjectConfirmationEnvelope as unknown as Fn).mockResolvedValue({
      signingUrl: 'https://ds/sign?token=proj',
      envelopeId: null,
    });

    render(<ProjectConfirmationPage />);
    await screen.findByRole('button', { name: /Submit Project Confirmation/ });

    const colorInput = document.getElementById('shingleColor') as HTMLInputElement;
    fireEvent.change(colorInput, { target: { value: 'Slate' } });
    const checkboxes = document.querySelectorAll('.oqpc-ack-checkbox');
    checkboxes.forEach((cb) => fireEvent.click(cb));

    await waitFor(() => {
      const btn = document.getElementById('submitBtn') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
    fireEvent.click(document.getElementById('submitBtn') as HTMLButtonElement);

    // Wait for iframe
    await waitFor(() => screen.findByTestId('complete-signing'));

    // Click the complete button (simulates DocuSign postMessage completion)
    fireEvent.click(screen.getByTestId('complete-signing'));

    // Success screen
    expect(await screen.findByText('Confirmation Submitted!')).toBeTruthy();
    const link = screen.getByRole('link', { name: /Go to My Dashboard/ });
    expect(link.getAttribute('href')).toBe('/dashboard');
  });
});

// ── 5. Graceful EF failure: save happened, signing unavailable shown ───────────

describe('project-confirmation page — graceful EF failure', () => {
  it('shows the ef-failed state when createProjectConfirmationEnvelope rejects, save was still called', async () => {
    (createProjectConfirmationEnvelope as unknown as Fn).mockRejectedValue(
      new Error('EF unavailable'),
    );

    render(<ProjectConfirmationPage />);
    await screen.findByRole('button', { name: /Submit Project Confirmation/ });

    const colorInput = document.getElementById('shingleColor') as HTMLInputElement;
    fireEvent.change(colorInput, { target: { value: 'Birchwood' } });
    const checkboxes = document.querySelectorAll('.oqpc-ack-checkbox');
    checkboxes.forEach((cb) => fireEvent.click(cb));

    await waitFor(() => {
      const btn = document.getElementById('submitBtn') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
    fireEvent.click(document.getElementById('submitBtn') as HTMLButtonElement);

    // saveProjectConfirmation was still called (data not lost)
    await waitFor(() =>
      expect(saveProjectConfirmation as unknown as Fn).toHaveBeenCalledTimes(1),
    );

    // EF-failed state shown
    expect(
      await screen.findByText('Your confirmation details are saved'),
    ).toBeTruthy();
    expect(
      screen.getByText(/Signing is temporarily unavailable/),
    ).toBeTruthy();

    // Dashboard link still present
    const link = screen.getByRole('link', { name: /Go to My Dashboard/ });
    expect(link.getAttribute('href')).toBe('/dashboard');
  });
});

// ── 6. runSigningReturnBridge is called on mount ───────────────────────────────

describe('project-confirmation page — runSigningReturnBridge called on mount', () => {
  it('calls runSigningReturnBridge on mount', async () => {
    render(<ProjectConfirmationPage />);
    // Allow useEffect to run
    await waitFor(() =>
      expect(runSigningReturnBridge as unknown as Fn).toHaveBeenCalled(),
    );
  });
});

// ── 7. Gate panels: access-denied / not-signed / no-contractor ────────────────

describe('project-confirmation page — gate panels', () => {
  it('shows access-denied panel with no submit button', async () => {
    (useProjectConfirmationData as unknown as Fn).mockReturnValue(
      readyData({ gate: 'access-denied', error: null }),
    );
    render(<ProjectConfirmationPage />);
    expect(await screen.findByText('Access Denied')).toBeTruthy();
    expect(screen.getByText('You do not have permission to access this project.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Submit Project Confirmation/ })).toBeNull();
  });

  it('shows not-signed panel with no submit button', async () => {
    (useProjectConfirmationData as unknown as Fn).mockReturnValue(
      readyData({ gate: 'not-signed', error: null }),
    );
    render(<ProjectConfirmationPage />);
    expect(await screen.findByText('Contract not yet signed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Submit Project Confirmation/ })).toBeNull();
  });

  it('shows no-contractor panel', async () => {
    (useProjectConfirmationData as unknown as Fn).mockReturnValue(
      readyData({ gate: 'no-contractor', error: null }),
    );
    render(<ProjectConfirmationPage />);
    expect(await screen.findByText('No contractor selected')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Submit Project Confirmation/ })).toBeNull();
  });
});
