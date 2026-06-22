import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── Mock the auth + notification hooks the shell depends on (before import). ──
vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: () => ({ count: 0, loading: false, error: null }),
}));

// ── Mock supabase singleton so it never throws on missing env vars. ──
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
          order: vi.fn(() => ({
            limit: vi.fn(() => ({
              maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
            })),
          })),
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
          single: vi.fn(() => Promise.resolve({ data: null, error: null })),
        })),
      })),
      update: vi.fn(() => ({
        eq: vi.fn(() => Promise.resolve({ error: null })),
      })),
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve({ data: { id: 'req1' }, error: null })),
        })),
      })),
    })),
    functions: {
      invoke: vi.fn(() => Promise.resolve({ data: null, error: null })),
    },
  },
}));

// ── Mock Services so EF calls never fire in tests. ──
vi.mock('@/lib/services', () => ({
  Services: {
    sendAdjusterEmail: vi.fn(() =>
      Promise.resolve({
        success: true,
        ingest_email: 'docs-test@claims.otterquote.com',
        request_id: 'req1',
      }),
    ),
    findOrCreateAdjuster: vi.fn(() => Promise.resolve({ id: 'adj1' })),
    getCarrierHelp: vi.fn(() => Promise.resolve(null)),
  },
}));

// ── Shared mock for data hooks — individual tests set return values per-test. ──
vi.mock('../use-help-estimate-data', () => ({
  useHelpEstimateClaim: vi.fn(),
  useHelpEstimateProfile: vi.fn(),
  useCarrierHelp: vi.fn(),
}));

