import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── Mock the auth + notification hooks the shell depends on (before import). ──
vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: () => ({ count: 0, loading: false, error: null }),
}));

// ── Mock supabase singleton so the data module never throws on missing env. ──
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      getSession: vi.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      signOut: vi.fn(),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({ order: vi.fn(() => Promise.resolve({ data: [], error: null })) })),
          order: vi.fn(() => ({
            limit: vi.fn(() => ({
              maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
            })),
          })),
        })),
      })),
      update: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) })),
    })),
  },
}));

// ── Shared mock for the data layer — individual tests set return values. ──
vi.mock('../use-help-materials-data', () => ({
  useCurrentClaimId: vi.fn(),
  useDesignerProducts: vi.fn(),
  saveMaterialSelection: vi.fn(),
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import { HomeownerShell } from '../../_shell/HomeownerShell';
import {
  useCurrentClaimId,
  useDesignerProducts,
  saveMaterialSelection,
} from '../use-help-materials-data';
import {
  buildClaimMaterialUpdate,
  confirmSummary,
  currentStep,
  groupByManufacturer,
  impactBadge,
  isConfirmReady,
  pricingRows,
  tierBadge,
  truncateDescription,
  initialSelectionState,
} from '../utils';
import { DesignerProductGrid } from '../components/DesignerProductGrid';
import type { MaterialCatalogRow, MaterialSelectionState } from '../types';
import HelpMaterialsPage from '../page';

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

function wireData(overrides: {
  claimId?: string | null;
  claimLoading?: boolean;
  claimError?: Error | null;
  products?: MaterialCatalogRow[];
  designerLoading?: boolean;
  designerError?: Error | null;
} = {}) {
  const {
    claimId = 'claim-1',
    claimLoading = false,
    claimError = null,
    products = [],
    designerLoading = false,
    designerError = null,
  } = overrides;
  (useCurrentClaimId as ReturnType<typeof vi.fn>).mockReturnValue({
    claimId,
    loading: claimLoading,
    error: claimError,
  });
  (useDesignerProducts as ReturnType<typeof vi.fn>).mockReturnValue({
    products,
    loading: designerLoading,
    error: designerError,
  });
}

const DESIGNER_PRODUCTS: MaterialCatalogRow[] = [
  {
    id: 'p1',
    manufacturer: 'GAF',
    product_name: 'Grand Sequoia',
    description: 'Rugged woodshake look.',
    impact_class: 'class4',
    price_tier: 'premium',
    visualizer_url: 'https://gaf.com/colors',
    subcategory: 'designer',
    active: true,
  },
  {
    id: 'p2',
    manufacturer: 'GAF',
    product_name: 'Camelot II',
    description: 'Slate look.',
    impact_class: 'class3',
    price_tier: 'mid',
    visualizer_url: null,
    subcategory: 'designer',
    active: true,
  },
  {
    id: 'p3',
    manufacturer: 'CertainTeed',
    product_name: 'Grand Manor',
    description: 'Luxury slate.',
    impact_class: null,
    price_tier: 'premium',
    visualizer_url: 'https://ct.com/colors',
    subcategory: 'designer',
    active: true,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// (a) GATE — HomeownerShell auth enforcement
// ─────────────────────────────────────────────────────────────────────────────
describe('(a) HomeownerShell gate on /help-materials', () => {
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
    render(<HomeownerShell active="dashboard"><div>MAT_BODY</div></HomeownerShell>);
    expect(screen.getByText('MAT_BODY')).toBeInTheDocument();
    expect(window.location.href).toBe('');
  });

  it('renders for a null/unresolved role (permissive, like requireAuth)', () => {
    mockAuth(authed({ role: null }));
    render(<HomeownerShell active="dashboard"><div>MAT_BODY</div></HomeownerShell>);
    expect(screen.getByText('MAT_BODY')).toBeInTheDocument();
  });

  it('redirects an unauthenticated visitor to get-started.html (NOT sign-in.html)', () => {
    mockAuth(authed({ user: null, role: null }));
    render(<HomeownerShell active="dashboard"><div>MAT_BODY</div></HomeownerShell>);
    expect(window.location.href).toBe('https://otterquote.com/get-started.html');
    expect(window.location.href).not.toContain('sign-in.html');
    expect(screen.queryByText('MAT_BODY')).not.toBeInTheDocument();
  });

  it('redirects a contractor to the contractor dashboard', () => {
    mockAuth(authed({ role: 'contractor' }));
    render(<HomeownerShell active="dashboard"><div>MAT_BODY</div></HomeownerShell>);
    expect(window.location.href).toBe('https://otterquote.com/contractor-dashboard.html');
    expect(screen.queryByText('MAT_BODY')).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) BRANCH ROUTING
// ─────────────────────────────────────────────────────────────────────────────
describe('(b) Wizard branch routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth(authed());
    wireData({ products: DESIGNER_PRODUCTS });
  });

  it('renders the two category cards on initial load', () => {
    render(<HelpMaterialsPage />);
    expect(screen.getByText('What type of roofing material interests you?')).toBeInTheDocument();
    expect(screen.getByText('Shingles')).toBeInTheDocument();
    expect(screen.getByText('Metal Roofing')).toBeInTheDocument();
  });

  it('Shingles → reveals the three shingle types', () => {
    render(<HelpMaterialsPage />);
    fireEvent.click(screen.getByText('Shingles'));
    expect(screen.getByText('Which shingle type works for you?')).toBeInTheDocument();
    expect(screen.getByText('Architectural Shingle')).toBeInTheDocument();
    expect(screen.getByText('Designer Shingle')).toBeInTheDocument();
    expect(screen.getByText('3-Tab Shingle')).toBeInTheDocument();
  });

  it('Shingles → Architectural → reveals the impact-class step', () => {
    render(<HelpMaterialsPage />);
    fireEvent.click(screen.getByText('Shingles'));
    fireEvent.click(screen.getByText('Architectural Shingle'));
    expect(
      screen.getByText('Step 3: Select Impact Class (Hail Resistance)'),
    ).toBeInTheDocument();
    expect(screen.getByText('Class 4')).toBeInTheDocument();
    // Confirmation not shown until an impact class is picked.
    expect(screen.queryByText('Review Your Selection')).not.toBeInTheDocument();
  });

  it('Shingles → Designer → reveals the designer product grid', () => {
    render(<HelpMaterialsPage />);
    fireEvent.click(screen.getByText('Shingles'));
    fireEvent.click(screen.getByText('Designer Shingle'));
    expect(screen.getByText('Choose Your Designer Shingle')).toBeInTheDocument();
    expect(screen.getByText('Grand Sequoia')).toBeInTheDocument();
  });

  it('Shingles → 3-Tab → skips details, shows confirmation directly', () => {
    render(<HelpMaterialsPage />);
    fireEvent.click(screen.getByText('Shingles'));
    fireEvent.click(screen.getByText('3-Tab Shingle'));
    expect(screen.getByText('Review Your Selection')).toBeInTheDocument();
    // No impact step for 3-tab.
    expect(
      screen.queryByText('Step 3: Select Impact Class (Hail Resistance)'),
    ).not.toBeInTheDocument();
  });

  it('Metal → material → reveals the metal-material step then confirmation', () => {
    render(<HelpMaterialsPage />);
    fireEvent.click(screen.getByText('Metal Roofing'));
    expect(screen.getByText('Which metal roofing style interests you?')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Standing Seam'));
    expect(screen.getByText('Step 3: Select Metal Material')).toBeInTheDocument();
    expect(screen.queryByText('Review Your Selection')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Steel (Galvalume)'));
    expect(screen.getByText('Review Your Selection')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) DESIGNER PRODUCT GRID — grouping, badges, safe rendering
// ─────────────────────────────────────────────────────────────────────────────
describe('(c) DesignerProductGrid', () => {
  it('groups by manufacturer and renders impact + tier badges + visualizer link', () => {
    render(
      <DesignerProductGrid
        products={DESIGNER_PRODUCTS}
        loading={false}
        error={null}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );
    // Manufacturer group headings
    expect(screen.getByText('GAF')).toBeInTheDocument();
    expect(screen.getByText('CertainTeed')).toBeInTheDocument();
    // Badges
    expect(screen.getByText('Class 4')).toBeInTheDocument();
    expect(screen.getByText('Class 3')).toBeInTheDocument();
    expect(screen.getAllByText('Premium').length).toBeGreaterThan(0);
    expect(screen.getByText('Moderate')).toBeInTheDocument();
    // Visualizer link is a real anchor with safe rel + target
    const link = screen.getAllByText('View Colors →')[0].closest('a')!;
    expect(link).toHaveAttribute('href', 'https://gaf.com/colors');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('empty result renders the no-products state', () => {
    render(
      <DesignerProductGrid
        products={[]}
        loading={false}
        error={null}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('No designer products available yet.')).toBeInTheDocument();
  });

  it('query error renders the error state', () => {
    render(
      <DesignerProductGrid
        products={[]}
        loading={false}
        error={new Error('boom')}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/Error loading products/)).toBeInTheDocument();
  });

  it('injection guard: an HTML-string product_name renders as text, not an element', () => {
    const malicious: MaterialCatalogRow[] = [
      {
        id: 'x',
        manufacturer: 'Acme',
        product_name: '<img src=x onerror=alert(1)>',
        description: 'safe',
        impact_class: null,
        price_tier: 'mid',
        visualizer_url: null,
      },
    ];
    const { container } = render(
      <DesignerProductGrid
        products={malicious}
        loading={false}
        error={null}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) CONFIRMATION SUMMARY — reflects the chosen path
// ─────────────────────────────────────────────────────────────────────────────
describe('(d) Confirmation summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth(authed());
    wireData({ products: DESIGNER_PRODUCTS });
  });

  it('designer path: type shows "manufacturer product" and auto-impact label', () => {
    render(<HelpMaterialsPage />);
    fireEvent.click(screen.getByText('Shingles'));
    fireEvent.click(screen.getByText('Designer Shingle'));
    fireEvent.click(screen.getByText('Grand Sequoia')); // class4 product
    expect(screen.getByText('Review Your Selection')).toBeInTheDocument();
    expect(screen.getByText('GAF Grand Sequoia')).toBeInTheDocument();
    expect(screen.getByText('Class 4 Impact Resistant')).toBeInTheDocument();
  });

  it('confirmSummary unit: architectural with class-4 (hyphenated) impact', () => {
    const state: MaterialSelectionState = {
      ...initialSelectionState(),
      category: 'shingles',
      shingleType: 'architectural',
      impactClass: 'class-4',
    };
    expect(confirmSummary(state)).toEqual({
      category: 'Shingles',
      type: 'Architectural Shingle',
      details: 'Class 4 Hail Resistance (Recommended)',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) CONFIRM PATH — writes correct updateData, success + redirect, failure re-enables
// ─────────────────────────────────────────────────────────────────────────────
describe('(e) Confirm path', () => {
  let originalLocation: Location;
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth(authed());
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

  it('writes the correct update to the current claim id and lands on /dashboard on success', async () => {
    wireData({ claimId: 'claim-1', products: DESIGNER_PRODUCTS });
    (saveMaterialSelection as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    render(<HelpMaterialsPage />);
    fireEvent.click(screen.getByText('Metal Roofing'));
    fireEvent.click(screen.getByText('Standing Seam'));
    fireEvent.click(screen.getByText('Steel (Galvalume)'));
    fireEvent.click(screen.getByText('Confirm My Selection'));

    await waitFor(() => {
      expect(saveMaterialSelection).toHaveBeenCalledWith('claim-1', {
        material_category: 'metal',
        has_material_selection: true,
        metal_type: 'standing-seam',
        metal_material: 'steel',
      });
    });
    await waitFor(() => {
      expect(screen.getByText('Material Selection Saved')).toBeInTheDocument();
    });
    expect(window.location.href).toBe('/dashboard');
  });

  it('on failure shows an error and re-enables the Confirm button', async () => {
    wireData({ claimId: 'claim-1', products: DESIGNER_PRODUCTS });
    (saveMaterialSelection as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network'));

    render(<HelpMaterialsPage />);
    fireEvent.click(screen.getByText('Shingles'));
    fireEvent.click(screen.getByText('3-Tab Shingle'));
    fireEvent.click(screen.getByText('Confirm My Selection'));

    await waitFor(() => {
      expect(screen.getByText('Error saving selection. Please try again.')).toBeInTheDocument();
    });
    expect(screen.getByText('Confirm My Selection')).not.toBeDisabled();
    expect(window.location.href).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (f) NO-CLAIM / LOAD-ERROR states
// ─────────────────────────────────────────────────────────────────────────────
describe('(f) No-claim and load-error states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth(authed());
  });

  it('renders the no-claim message when there is no claim row', () => {
    wireData({ claimId: null });
    render(<HelpMaterialsPage />);
    expect(
      screen.getByText(/Could not find your project record/),
    ).toBeInTheDocument();
  });

  it('renders the error message when the claim load errors', () => {
    wireData({ claimId: null, claimError: new Error('boom') });
    render(<HelpMaterialsPage />);
    expect(
      screen.getByText(/Could not find your project record/),
    ).toBeInTheDocument();
  });

  it('shows a spinner while the claim is loading', () => {
    wireData({ claimId: null, claimLoading: true });
    const { container } = render(<HelpMaterialsPage />);
    expect(container.querySelector('.hm-spinner-ring')).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (g) PURE UNIT — utils invariants (faithful-port guards)
// ─────────────────────────────────────────────────────────────────────────────
describe('(g) utils', () => {
  it('buildClaimMaterialUpdate preserves designer impact verbatim (class4, not normalized)', () => {
    const state: MaterialSelectionState = {
      ...initialSelectionState(),
      category: 'shingles',
      shingleType: 'designer',
      designerProduct: 'Grand Sequoia',
      designerManufacturer: 'GAF',
      designerCatalogId: 'p1',
      impactClass: 'class4',
    };
    expect(buildClaimMaterialUpdate(state)).toEqual({
      material_category: 'shingles',
      has_material_selection: true,
      shingle_type: 'designer',
      impact_class: 'class4',
      designer_product: 'Grand Sequoia',
      designer_manufacturer: 'GAF',
    });
  });

  it('buildClaimMaterialUpdate preserves architectural hyphenated impact verbatim', () => {
    const state: MaterialSelectionState = {
      ...initialSelectionState(),
      category: 'shingles',
      shingleType: 'architectural',
      impactClass: 'class-4',
    };
    expect(buildClaimMaterialUpdate(state)).toEqual({
      material_category: 'shingles',
      has_material_selection: true,
      shingle_type: 'architectural',
      impact_class: 'class-4',
    });
  });

  it('isConfirmReady gates each branch correctly', () => {
    const base = initialSelectionState();
    expect(isConfirmReady({ ...base, category: 'shingles', shingleType: '3-tab' })).toBe(true);
    expect(isConfirmReady({ ...base, category: 'shingles', shingleType: 'architectural' })).toBe(false);
    expect(
      isConfirmReady({ ...base, category: 'shingles', shingleType: 'architectural', impactClass: 'none' }),
    ).toBe(true);
    expect(
      isConfirmReady({ ...base, category: 'metal', metalType: 'standing-seam' }),
    ).toBe(false);
    expect(
      isConfirmReady({ ...base, category: 'metal', metalType: 'standing-seam', metalMaterial: 'steel' }),
    ).toBe(true);
  });

  it('currentStep tracks progress', () => {
    const base = initialSelectionState();
    expect(currentStep(base)).toBe(1);
    expect(currentStep({ ...base, category: 'shingles' })).toBe(2);
    expect(currentStep({ ...base, category: 'shingles', shingleType: 'architectural' })).toBe(3);
    expect(
      currentStep({ ...base, category: 'shingles', shingleType: '3-tab' }),
    ).toBe(4);
  });

  it('badges + grouping + truncation helpers', () => {
    expect(impactBadge('class4')).toEqual({ label: 'Class 4', variant: 'impact4' });
    expect(impactBadge('class3')).toEqual({ label: 'Class 3', variant: 'impact3' });
    expect(impactBadge('none')).toBeNull();
    expect(tierBadge('premium')).toEqual({ label: 'Premium', variant: 'tier-premium' });
    expect(tierBadge('mid')).toEqual({ label: 'Moderate', variant: 'tier-mid' });
    expect(groupByManufacturer(DESIGNER_PRODUCTS).map((g) => g.manufacturer)).toEqual([
      'GAF',
      'CertainTeed',
    ]);
    expect(truncateDescription('a'.repeat(200)).length).toBe(160);
    expect(truncateDescription('short')).toBe('short');
  });

  it('pricingRows reflects the selection', () => {
    const base = initialSelectionState();
    expect(pricingRows({ ...base, category: 'shingles', shingleType: 'designer' }).map((r) => r.key)).toEqual([
      'architectural',
      'designer',
    ]);
    expect(
      pricingRows({ ...base, category: 'metal', metalType: 'standing-seam' }).map((r) => r.key),
    ).toEqual(['metal-standing']);
  });
});
