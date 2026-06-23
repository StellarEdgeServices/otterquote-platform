import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── Mock the auth + notification hooks the shell depends on (before import). ──
vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: () => ({ count: 0, loading: false, error: null }),
}));

// ── Mock supabase singleton so nothing throws on missing env at import. ──
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getUser: vi.fn(() => Promise.resolve({ data: { user: null }, error: null })) },
    from: vi.fn(),
    storage: { from: vi.fn() },
  },
}));

// ── Mock the data layer — page tests drive its return values directly. ──
// The SessionExpiredError class is defined INSIDE the factory (vi.mock is hoisted
// above all top-level declarations) and re-imported below for the redirect test.
vi.mock('../use-repair-intake-data', () => ({
  submitRepairIntake: vi.fn(),
  useRepairContractors: vi.fn(),
  SessionExpiredError: class SessionExpiredError extends Error {
    constructor(message = 'Session expired') {
      super(message);
      this.name = 'SessionExpiredError';
    }
  },
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import { HomeownerShell } from '../../_shell/HomeownerShell';
import {
  submitRepairIntake,
  useRepairContractors,
  SessionExpiredError,
} from '../use-repair-intake-data';
import { ContractorList } from '../components/ContractorList';
import {
  buildClaimInsert,
  buildClaimUpdate,
  buildStoragePath,
  canSubmit,
  getPhotoInstructions,
  getTradeFromSession,
  hasMaterialIdentity,
  totalPhotoCount,
  trimToNull,
  validatePhotoFile,
  emptyPhotos,
  emptyMaterial,
} from '../utils';
import type { ContractorPublicRow, RepairSubmission } from '../types';
import RepairIntakePage from '../page';

// ── Helpers ──────────────────────────────────────────────────────────────────
type AuthVal = ReturnType<typeof vi.fn>;
const mockAuth = (v: unknown) => (useAuthReady as unknown as AuthVal).mockReturnValue(v);
const authed = (over: Record<string, unknown> = {}) => ({
  user: { id: 'u1', email: 'jane@example.com' },
  role: 'homeowner',
  isAdmin: false,
  loading: false,
  settled: true,
  signOut: vi.fn(),
  ...over,
});

const wireContractors = (over: Partial<ReturnType<typeof noContractors>> = {}) =>
  (useRepairContractors as ReturnType<typeof vi.fn>).mockReturnValue({
    ...noContractors(),
    ...over,
  });
const noContractors = () => ({
  contractors: [] as ContractorPublicRow[],
  loading: false,
  error: null as Error | null,
});

function setTrade(trade: string) {
  window.sessionStorage.setItem('oq_trade_selections', JSON.stringify({ [trade]: true }));
}

function fileInputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input[type="file"]'));
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) GATE — HomeownerShell auth enforcement
// ─────────────────────────────────────────────────────────────────────────────
describe('(a) HomeownerShell gate on /repair-intake', () => {
  let originalLocation: Location;
  beforeEach(() => {
    vi.clearAllMocks();
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: '' },
    });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it('renders the body for an authenticated homeowner', () => {
    mockAuth(authed());
    render(<HomeownerShell active="dashboard"><div>RI_BODY</div></HomeownerShell>);
    expect(screen.getByText('RI_BODY')).toBeInTheDocument();
    expect(window.location.href).toBe('');
  });

  it('renders for a null/unresolved role (permissive, like requireAuth)', () => {
    mockAuth(authed({ role: null }));
    render(<HomeownerShell active="dashboard"><div>RI_BODY</div></HomeownerShell>);
    expect(screen.getByText('RI_BODY')).toBeInTheDocument();
  });

  it('redirects an unauthenticated visitor to get-started.html (NOT sign-in.html)', () => {
    mockAuth(authed({ user: null, role: null }));
    render(<HomeownerShell active="dashboard"><div>RI_BODY</div></HomeownerShell>);
    expect(window.location.href).toBe('https://otterquote.com/get-started.html');
    expect(window.location.href).not.toContain('sign-in.html');
    expect(screen.queryByText('RI_BODY')).not.toBeInTheDocument();
  });

  it('redirects a contractor to the contractor dashboard', () => {
    mockAuth(authed({ role: 'contractor' }));
    render(<HomeownerShell active="dashboard"><div>RI_BODY</div></HomeownerShell>);
    expect(window.location.href).toBe('https://otterquote.com/contractor-dashboard.html');
    expect(screen.queryByText('RI_BODY')).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) REPAIR-TYPE SELECTION → correct dynamic fields render
// ─────────────────────────────────────────────────────────────────────────────
describe('(b) Repair-type selection and dynamic fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mockAuth(authed());
    wireContractors();
  });

  it('roofing shows the three repair cards and no photo section until one is picked', () => {
    setTrade('roofing');
    render(<RepairIntakePage />);
    expect(screen.getByText('Leak')).toBeInTheDocument();
    expect(screen.getByText('Blown-off Shingles')).toBeInTheDocument();
    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(
      screen.queryByText('📸 Photos Help Contractors Estimate Accurately'),
    ).not.toBeInTheDocument();
  });

  it('leak → reveals the roof-age field + photo section + material tiers', () => {
    setTrade('roofing');
    render(<RepairIntakePage />);
    fireEvent.click(screen.getByText('Leak'));
    expect(screen.getByText('📸 Photos Help Contractors Estimate Accurately')).toBeInTheDocument();
    expect(screen.getByText('How old is your roof? (approximate)')).toBeInTheDocument();
    // Roofing → material identification tiers appear.
    expect(screen.getByText(/Currently on Your Roof/)).toBeInTheDocument();
    expect(screen.getByText(/Tier 3: AI Photo Identification/)).toBeInTheDocument();
  });

  it('shingles → reveals the shingles-count field (not roof-age)', () => {
    setTrade('roofing');
    render(<RepairIntakePage />);
    fireEvent.click(screen.getByText('Blown-off Shingles'));
    expect(
      screen.getByText('Approximately how many shingles are missing?'),
    ).toBeInTheDocument();
    expect(screen.queryByText('How old is your roof? (approximate)')).not.toBeInTheDocument();
  });

  it('other → reveals the free-text issue description field', () => {
    setTrade('roofing');
    render(<RepairIntakePage />);
    fireEvent.click(screen.getByText('Other'));
    expect(screen.getByText("Please describe what's happening:")).toBeInTheDocument();
  });

  it('a describe-trade (siding) skips cards, auto-selects describe, no material tiers', () => {
    setTrade('siding');
    render(<RepairIntakePage />);
    expect(screen.getByText('Tell us about your siding issue')).toBeInTheDocument();
    expect(screen.queryByText('Leak')).not.toBeInTheDocument();
    // Photo section is visible immediately (repairType auto = describe).
    expect(screen.getByText('📸 Photos Help Contractors Estimate Accurately')).toBeInTheDocument();
    // No roofing material tiers for non-roofing trades.
    expect(screen.queryByText(/Currently on Your Roof/)).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) PHOTO selection → thumbnail + size/type rejection + remove
// ─────────────────────────────────────────────────────────────────────────────
describe('(c) Photo upload validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mockAuth(authed());
    wireContractors();
    setTrade('siding'); // single (main) uploader, no material tiers
  });

  it('a valid image renders a thumbnail and enables submit', async () => {
    const { container } = render(<RepairIntakePage />);
    const input = fileInputs(container)[0];
    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByAltText('photo.png')).toBeInTheDocument();
    });
    expect(screen.getByText('✓ Submit for Contractor Review')).not.toBeDisabled();
  });

  it('rejects a file over 10MB with a message and no thumbnail', async () => {
    const { container } = render(<RepairIntakePage />);
    const input = fileInputs(container)[0];
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.png', {
      type: 'image/png',
    });
    fireEvent.change(input, { target: { files: [big] } });

    await waitFor(() => {
      expect(screen.getByText(/larger than 10MB/)).toBeInTheDocument();
    });
    expect(screen.queryByAltText('big.png')).not.toBeInTheDocument();
  });

  it('rejects a wrong-type file (text) on an image-only tier', async () => {
    const { container } = render(<RepairIntakePage />);
    const input = fileInputs(container)[0];
    const bad = new File(['hi'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [bad] } });

    await waitFor(() => {
      expect(screen.getByText(/is not a supported file type/)).toBeInTheDocument();
    });
  });

  it('remove deletes the thumbnail', async () => {
    const { container } = render(<RepairIntakePage />);
    const input = fileInputs(container)[0];
    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByAltText('photo.png')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Remove photo.png'));
    expect(screen.queryByAltText('photo.png')).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) SUBMIT path + contractor reveal + failure handling
// ─────────────────────────────────────────────────────────────────────────────
describe('(e) Submit flow', () => {
  let originalLocation: Location;
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mockAuth(authed());
    wireContractors();
    setTrade('siding');
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: '', search: '' },
    });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  async function addAValidPhoto(container: HTMLElement) {
    const input = fileInputs(container)[0];
    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByAltText('photo.png')).toBeInTheDocument());
  }

  it('on success: shows submitted state and reveals the contractor section', async () => {
    (submitRepairIntake as ReturnType<typeof vi.fn>).mockResolvedValue({ claimId: 'c-1' });
    wireContractors({
      contractors: [{ id: 'k1', company_name: 'Acme Roofing', years_in_business: 12, rating: 4.8 }],
    });

    const { container } = render(<RepairIntakePage />);
    await addAValidPhoto(container);
    fireEvent.click(screen.getByText('✓ Submit for Contractor Review'));

    await waitFor(() => {
      expect(screen.getByText('🔨 Contractors Available for Repairs')).toBeInTheDocument();
    });
    expect(screen.getByText('Acme Roofing')).toBeInTheDocument();
    expect(screen.getByText('✓ Submitted!')).toBeInTheDocument();
    // Submit passed through the resolved trade + describe type.
    const arg = (submitRepairIntake as ReturnType<typeof vi.fn>).mock.calls[0][0] as RepairSubmission;
    expect(arg.trade).toBe('siding');
    expect(arg.repairType).toBe('describe');
    expect(arg.photos).toHaveLength(1);
    expect(window.sessionStorage.getItem('oq_claim_id')).toBe('c-1');
  });

  it('on failure: shows an error and re-enables Submit', async () => {
    (submitRepairIntake as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const { container } = render(<RepairIntakePage />);
    await addAValidPhoto(container);
    fireEvent.click(screen.getByText('✓ Submit for Contractor Review'));

    await waitFor(() => {
      expect(screen.getByText('Something went wrong. Please try again.')).toBeInTheDocument();
    });
    expect(screen.getByText('✓ Submit for Contractor Review')).not.toBeDisabled();
  });

  it('on session-expiry: redirects to get-started.html', async () => {
    (submitRepairIntake as ReturnType<typeof vi.fn>).mockRejectedValue(
      new SessionExpiredError(),
    );
    const { container } = render(<RepairIntakePage />);
    await addAValidPhoto(container);
    fireEvent.click(screen.getByText('✓ Submit for Contractor Review'));

    await waitFor(() => {
      expect(window.location.href).toBe('https://otterquote.com/get-started.html');
    });
  });

  it('Submit is disabled until a repair type AND a photo are present', () => {
    render(<RepairIntakePage />);
    // describe trade auto-selects type, but no photo yet → still disabled.
    expect(screen.getByText('✓ Submit for Contractor Review')).toBeDisabled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (f) CONTRACTOR LIST — safe JSX, empty / error states
// ─────────────────────────────────────────────────────────────────────────────
describe('(f) ContractorList rendering', () => {
  it('renders contractors as safe JSX (years + rating, no phone)', () => {
    render(
      <ContractorList
        contractors={[
          { id: 'k1', company_name: 'Acme Roofing', years_in_business: 12, rating: 4.9 },
        ]}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText('Acme Roofing')).toBeInTheDocument();
    expect(screen.getByText('12 yrs in business')).toBeInTheDocument();
    expect(screen.getByText('★ 4.9')).toBeInTheDocument();
    expect(screen.getByText('✓ Accepts repair work')).toBeInTheDocument();
  });

  it('injection guard: an HTML-string company_name renders as text, not an element', () => {
    const { container } = render(
      <ContractorList
        contractors={[
          { id: 'x', company_name: '<img src=x onerror=alert(1)>' },
        ]}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('empty result renders the reassurance state', () => {
    render(<ContractorList contractors={[]} loading={false} error={null} />);
    expect(
      screen.getByText('No contractors have opted into repairs yet.'),
    ).toBeInTheDocument();
  });

  it('error collapses into the same reassurance state (static parity)', () => {
    render(<ContractorList contractors={[]} loading={false} error={new Error('boom')} />);
    expect(
      screen.getByText('No contractors have opted into repairs yet.'),
    ).toBeInTheDocument();
  });

  it('loading renders the loading line', () => {
    render(<ContractorList contractors={[]} loading={true} error={null} />);
    expect(screen.getByText('Loading available contractors…')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (g) PURE UNIT — utils invariants (faithful-port guards)
// ─────────────────────────────────────────────────────────────────────────────
describe('(g) utils', () => {
  it('validatePhotoFile: images ok, >10MB rejected, non-image rejected, PDF only on tier1', () => {
    const img = new File(['x'], 'a.png', { type: 'image/png' });
    expect(validatePhotoFile(img, 'main').ok).toBe(true);

    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'b.png', { type: 'image/png' });
    expect(validatePhotoFile(big, 'main').ok).toBe(false);

    const txt = new File(['x'], 'c.txt', { type: 'text/plain' });
    expect(validatePhotoFile(txt, 'main').ok).toBe(false);

    const pdf = new File(['x'], 'd.pdf', { type: 'application/pdf' });
    expect(validatePhotoFile(pdf, 'tier1').ok).toBe(true);
    expect(validatePhotoFile(pdf, 'main').ok).toBe(false);
  });

  it('buildClaimInsert produces the exact static insert payload (material trimmed to null)', () => {
    const sub: RepairSubmission = {
      userId: 'u1',
      claimId: null,
      trade: 'roofing',
      repairType: 'leak',
      material: { brand: '  GAF ', product: '', color: '' },
      notes: '  ceiling drip ',
      photos: [],
    };
    expect(buildClaimInsert(sub)).toEqual({
      user_id: 'u1',
      job_type: 'repair',
      funding_type: 'insurance',
      status: 'draft',
      trades: ['roofing'],
      existing_shingle_brand: 'GAF',
      existing_shingle_product: null,
      existing_shingle_color: null,
      homeowner_notes: 'ceiling drip',
    });
  });

  it('buildClaimUpdate omits user_id/funding_type/status (static parity) and defaults trade', () => {
    const sub: RepairSubmission = {
      userId: 'u1',
      claimId: 'c1',
      trade: '',
      repairType: 'other',
      material: emptyMaterial(),
      notes: null,
      photos: [],
    };
    expect(buildClaimUpdate(sub)).toEqual({
      job_type: 'repair',
      trades: ['roofing'],
      existing_shingle_brand: null,
      existing_shingle_product: null,
      existing_shingle_color: null,
      homeowner_notes: null,
    });
  });

  it('buildStoragePath is UID-first (RLS-compliant) with claim id as the second segment', () => {
    const path = buildStoragePath('u1', 'c1', 'main', 'png', 1700, 'abc');
    expect(path).toBe('u1/c1/repair-main-1700-abc.png');
    expect(path.split('/')[0]).toBe('u1'); // first folder must equal auth.uid()
  });

  it('getPhotoInstructions returns per-type guidance', () => {
    expect(getPhotoInstructions('leak').length).toBe(3);
    expect(getPhotoInstructions('shingles').length).toBe(3);
    expect(getPhotoInstructions('other').length).toBe(1);
    expect(getPhotoInstructions('describe').length).toBe(1);
    expect(getPhotoInstructions(null).length).toBe(0);
  });

  it('canSubmit / totalPhotoCount / hasMaterialIdentity / trimToNull', () => {
    expect(canSubmit(null, 3)).toBe(false);
    expect(canSubmit('leak', 0)).toBe(false);
    expect(canSubmit('leak', 1)).toBe(true);

    const photos = emptyPhotos();
    expect(totalPhotoCount(photos)).toBe(0);
    photos.main.push({ id: 'a', file: new File(['x'], 'a.png'), previewUrl: null, isImage: true });
    photos.tier2.push({ id: 'b', file: new File(['x'], 'b.png'), previewUrl: null, isImage: true });
    expect(totalPhotoCount(photos)).toBe(2);

    expect(hasMaterialIdentity({ brand: '', product: '', color: '' })).toBe(false);
    expect(hasMaterialIdentity({ brand: 'GAF', product: '', color: '' })).toBe(true);

    expect(trimToNull('  ')).toBeNull();
    expect(trimToNull(' x ')).toBe('x');
    expect(trimToNull(null)).toBeNull();
  });

  it('getTradeFromSession reads the first truthy trade', () => {
    window.sessionStorage.clear();
    expect(getTradeFromSession()).toBeNull();
    window.sessionStorage.setItem('oq_trade_selections', JSON.stringify({ roofing: true }));
    expect(getTradeFromSession()).toBe('roofing');
    window.sessionStorage.setItem(
      'oq_trade_selections',
      JSON.stringify({ siding: false, gutters: true }),
    );
    expect(getTradeFromSession()).toBe('gutters');
  });
});
