/**
 * Render + flow tests for the homeowner help-measurements page.
 *
 * gh-1873 (Hover retirement): the paid vendor-report path (PaymentIntent -> card form -> create-hover-order) was removed
 * from this page. These tests pin the replacement behaviour:
 *   - the select view shows a "temporarily unavailable" notice and ONLY the free Ask-Adjuster card;
 *   - nothing on the page can create a PaymentIntent, mount the card form or call create-hover-order, so no homeowner is
 *     charged for a report that cannot be delivered (NEGATIVE CONTROL: against main's page.tsx the Hover card renders and
 *     "Purchase Property Data File" creates a PaymentIntent, so the first three tests fail);
 *   - a resume pointer left in sessionStorage by an earlier visit (gh-951) is cleared and the homeowner is told to contact
 *     support; no Edge Function is called;
 *   - the Ask-Adjuster email path (unchanged) and the gh-2121 already-signed-in lead link keep working.
 * The removed gh-2078 measurement_purchase opt-out tests exercised the page's handlePaid/resume routes, which no longer exist;
 * the opt-out gate itself (lib/ad-optout) keeps its own tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: () => ({ count: 0, loading: false, error: null }),
}));
vi.mock('@/lib/supabase', () => ({
  // status: 200 -- linkPendingLeadOnce (gh-2121 M3) only clears the sessionStorage capture on a definitive 200-499 answer.
  supabase: {
    from: vi.fn(),
    auth: { getSession: vi.fn() },
    functions: { invoke: vi.fn() },
    rpc: vi.fn(() => Promise.resolve({ data: true, error: null, status: 200 })),
  },
}));

// Mock the data layer. After gh-1873 it exports only the reads and the adjuster email.
vi.mock('../use-help-measurements-data', () => ({
  useHelpMeasurementsData: vi.fn(),
  sendMeasurementRequest: vi.fn(),
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase as sbMock } from '@/lib/supabase';
import { useHelpMeasurementsData, sendMeasurementRequest } from '../use-help-measurements-data';
import { MEASUREMENTS_COPY as M } from '../copy';
import HelpMeasurementsPage, { RESUME_COPY, HOVER_RETIRED_COPY } from '../page';
import { saveHoverChargeRecord, readHoverChargeRecord, clearHoverChargeRecord } from '../hover-charge-storage';

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
    property_address: '123 Oak St, Zionsville 46077',
    claim_number: 'CLM-1',
    adjuster_name: null,
    adjuster_email: null,
    adjuster_phone: null,
  },
  profile: { full_name: 'Jane Roof', phone: '(317) 555-1234' },
  alreadySentBoth: false,
  loading: false,
  error: null,
  ...over,
});

beforeEach(() => {
  (useAuthReady as unknown as Fn).mockReturnValue(authed());
  (useHelpMeasurementsData as unknown as Fn).mockReturnValue(readyData());
  (sendMeasurementRequest as unknown as Fn).mockResolvedValue(undefined);
  clearHoverChargeRecord();
});

afterEach(() => {
  vi.clearAllMocks();
  clearHoverChargeRecord();
});

// ── 1. Render: header + path selection ─────────────────────────────────────────

describe('help-measurements page — render (gh-1873)', () => {
  it('renders the header, the temporarily-unavailable notice and ONLY the Ask-Adjuster card', async () => {
    render(<HelpMeasurementsPage />);
    expect(await screen.findByText(M.pageTitle)).toBeTruthy();
    expect(screen.getByText(M.pathIntroTitle)).toBeTruthy();
    expect(screen.getByTestId('hover-retired-notice').textContent).toContain(HOVER_RETIRED_COPY.title);
    expect(screen.getByTestId('hover-retired-notice').textContent).toContain('you will not be charged');
    expect(screen.getByText(M.adjusterCardTitle)).toBeTruthy();
    // The paid vendor-report card, its price line and its purchase button are gone.
    expect(screen.queryByText(M.hoverCardTitle)).toBeNull();
    expect(screen.queryByText(M.hoverCardPrice)).toBeNull();
    expect(screen.queryByText(M.hoverPurchaseButton)).toBeNull();
    expect(screen.getAllByText(M.cardSelectButton)).toHaveLength(1);
  });

  it('never touches an Edge Function or the card form while rendering and while choosing the adjuster path', async () => {
    render(<HelpMeasurementsPage />);
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[0]);
    expect(await screen.findByText(M.emailPreviewHeading)).toBeTruthy();
    expect(sbMock.functions.invoke as unknown as Fn).not.toHaveBeenCalled();
    expect(screen.queryByTestId('hover-payment-form')).toBeNull();
  });

  it('shows a boot spinner while data is loading', () => {
    (useHelpMeasurementsData as unknown as Fn).mockReturnValue(readyData({ loading: true }));
    const { container } = render(<HelpMeasurementsPage />);
    expect(container.querySelector('.hm-boot')).toBeTruthy();
  });
});

describe('help-measurements page — adjuster email path', () => {
  it('renders the locked email-preview placeholder (no fabricated body)', async () => {
    render(<HelpMeasurementsPage />);
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[0]); // the only card now: Ask Adjuster
    expect(await screen.findByText(M.emailPreviewHeading)).toBeTruthy();
    expect(screen.getByText(M.emailPreviewLoading)).toBeTruthy();
  });

  it('sends the request and advances to the email success state', async () => {
    render(<HelpMeasurementsPage />);
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[0]);

    const email = (await screen.findByPlaceholderText(
      M.adjusterEmailPlaceholder,
    )) as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'john@insurance.com' } });

    fireEvent.click(screen.getByText(M.sendMeasurementEmailButton));

    await waitFor(() => expect(sendMeasurementRequest as unknown as Fn).toHaveBeenCalledTimes(1));
    expect((sendMeasurementRequest as unknown as Fn).mock.calls[0][0]).toMatchObject({
      claim: { id: 'c1' },
      adjusterEmail: 'john@insurance.com',
    });
    expect(await screen.findByText(M.emailSuccessTitle)).toBeTruthy();
  });

  it('disables Send until a valid email is entered', async () => {
    render(<HelpMeasurementsPage />);
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[0]);
    const btn = (await screen.findByText(M.sendMeasurementEmailButton)) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    const email = screen.getByPlaceholderText(M.adjusterEmailPlaceholder) as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'valid@x.com' } });
    expect(btn.disabled).toBe(false);
  });

  it('surfaces an error and stays on the form when the send fails', async () => {
    (sendMeasurementRequest as unknown as Fn).mockRejectedValue(new Error('send failed'));
    render(<HelpMeasurementsPage />);
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[0]);
    const email = screen.getByPlaceholderText(M.adjusterEmailPlaceholder) as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'john@insurance.com' } });
    fireEvent.click(screen.getByText(M.sendMeasurementEmailButton));

    expect(await screen.findByText(M.statusEmailError)).toBeTruthy();
    expect(screen.queryByText(M.emailSuccessTitle)).toBeNull();
  });

  it('shows the already-sent note when a combined request already exists', async () => {
    (useHelpMeasurementsData as unknown as Fn).mockReturnValue(readyData({ alreadySentBoth: true }));
    render(<HelpMeasurementsPage />);
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[0]);
    expect(await screen.findByText(M.alreadySentEstimateNote)).toBeTruthy();
  });

  it('prefills the adjuster fields from the claim', async () => {
    (useHelpMeasurementsData as unknown as Fn).mockReturnValue(
      readyData({
        claim: {
          id: 'c1',
          claim_number: 'CLM-1',
          adjuster_name: 'Existing Adj',
          adjuster_email: 'existing@ins.com',
          adjuster_phone: '(317) 000-0000',
        },
      }),
    );
    render(<HelpMeasurementsPage />);
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[0]);
    const email = (await screen.findByPlaceholderText(
      M.adjusterEmailPlaceholder,
    )) as HTMLInputElement;
    expect(email.value).toBe('existing@ins.com');
    expect((screen.getByPlaceholderText(M.adjusterNamePlaceholder) as HTMLInputElement).value).toBe(
      'Existing Adj',
    );
  });
});

// ── 4. gh-951 pointer left by an earlier visit: cleared, never retried (gh-1873) ──────────────────────────

describe('help-measurements page — a leftover vendor-report order pointer (gh-951 / gh-1873)', () => {
  it('clears a pointer for the loaded claim, tells the homeowner to contact support, and calls no Edge Function', async () => {
    saveHoverChargeRecord({ claimId: 'c1', paymentIntentId: 'pi_resume_1', ts: Date.now() });

    render(<HelpMeasurementsPage />);

    expect(await screen.findByText(RESUME_COPY.unresolved)).toBeTruthy();
    expect(readHoverChargeRecord()).toBeNull();
    expect(sbMock.functions.invoke as unknown as Fn).not.toHaveBeenCalled();
    // The page is usable afterwards: the select view renders and no success screen was shown.
    expect(await screen.findByText(M.pathIntroTitle)).toBeTruthy();
    expect(screen.queryByText(M.hoverSuccessTitle)).toBeNull();
  });

  it('clears a pointer left over from a different claim without a message', async () => {
    saveHoverChargeRecord({ claimId: 'some-other-claim', paymentIntentId: 'pi_stale', ts: Date.now() });

    render(<HelpMeasurementsPage />);

    expect(await screen.findByText(M.pathIntroTitle)).toBeTruthy();
    expect(screen.queryByText(RESUME_COPY.unresolved)).toBeNull();
    expect(readHoverChargeRecord()).toBeNull();
    expect(sbMock.functions.invoke as unknown as Fn).not.toHaveBeenCalled();
  });

  it('does nothing when there is no pending pointer at all', async () => {
    render(<HelpMeasurementsPage />);

    expect(await screen.findByText(M.pathIntroTitle)).toBeTruthy();
    expect(screen.queryByText(RESUME_COPY.unresolved)).toBeNull();
    expect(sbMock.functions.invoke as unknown as Fn).not.toHaveBeenCalled();
  });
});

// ── gh-2121 (S16) / PR #2163 REVIEW: FAIL fix (M1's third Arm F scenario) ──────
// An ALREADY-signed-in visitor landing here directly with a live `?lead=`
// never goes through get-started/page.tsx's signUp() — this page (rendered
// only once HomeownerShell has resolved a real `user`) is where that case
// is linked instead. See app/lib/lead-capture.ts.
describe('help-measurements page — gh-2121 already-signed-in lead link', () => {
  afterEach(() => {
    sessionStorage.removeItem('oq_pending_lead');
  });

  it('calls set_lead_converted once when a pending lead was captured for a signed-in visitor', async () => {
    sessionStorage.setItem('oq_pending_lead', JSON.stringify({ id: 'lead-already-signed-in', exp: Date.now() + 60000 }));

    render(<HelpMeasurementsPage />);

    await waitFor(() =>
      expect(sbMock.rpc).toHaveBeenCalledWith('set_lead_converted', { p_lead_id: 'lead-already-signed-in' }),
    );
    expect(sessionStorage.getItem('oq_pending_lead')).toBeNull();
  });

  it('negative control: no pending lead -> set_lead_converted is never called', async () => {
    render(<HelpMeasurementsPage />);

    await screen.findByText(M.pathIntroTitle);
    expect(sbMock.rpc).not.toHaveBeenCalled();
  });
});

