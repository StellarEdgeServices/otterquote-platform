/**
 * Render + flow tests for the homeowner color-selection page (D-211 Phase 27, PR 2/2).
 *
 * Mirrors project-confirmation-page.test.tsx (H4): mock the shell's auth + notification
 * hooks, the supabase singleton, the data layer, and docusign-embed — drive the data
 * hook's return value directly. Asserts the brief's render + flow self-verify points:
 * gating, two-stage save→success, addendum guard/payload (no signer), signing_url→embed
 * vs fallback, and the return-bridge call.
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
vi.mock('../use-color-selection-data', () => ({
  useColorSelectionData: vi.fn(),
  saveColorSelection: vi.fn(() => Promise.resolve()),
  createColorAddendumEnvelope: vi.fn(),
  requestColorBoardVisit: vi.fn(),
}));

// Mock docusign-embed so runSigningReturnBridge is a spy and the iframe is inspectable.
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
  useColorSelectionData,
  saveColorSelection,
  createColorAddendumEnvelope,
  requestColorBoardVisit,
} from '../use-color-selection-data';
import { runSigningReturnBridge } from '@/components/docusign-embed';
import {
  COLOR_COPY as C,
  subtitleBrandKnown,
  colorBoardVisitRequested,
  colorBoardPhoneSuffix,
} from '../copy';
import ColorSelectionPage from '../page';

type Fn = ReturnType<typeof vi.fn>;

const authed = (over: Record<string, unknown> = {}) => ({
  user: { id: 'u1', email: 'jane@example.com' },
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
    homeowner_id: 'u1',
    selected_contractor_id: 'ctr1',
    property_address: '123 Oak St, Zionsville 46077',
    contractor: {
      id: 'ctr1',
      name: 'Acme Roofing',
      preferred_brand: 'GAF',
      phone: '555-1234',
      notification_phones: null,
      email: 'ops@acme.test',
    },
    color_brand: null,
    color_name: null,
    color_selected_at: null,
  },
  contractor: {
    id: 'ctr1',
    name: 'Acme Roofing',
    preferred_brand: 'GAF',
    phone: '555-1234',
    notification_phones: null,
    email: 'ops@acme.test',
  },
  contractorId: 'ctr1',
  brand: 'GAF',
  zipCode: '46077',
  contractorName: 'Acme Roofing',
  contractorPhone: '555-1234',
  signerName: 'Jane Doe',
  signerEmail: 'jane@example.com',
  selectedColorName: null,
  gate: 'ready',
  loading: false,
  error: null,
  ...over,
});

beforeEach(() => {
  (useAuthReady as unknown as Fn).mockReturnValue(authed());
  (useColorSelectionData as unknown as Fn).mockReturnValue(readyData());
  (runSigningReturnBridge as unknown as Fn).mockReturnValue(false);
  (requestColorBoardVisit as unknown as Fn).mockResolvedValue({ status: 'created' });
  window.history.replaceState({}, '', '/color-selection?claim_id=c1');
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── 1. Renders the page with brand + subtitle ──────────────────────────────────

describe('color-selection page — render', () => {
  it('renders the header, the brand-known subtitle, and the brand display', async () => {
    render(<ColorSelectionPage />);
    expect(await screen.findByText(C.headerTitle)).toBeTruthy();
    expect(screen.getByText(subtitleBrandKnown('Acme Roofing', 'GAF'))).toBeTruthy();
    expect(screen.getByText(C.confirmationTitle)).toBeTruthy();
    // Brand display value renders the resolved brand
    expect(screen.getByText('GAF')).toBeTruthy();
  });

  it('shows the brand-unknown subtitle + state when no brand is confirmed', async () => {
    (useColorSelectionData as unknown as Fn).mockReturnValue(
      readyData({ brand: null, contractor: { ...readyData().contractor, preferred_brand: null } }),
    );
    render(<ColorSelectionPage />);
    expect(await screen.findByText(C.brandUnknownTitle)).toBeTruthy();
    expect(screen.getByText(C.brandUnknownText)).toBeTruthy();
  });
});

// ── 2. Gate panels: missing-claim / access-denied ──────────────────────────────

describe('color-selection page — gate panels', () => {
  it('shows the missing-claim panel with no confirm button', async () => {
    (useColorSelectionData as unknown as Fn).mockReturnValue(
      readyData({ gate: 'missing-claim', error: null }),
    );
    render(<ColorSelectionPage />);
    expect(await screen.findByText('Missing claim ID')).toBeTruthy();
    expect(document.getElementById('confirmBtn')).toBeNull();
  });

  it('shows the access-denied panel with no confirm button', async () => {
    (useColorSelectionData as unknown as Fn).mockReturnValue(
      readyData({ gate: 'access-denied', error: null }),
    );
    render(<ColorSelectionPage />);
    expect(await screen.findByText('Access Denied')).toBeTruthy();
    expect(
      screen.getByText('You do not have permission to access this project.'),
    ).toBeTruthy();
    expect(document.getElementById('confirmBtn')).toBeNull();
  });
});

// ── 3. Empty color is gated with an inline error (no save) ──────────────────────

describe('color-selection page — empty color guard', () => {
  it('shows an inline error and does NOT save when no color is entered', async () => {
    render(<ColorSelectionPage />);
    const btn = (await screen.findByText(C.confirmButton)) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(await screen.findByText('Please enter a color name.')).toBeTruthy();
    expect(saveColorSelection as unknown as Fn).not.toHaveBeenCalled();
  });
});

// ── 4. Two-stage: save FIRST → success → THEN create the addendum envelope ──────

describe('color-selection page — two-stage confirm', () => {
  it('saves the color, shows success, then calls createColorAddendumEnvelope and renders the embed', async () => {
    (createColorAddendumEnvelope as unknown as Fn).mockResolvedValue({
      signingUrl: 'https://ds/sign?token=color',
      envelopeId: 'env-1',
    });

    render(<ColorSelectionPage />);
    await screen.findByText(C.confirmationTitle);

    const colorInput = document.getElementById('color-input') as HTMLInputElement;
    fireEvent.change(colorInput, { target: { value: 'Charcoal' } });
    fireEvent.click(document.getElementById('confirmBtn') as HTMLButtonElement);

    // Save first, scoped to claim + homeowner, with the normalized brand.
    await waitFor(() => expect(saveColorSelection as unknown as Fn).toHaveBeenCalledTimes(1));
    expect((saveColorSelection as unknown as Fn).mock.calls[0][0]).toMatchObject({
      claimId: 'c1',
      userId: 'u1',
      brand: 'GAF',
      colorName: 'Charcoal',
    });

    // Inline success shown independent of signing.
    expect(await screen.findByText(C.successText)).toBeTruthy();

    // Envelope created with claim/contractor/origin (payload itself omits signer — utils).
    await waitFor(() =>
      expect(createColorAddendumEnvelope as unknown as Fn).toHaveBeenCalledTimes(1),
    );
    const efArg = (createColorAddendumEnvelope as unknown as Fn).mock.calls[0][0];
    expect(efArg).toMatchObject({ claimId: 'c1', contractorId: 'ctr1' });
    expect(efArg.origin).toBe(window.location.origin);

    // Embed renders with the returned signing URL.
    await waitFor(() => {
      const frame = document.getElementById('docusignFrame') as HTMLIFrameElement | null;
      expect(frame?.getAttribute('src')).toBe('https://ds/sign?token=color');
    });

    // The confirm button reflects the confirmed state.
    expect((document.getElementById('confirmBtn') as HTMLButtonElement).textContent).toBe(
      C.confirmButtonConfirmed,
    );
  });
});

// ── 5. onComplete → done screen with /dashboard link ───────────────────────────

describe('color-selection page — onComplete advances UI', () => {
  it('shows the done screen with a /dashboard link after onComplete fires', async () => {
    (createColorAddendumEnvelope as unknown as Fn).mockResolvedValue({
      signingUrl: 'https://ds/sign?token=color',
      envelopeId: null,
    });

    render(<ColorSelectionPage />);
    await screen.findByText(C.confirmationTitle);

    fireEvent.change(document.getElementById('color-input') as HTMLInputElement, {
      target: { value: 'Slate' },
    });
    fireEvent.click(document.getElementById('confirmBtn') as HTMLButtonElement);

    await waitFor(() => screen.findByTestId('complete-signing'));
    fireEvent.click(screen.getByTestId('complete-signing'));

    expect(await screen.findByText('Color Confirmed!')).toBeTruthy();
    const link = screen.getByRole('link', { name: /Back to Dashboard/ });
    expect(link.getAttribute('href')).toBe('/dashboard');
  });
});

// ── 6. EF error → graceful fallback (save still happened) ───────────────────────

describe('color-selection page — graceful EF failure', () => {
  it('shows the fallback copy when the envelope call rejects, save still ran', async () => {
    (createColorAddendumEnvelope as unknown as Fn).mockRejectedValue(new Error('EF down'));

    render(<ColorSelectionPage />);
    await screen.findByText(C.confirmationTitle);

    fireEvent.change(document.getElementById('color-input') as HTMLInputElement, {
      target: { value: 'Birchwood' },
    });
    fireEvent.click(document.getElementById('confirmBtn') as HTMLButtonElement);

    await waitFor(() => expect(saveColorSelection as unknown as Fn).toHaveBeenCalledTimes(1));

    const fallback = await waitFor(() => {
      const el = document.querySelector('.oqcs-addendum-fallback');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(fallback.textContent).toContain(C.addendumFallbackBase);
    expect(fallback.textContent).toContain('555-1234'); // with-phone clause
  });
});

// ── 7. Addendum guard: no signer email → fallback, envelope NOT called ──────────

describe('color-selection page — addendum guard', () => {
  it('skips the envelope and shows fallback when signerEmail is missing', async () => {
    (useColorSelectionData as unknown as Fn).mockReturnValue(readyData({ signerEmail: '' }));

    render(<ColorSelectionPage />);
    await screen.findByText(C.confirmationTitle);

    fireEvent.change(document.getElementById('color-input') as HTMLInputElement, {
      target: { value: 'Estate Gray' },
    });
    fireEvent.click(document.getElementById('confirmBtn') as HTMLButtonElement);

    await waitFor(() => expect(saveColorSelection as unknown as Fn).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.querySelector('.oqcs-addendum-fallback')).toBeTruthy(),
    );
    expect(createColorAddendumEnvelope as unknown as Fn).not.toHaveBeenCalled();
  });
});

// ── 8. runSigningReturnBridge is called on mount ───────────────────────────────

describe('color-selection page — return bridge', () => {
  it('calls runSigningReturnBridge on mount', async () => {
    render(<ColorSelectionPage />);
    await waitFor(() => expect(runSigningReturnBridge as unknown as Fn).toHaveBeenCalled());
  });
});

// ── 9. In-person color board request → inline confirmation ─────────────────────

describe('color-selection page — in-person request', () => {
  it('shows the visit-requested confirmation (with phone) on a created request', async () => {
    render(<ColorSelectionPage />);
    const btn = (await screen.findByText(C.inPersonButton)) as HTMLButtonElement;
    fireEvent.click(btn);

    const expected =
      colorBoardVisitRequested('Acme Roofing') + colorBoardPhoneSuffix('555-1234');
    expect(await screen.findByText(expected)).toBeTruthy();
  });

  it('shows the already-requested copy when a request already exists', async () => {
    (requestColorBoardVisit as unknown as Fn).mockResolvedValue({ status: 'already' });
    render(<ColorSelectionPage />);
    const btn = (await screen.findByText(C.inPersonButton)) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(await screen.findByText(C.colorBoardAlreadyRequested)).toBeTruthy();
  });
});

// ── 10. Already-selected color → confirmed on load ─────────────────────────────

describe('color-selection page — pre-confirmed', () => {
  it('renders the confirmed state when a color was already selected', async () => {
    (useColorSelectionData as unknown as Fn).mockReturnValue(
      readyData({ selectedColorName: 'Weathered Wood' }),
    );
    render(<ColorSelectionPage />);
    await screen.findByText(C.confirmationTitle);
    expect(await screen.findByText(C.successText)).toBeTruthy();
    const btn = document.getElementById('confirmBtn') as HTMLButtonElement;
    expect(btn.textContent).toBe(C.confirmButtonConfirmed);
    expect(btn.disabled).toBe(true);
    expect((document.getElementById('color-input') as HTMLInputElement).value).toBe(
      'Weathered Wood',
    );
  });
});
