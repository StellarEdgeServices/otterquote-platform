/**
 * Render + flow tests for the homeowner contract-signing page (H3, PR 2/2).
 *
 * Mirrors the H9 repair-intake page-test strategy: mock the shell's auth +
 * notification hooks, the supabase singleton, and the data layer — then drive the
 * data hook's return value directly. Asserts the brief's render-level self-verify:
 *   • the verbatim Tier-3 copy from copy.ts is rendered in the Step-1 disclosures;
 *   • the "Proceed to Sign" button is GATED by the D-123 acknowledgment checkbox;
 *   • Proceed builds the envelope via createHomeownerEnvelope and, on completion,
 *     records homeowner_signed_at and redirects to the project-confirmation URL.
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

// Data layer mocked — the page test drives its return values directly.
vi.mock('../use-contract-signing-data', () => ({
  useContractSigningData: vi.fn(),
  createHomeownerEnvelope: vi.fn(),
  recordHomeownerSigned: vi.fn(() => Promise.resolve()),
  sendContractorNudge: vi.fn(() => Promise.resolve(true)),
  requestBidRenewal: vi.fn(() => Promise.resolve(true)),
  buildProjectConfirmationUrl: (claimId: string) =>
    `https://otterquote.com/project-confirmation.html?claim_id=${claimId}`,
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import {
  useContractSigningData,
  createHomeownerEnvelope,
  recordHomeownerSigned,
} from '../use-contract-signing-data';
import { SIGN_COPY as C } from '../copy';
import ContractSigningPage from '../page';

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
  claim: { id: 'c1', selected_contractor_id: 'ctr1', user_id: 'u1' },
  quote: { id: 'q1', contractor_id: 'ctr1', contractor_signed_at: '2026-06-20T00:00:00Z' },
  contractor: { id: 'ctr1', company_name: 'Acme Roofing' },
  contractorId: 'ctr1',
  quoteId: 'q1',
  gate: 'ready',
  ownershipOk: true,
  bidExpired: false,
  loading: false,
  error: null,
  ...over,
});

beforeEach(() => {
  (useAuthReady as unknown as Fn).mockReturnValue(authed());
  (useContractSigningData as unknown as Fn).mockReturnValue(readyData());
  window.history.replaceState({}, '', '/contract-signing?claim_id=c1');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('contract-signing page — Step-1 verbatim copy', () => {
  it('renders the Right-to-Cancel and No-Cost disclosures byte-for-byte from copy.ts', async () => {
    render(<ContractSigningPage />);
    expect(await screen.findByText(C.rightToCancelTitle)).toBeTruthy();
    expect(screen.getByText(C.rightToCancelBody)).toBeTruthy();
    expect(screen.getByText(C.noCostTitle)).toBeTruthy();
    expect(screen.getByText(C.noCostBody)).toBeTruthy();
    expect(screen.getByText(C.ackHint)).toBeTruthy();
  });

  it('renders the D-123 acknowledgment lead + tail verbatim around the contractor name', async () => {
    render(<ContractSigningPage />);
    await screen.findByText(C.rightToCancelTitle);
    const ackInput = document.getElementById('otterquoteAcknowledgment') as HTMLInputElement;
    const text = ackInput.closest('.oqcs-ack')?.querySelector('.oqcs-ack-text')?.textContent ?? '';
    expect(text).toContain(C.ackLabelLead.trim());
    expect(text).toContain(C.ackLabelTail.trim());
    expect(text).toContain('Acme Roofing');
  });
});

describe('contract-signing page — D-123 checkbox gates Proceed', () => {
  it('disables Proceed until the acknowledgment box is checked', async () => {
    render(<ContractSigningPage />);
    const proceed = (await screen.findByRole('button', {
      name: /Proceed to Sign/,
    })) as HTMLButtonElement;
    expect(proceed.disabled).toBe(true);

    fireEvent.click(document.getElementById('otterquoteAcknowledgment') as HTMLInputElement);
    expect(proceed.disabled).toBe(false);

    // Unchecking re-gates it.
    fireEvent.click(document.getElementById('otterquoteAcknowledgment') as HTMLInputElement);
    expect(proceed.disabled).toBe(true);
  });
});

describe('contract-signing page — Proceed builds the envelope', () => {
  it('calls createHomeownerEnvelope with the resolved ids + signer + origin, then embeds the signing URL', async () => {
    (createHomeownerEnvelope as unknown as Fn).mockResolvedValue({
      signingUrl: 'https://ds/sign?token=x',
    });
    render(<ContractSigningPage />);
    await screen.findByText(C.rightToCancelTitle);

    fireEvent.click(document.getElementById('otterquoteAcknowledgment') as HTMLInputElement);
    fireEvent.click(screen.getByRole('button', { name: /Proceed to Sign/ }));

    await waitFor(() => expect(createHomeownerEnvelope as unknown as Fn).toHaveBeenCalledTimes(1));
    const arg = (createHomeownerEnvelope as unknown as Fn).mock.calls[0][0];
    expect(arg).toMatchObject({
      claimId: 'c1',
      contractorId: 'ctr1',
      quoteId: 'q1',
      signer: { email: 'jane@example.com', name: 'Jane Doe' },
    });
    expect(arg.origin).toBe(window.location.origin);

    // The DocuSign iframe mounts with the returned signing URL.
    await waitFor(() => {
      const frame = document.getElementById('docusignFrame') as HTMLIFrameElement | null;
      expect(frame?.getAttribute('src')).toBe('https://ds/sign?token=x');
    });
  });
});

describe('contract-signing page — already-signed / no-contract gates', () => {
  it('shows the already-signed panel (no signing UI) when the gate is already-signed', async () => {
    (useContractSigningData as unknown as Fn).mockReturnValue(readyData({ gate: 'already-signed' }));
    render(<ContractSigningPage />);
    expect(await screen.findByText(C.alreadySignedTitle)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Proceed to Sign/ })).toBeNull();
  });

  it('shows the no-contract panel when ownership fails (defensive hardening)', async () => {
    (useContractSigningData as unknown as Fn).mockReturnValue(
      readyData({ ownershipOk: false, gate: 'ready' }),
    );
    render(<ContractSigningPage />);
    expect(await screen.findByText(C.noContractTitle)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Proceed to Sign/ })).toBeNull();
  });
});

describe('contract-signing page — init-time signed=true return', () => {
  it('records homeowner_signed_at and redirects to project-confirmation on a signed return', async () => {
    window.history.replaceState({}, '', '/contract-signing?claim_id=c1&signed=true');

    // jsdom does not implement navigation; capture href assignments.
    const hrefSpy = vi.fn();
    const original = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, search: '?claim_id=c1&signed=true', origin: 'http://localhost:3000', pathname: '/contract-signing', set href(v: string) { hrefSpy(v); } },
    });

    render(<ContractSigningPage />);

    await waitFor(() =>
      expect(recordHomeownerSigned as unknown as Fn).toHaveBeenCalledWith(
        expect.objectContaining({ claimId: 'c1', quoteId: 'q1', contractorId: 'ctr1' }),
      ),
    );
    await waitFor(() =>
      expect(hrefSpy).toHaveBeenCalledWith(
        'https://otterquote.com/project-confirmation.html?claim_id=c1',
      ),
    );

    if (original) Object.defineProperty(window, 'location', original);
  });
});