// ── Mock actions module — vi.fn() so component tests can override the resolution. ──
vi.mock('../actions', () => ({
  sendEstimateRequest: vi.fn(),
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import { HomeownerShell } from '../../_shell/HomeownerShell';
import {
  useHelpEstimateClaim,
  useHelpEstimateProfile,
  useCarrierHelp,
} from '../use-help-estimate-data';
import { buildEmailPreview, isEmailFormValid, requestTypeFor, buildCarrierTips } from '../utils';
import { CarrierTipsBlock } from '../components/CarrierTipsBlock';
import { EmailFlow } from '../components/EmailFlow';
import { sendEstimateRequest } from '../actions';
import { Services } from '@/lib/services';
import HelpEstimatePage from '../page';

// Grab the real sendEstimateRequest (bypasses the vi.mock so we can unit-test
// the actual orchestration). supabase and Services are still mocked above.
const { sendEstimateRequest: realSendEstimateRequest } = await vi.importActual<
  typeof import('../actions')
>('../actions');

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

function wireDataHooks(overrides: {
  claim?: object | null;
  claimLoading?: boolean;
  claimError?: Error | null;
  profile?: object | null;
  profileLoading?: boolean;
  carrier?: object | null;
  carrierLoading?: boolean;
} = {}) {
  const {
    claim = { id: 'c1', carrier_id: null, claim_number: 'CLM-1' },
    claimLoading = false,
    claimError = null,
    profile = { id: 'u1', full_name: 'Jane Doe', phone: '(317) 555-1234' },
    profileLoading = false,
    carrier = null,
    carrierLoading = false,
  } = overrides;

  (useHelpEstimateClaim as ReturnType<typeof vi.fn>).mockReturnValue({
    claim,
    loading: claimLoading,
    error: claimError,
  });
  (useHelpEstimateProfile as ReturnType<typeof vi.fn>).mockReturnValue({
    profile,
    loading: profileLoading,
  });
  (useCarrierHelp as ReturnType<typeof vi.fn>).mockReturnValue({
    carrier,
    loading: carrierLoading,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) GATE — HomeownerShell auth enforcement
// ─────────────────────────────────────────────────────────────────────────────
describe('(a) HomeownerShell gate on /help-estimate', () => {
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
    render(<HomeownerShell active="dashboard"><div>HELP_BODY</div></HomeownerShell>);
    expect(screen.getByText('HELP_BODY')).toBeInTheDocument();
    expect(window.location.href).toBe('');
  });

  it('renders for a null/unresolved role (permissive, like requireAuth)', () => {
    mockAuth(authed({ role: null }));
    render(<HomeownerShell active="dashboard"><div>HELP_BODY</div></HomeownerShell>);
    expect(screen.getByText('HELP_BODY')).toBeInTheDocument();
  });

  it('redirects an unauthenticated visitor to get-started.html (NOT sign-in.html)', () => {
    mockAuth(authed({ user: null, role: null }));
    render(<HomeownerShell active="dashboard"><div>HELP_BODY</div></HomeownerShell>);
    expect(window.location.href).toBe('https://otterquote.com/get-started.html');
    expect(window.location.href).not.toContain('sign-in.html');
    expect(screen.queryByText('HELP_BODY')).not.toBeInTheDocument();
  });

  it('redirects a contractor to the contractor dashboard', () => {
    mockAuth(authed({ role: 'contractor' }));
    render(<HomeownerShell active="dashboard"><div>HELP_BODY</div></HomeownerShell>);
    expect(window.location.href).toBe('https://otterquote.com/contractor-dashboard.html');
    expect(screen.queryByText('HELP_BODY')).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) TRIAGE ROUTING — section navigation
// ─────────────────────────────────────────────────────────────────────────────
describe('(b) Triage routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth(authed());
    wireDataHooks();
  });

  it('renders all three triage cards on initial load', () => {
    render(<HelpEstimatePage />);
    expect(screen.getByText("Yes, but I can't find it")).toBeInTheDocument();
    expect(screen.getByText("My adjuster hasn't sent it yet")).toBeInTheDocument();
    expect(screen.getByText('What is an insurance estimate?')).toBeInTheDocument();
  });

  it('clicking "Yes, but I can\'t find it" navigates to findit section', () => {
    render(<HelpEstimatePage />);
    fireEvent.click(screen.getByText("Yes, but I can't find it"));
    expect(screen.getByText('Finding Your Insurance Estimate')).toBeInTheDocument();
  });

  it('clicking "My adjuster hasn\'t sent it yet" navigates to email section', () => {
    render(<HelpEstimatePage />);
    fireEvent.click(screen.getByText("My adjuster hasn't sent it yet"));
    expect(screen.getByText('Request Your Estimate from Your Adjuster')).toBeInTheDocument();
  });

  it('clicking "What is an insurance estimate?" navigates to explainer section', () => {
    render(<HelpEstimatePage />);
    fireEvent.click(screen.getByText('What is an insurance estimate?'));
    expect(screen.getByText('What Is an Insurance Estimate?')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) VALIDATION + PREVIEW — pure unit tests + EmailFlow component
// ─────────────────────────────────────────────────────────────────────────────
describe('(c) Validation + preview', () => {
  describe('isEmailFormValid', () => {
    it('returns false for empty name', () => {
      expect(isEmailFormValid('', 'x@y.com')).toBe(false);
    });
    it('returns false for bad email (no dot)', () => {
      expect(isEmailFormValid('Bob', 'bademail')).toBe(false);
    });
    it('returns true for valid name + email', () => {
      expect(isEmailFormValid('Bob', 'b@b.com')).toBe(true);
    });
  });

  describe('buildEmailPreview', () => {
    const base = {
      adjusterName: 'John Adj',
      adjusterEmail: 'john@ins.com',
      homeownerName: 'Jane Doe',
      homeownerPhone: '(317) 555-1234',
      claimNumber: 'CLM-99',
    };

    it('without measurements: subject starts with "Request for Insurance Estimate" and body has no measurement sentence', () => {
      const p = buildEmailPreview({ ...base, alsoMeasurements: false });
      expect(p.subject).toMatch(/^Request for Insurance Estimate/);
      expect(p.subject).not.toMatch(/Measurements/);
      expect(p.body).not.toMatch(/measurements/i);
    });

    it('with measurements: subject is "Request for Insurance Estimate & Measurements" and body includes measurement request', () => {
      const p = buildEmailPreview({ ...base, alsoMeasurements: true });
      expect(p.subject).toBe(
        'Request for Insurance Estimate & Measurements — Jane Doe, Claim #CLM-99',
      );
      expect(p.body).toMatch(/property measurements/i);
    });
  });

  describe('requestTypeFor', () => {
    it('returns "both" when alsoMeasurements is true', () => {
      expect(requestTypeFor(true)).toBe('both');
    });
    it('returns "estimate" when alsoMeasurements is false', () => {
      expect(requestTypeFor(false)).toBe('estimate');
    });
  });

  describe('EmailFlow component', () => {
    const claim = { id: 'c1', carrier_id: null, claim_number: 'CLM-1' };

    beforeEach(() => {
      vi.clearAllMocks();
      // Default: success for EmailFlow component tests that test non-send behavior
      (sendEstimateRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        ingest_email: 'docs-test@claims.otterquote.com',
        request_id: 'r1',
      });
    });

    it('send button is disabled initially (empty fields)', () => {
      render(
        <EmailFlow
          claim={claim}
          homeownerName="Jane Doe"
          homeownerPhone="(317) 555-1234"
          onSent={vi.fn()}
          onBack={vi.fn()}
        />,
      );
      expect(screen.getByText('Review & Send Email')).toBeDisabled();
    });

    it('send button enables after valid name + email are entered', () => {
      render(
        <EmailFlow
          claim={claim}
          homeownerName="Jane Doe"
          homeownerPhone="(317) 555-1234"
          onSent={vi.fn()}
          onBack={vi.fn()}
        />,
      );
      fireEvent.change(screen.getByLabelText(/Adjuster Name/i), {
        target: { value: 'John Adj' },
      });
      fireEvent.change(screen.getByLabelText(/Adjuster Email/i), {
        target: { value: 'john@ins.com' },
      });
      expect(screen.getByText('Review & Send Email')).not.toBeDisabled();
    });

    it('toggling measurements checkbox updates preview subject', () => {
      render(
        <EmailFlow
          claim={claim}
          homeownerName="Jane Doe"
          homeownerPhone="(317) 555-1234"
          onSent={vi.fn()}
          onBack={vi.fn()}
        />,
      );
      // Initial: no "& Measurements" in subject
      expect(screen.queryByText(/Request for Insurance Estimate & Measurements/)).not.toBeInTheDocument();

      // Toggle measurements on
      fireEvent.click(screen.getByLabelText(/Also request property measurements/i));
      expect(screen.getByText(/Request for Insurance Estimate & Measurements/)).toBeInTheDocument();

      // Toggle back off
      fireEvent.click(screen.getByLabelText(/Also request property measurements/i));
      expect(screen.queryByText(/Request for Insurance Estimate & Measurements/)).not.toBeInTheDocument();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) SEND PATH
// ─────────────────────────────────────────────────────────────────────────────
describe('(d) Send path', () => {
  describe('unit: sendEstimateRequest orchestration via Services mock', () => {
    it('calls findOrCreateAdjuster before sendAdjusterEmail and passes correct params', async () => {
      const mockFindOrCreate = Services.findOrCreateAdjuster as ReturnType<typeof vi.fn>;
      const mockSendEmail = Services.sendAdjusterEmail as ReturnType<typeof vi.fn>;

      // Reset and configure
      mockFindOrCreate.mockReset();
      mockSendEmail.mockReset();
      mockFindOrCreate.mockResolvedValue({ id: 'adj1' });
      mockSendEmail.mockResolvedValue({
        success: true,
        ingest_email: 'docs-abc@claims.otterquote.com',
        request_id: 'req1',
      });

      // Use the REAL sendEstimateRequest (vi.importActual bypasses the vi.mock).
      // supabase and Services are still mocked above so no real network calls.
      await realSendEstimateRequest({
        claimId: 'c1',
        carrierId: 'carrier1',
        claimNumber: 'CLM-1',
        adjusterName: 'John Adj',
        adjusterEmail: 'john@ins.com',
        adjusterPhone: '(317) 555-0000',
        homeownerName: 'Jane Doe',
        homeownerPhone: '(317) 555-1234',
        alsoMeasurements: true,
      });

      // Both were called
      expect(mockFindOrCreate).toHaveBeenCalled();
      expect(mockSendEmail).toHaveBeenCalled();

      // findOrCreate was called before sendEmail (invocation order)
      const findOrder = mockFindOrCreate.mock.invocationCallOrder[0];
      const sendOrder = mockSendEmail.mock.invocationCallOrder[0];
      expect(findOrder).toBeLessThan(sendOrder);

      // sendAdjusterEmail received correct params
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          claim_id: 'c1',
          request_type: 'both',
          claim_number: 'CLM-1',
          adjuster_name: 'John Adj',
          adjuster_email: 'john@ins.com',
        }),
      );
    });
  });

  describe('component: EmailFlow send success', () => {
    const claim = { id: 'c1', carrier_id: null, claim_number: 'CLM-1' };

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('calls onSent when sendEstimateRequest resolves success', async () => {
      const onSent = vi.fn();
      (sendEstimateRequest as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        ingest_email: 'x@claims.otterquote.com',
        request_id: 'r1',
      });

      render(
        <EmailFlow
          claim={claim}
          homeownerName="Jane Doe"
          homeownerPhone="(317) 555-1234"
          onSent={onSent}
          onBack={vi.fn()}
        />,
      );

      fireEvent.change(screen.getByLabelText(/Adjuster Name/i), {
        target: { value: 'John Adj' },
      });
      fireEvent.change(screen.getByLabelText(/Adjuster Email/i), {
        target: { value: 'john@ins.com' },
      });

      fireEvent.click(screen.getByText('Review & Send Email'));

      await waitFor(() => {
        expect(onSent).toHaveBeenCalled();
      });
    });

    it('shows error message and re-enables button when sendEstimateRequest rejects', async () => {
      const onSent = vi.fn();
      (sendEstimateRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('network error'),
      );

      render(
        <EmailFlow
          claim={claim}
          homeownerName="Jane Doe"
          homeownerPhone="(317) 555-1234"
          onSent={onSent}
          onBack={vi.fn()}
        />,
      );

      fireEvent.change(screen.getByLabelText(/Adjuster Name/i), {
        target: { value: 'John Adj' },
      });
      fireEvent.change(screen.getByLabelText(/Adjuster Email/i), {
        target: { value: 'john@ins.com' },
      });

      fireEvent.click(screen.getByText('Review & Send Email'));

      await waitFor(() => {
        expect(screen.getByText(/Something went wrong/)).toBeInTheDocument();
      });

      expect(onSent).not.toHaveBeenCalled();
      // Button re-enabled after failure
      expect(screen.getByText('Review & Send Email')).not.toBeDisabled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) CARRIER TIPS
// ─────────────────────────────────────────────────────────────────────────────
describe('(e) Carrier tips', () => {
  it('buildCarrierTips(null) returns null', () => {
    expect(buildCarrierTips(null)).toBeNull();
  });

  it('buildCarrierTips with full carrier data returns structured tips', () => {
    const result = buildCarrierTips({
      id: 'x',
      carrier_name: 'State Farm',
      claims_portal_url: 'https://sf.com',
      claims_email: 'c@sf.com',
      claims_phone: '1-800',
      typical_estimate_days: 10,
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Tips for State Farm');
    const kinds = result!.tips.map((t) => t.kind);
    expect(kinds).toContain('portal');
    expect(kinds).toContain('email');
    expect(kinds).toContain('phone');
    expect(kinds).toContain('days');
  });

  it('CarrierTipsBlock renders carrier name and portal link as text/anchor', () => {
    const data = {
      title: 'Tips for State Farm',
      tips: [
        { kind: 'portal' as const, carrierName: 'State Farm', url: 'https://sf.com' },
        { kind: 'email' as const, email: 'c@sf.com' },
      ],
    };
    render(<CarrierTipsBlock data={data} />);
    expect(screen.getByText('Tips for State Farm')).toBeInTheDocument();
    const link = screen.getByText('State Farm Claims Portal');
    expect(link.closest('a')).toHaveAttribute('href', 'https://sf.com');
  });

  it('injection guard: process_notes with HTML string renders as text, not as HTML element', () => {
    const data = {
      title: 'Tips for Acme',
      tips: [{ kind: 'text' as const, text: '<img src=x onerror=alert(1)>' }],
    };
    const { container } = render(<CarrierTipsBlock data={data} />);
    // The literal string is present as text
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    // No actual <img> element rendered
    expect(container.querySelector('img')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (f) NO-CLAIM / ERROR states
// ─────────────────────────────────────────────────────────────────────────────
describe('(f) No-claim and error states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth(authed());
  });

  it('renders triage question even when claim is null (no crash)', () => {
    wireDataHooks({ claim: null });
    render(<HelpEstimatePage />);
    expect(screen.getByText("Yes, but I can't find it")).toBeInTheDocument();
  });

  it('shows error status message when claimError is set', () => {
    wireDataHooks({ claim: null, claimError: new Error('boom') });
    render(<HelpEstimatePage />);
    expect(screen.getByText(/couldn't load your claim/i)).toBeInTheDocument();
  });
});
