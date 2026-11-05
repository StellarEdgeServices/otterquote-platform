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
import { runSigningReturnBridge, isSigningCompleteReturn } from '@/components/docusign-embed';
import {
  COLOR_COPY as C,
  subtitleBrandKnown,
  subtitleBrandUnconfirmed,
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
    user_id: 'u1',
    selected_contractor_id: 'ctr1',
    property_address: '123 Oak St, Zionsville 46077',
    color_brand: null,
    color_name: null,
    color_selected_at: null,
  },
  contractor: {
    company_name: 'Acme Roofing',
    preferred_brands: ['GAF'],
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

describe('color-selection page — ruled copy (Ben 6584752880)', () => {
  it('renders two option cards: no Browse Colors card, no catalog, no View Colors button (items 14-16)', async () => {
    render(<ColorSelectionPage />);
    await screen.findByText(C.headerTitle);
    expect(document.querySelectorAll('.oqcs-option-card').length).toBe(2);
    expect(document.body.textContent).not.toMatch(/Browse Colors|View Colors|color catalog/);
  });

  it('shows the new-tab note on the visualizer card only (item 20)', async () => {
    render(<ColorSelectionPage />);
    await screen.findByText(C.headerTitle);
    const cards = Array.from(document.querySelectorAll('.oqcs-option-card'));
    expect(cards[0].textContent).toContain(C.opensInNewTabLabel);
    expect(cards[1].textContent).not.toContain(C.opensInNewTabLabel);
    expect(document.querySelectorAll('.oqcs-option-note').length).toBeGreaterThanOrEqual(1);
    expect(document.body.textContent?.split(C.opensInNewTabLabel).length).toBe(2);
  });

  it('drops the name from the subtitle when the contractor name is missing (items 2/3)', async () => {
    (useColorSelectionData as unknown as Fn).mockReturnValue(
      readyData({ contractorName: C.contractorNameFallback }),
    );
    render(<ColorSelectionPage />);
    expect(
      await screen.findByText("Your contractor uses GAF. Let's pick the perfect color for your home."),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('Your contractor Your Contractor');
  });

  it('drops the name from the brand-unconfirmed subtitle too (item 3)', async () => {
    (useColorSelectionData as unknown as Fn).mockReturnValue(
      readyData({ brand: null, contractorName: C.contractorNameFallback }),
    );
    render(<ColorSelectionPage />);
    expect(
      await screen.findByText(subtitleBrandUnconfirmed(C.contractorNameFallback)),
    ).toBeTruthy();
    expect(
      screen.getByText("Your contractor will confirm the brand. Let's pick the perfect color for your home."),
    ).toBeTruthy();
  });

  it('shows the in-person description in the ruled words (item 45)', async () => {
    render(<ColorSelectionPage />);
    expect(
      await screen.findByText(
        "Request physical color boards.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/shingle samples/)).toBeNull();
  });

  it('shows only the ruled save-error words when saving fails, never a raw database message (item 67)', async () => {
    (saveColorSelection as unknown as Fn).mockRejectedValueOnce(
      new Error('Failed to save color selection: permission denied for table claims'),
    );
    render(<ColorSelectionPage />);
    await screen.findByText(C.confirmationTitle);
    fireEvent.change(document.getElementById('color-input') as HTMLInputElement, {
      target: { value: 'Charcoal' },
    });
    fireEvent.click(document.getElementById('confirmBtn') as HTMLButtonElement);
    expect(await screen.findByText('Error saving color. Please try again.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/permission denied|Failed to save color selection/);
  });
});

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
      readyData({ brand: null, contractor: { ...readyData().contractor, preferred_brands: null } }),
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

  it('titles the panel "Claim not found" when the claim lookup failed (Ben 6584752880, items 76/78)', async () => {
    (useColorSelectionData as unknown as Fn).mockReturnValue(
      readyData({ gate: 'missing-claim', error: 'Claim not found. Please return to your dashboard.' }),
    );
    render(<ColorSelectionPage />);
    expect(await screen.findByText('Claim not found')).toBeTruthy();
    expect(screen.getByText('Claim not found. Please return to your dashboard.')).toBeTruthy();
    expect(screen.queryByText('Missing claim ID')).toBeNull();
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

// ── 4. Two-stage: save FIRST → success → THEN the saved note (no signing panel) ──

describe('color-selection page — two-stage confirm', () => {
  it('saves the color, shows success, then shows the saved note and NO signing panel, even if the call returns a signing URL', async () => {
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

    // gh-3287 (Ben 6584752880, items 69-71): the saved note, never a signing panel.
    await waitFor(() => expect(document.querySelector('.oqcs-addendum-fallback')).toBeTruthy());
    expect(document.getElementById('docusignFrame')).toBeNull();
    expect(document.querySelector('.oqcs-addendum')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Sign Color Addendum|Almost done|E-Sign/);

    // The confirm button reflects the confirmed state.
    expect((document.getElementById('confirmBtn') as HTMLButtonElement).textContent).toBe(
      C.confirmButtonConfirmed,
    );
  });
});

// ── 5. Signed-return flag → done screen with /dashboard link (kept, items 73-75) ──

describe('color-selection page — signed return', () => {
  it('shows the done screen with a /dashboard link on a signed return', async () => {
    (isSigningCompleteReturn as unknown as Fn).mockReturnValueOnce(true);
    render(<ColorSelectionPage />);
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
    // gh-3287 (Ben, 2026-11-02T17:12Z, replacing 6581042504): the note is exactly this sentence
    expect(fallback.textContent?.trim()).toBe(
      'Your color choice is saved. Please confirm it with your contractor.',
    );
    expect(fallback.textContent).not.toContain('before you sign');
    expect(fallback.textContent).not.toContain('final contract documents');
    expect(fallback.textContent).not.toContain('555-1234'); // no phone clause
    expect(document.body.textContent).not.toContain('already signed');
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

    const expected = C.colorBoardVisitRequested + colorBoardPhoneSuffix('555-1234');
    expect(await screen.findByText(expected)).toBeTruthy();
    // Ben 6584752880, items 47/49: saving the request notifies nobody, so no promise is made.
    expect(document.body.textContent).not.toMatch(/48 hours|reach out|notified/);
  });

  it('shows the already-requested copy when a request already exists', async () => {
    (requestColorBoardVisit as unknown as Fn).mockResolvedValue({ status: 'already' });
    render(<ColorSelectionPage />);
    const btn = (await screen.findByText(C.inPersonButton)) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(await screen.findByText(C.colorBoardAlreadyRequested)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/reach out/);
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
