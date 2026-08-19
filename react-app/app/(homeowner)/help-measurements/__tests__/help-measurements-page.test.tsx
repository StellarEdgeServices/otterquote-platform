/**
 * Render + flow tests for the homeowner help-measurements page (D-211 Phase 28, PR 2/2).
 *
 * Mirrors color-selection-page.test.tsx (H5): mock the shell's auth + notification hooks,
 * the supabase singleton, the data layer, and the Stripe card form — drive the data hook's
 * return value directly. Asserts the brief's render + flow self-verify points: path
 * selection, the two happy paths (Hover paid → order; adjuster email → success), the
 * graceful EF-pending vs error branches, the already-sent note, and the locked email-preview
 * placeholder. No real Supabase/Stripe/EF is touched.
 *
 * gh-951 section (bottom of this file) covers the charge→order reload-persistence fix:
 * ../hover-charge-storage is NOT mocked — tests seed/inspect real jsdom sessionStorage via
 * its exported helpers, exercising the actual persist/resume/clear behaviour rather than a
 * stub.
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
vi.mock('../use-help-measurements-data', () => ({
  useHelpMeasurementsData: vi.fn(),
  requestHoverPaymentIntent: vi.fn(),
  placeHoverOrder: vi.fn(),
  sendMeasurementRequest: vi.fn(),
}));

// Mock the Stripe card form so the test can drive onPaid/onCancel without Stripe.js.
vi.mock('../HoverPaymentForm', () => ({
  isStripeConfigured: vi.fn(() => true),
  HoverPaymentForm: ({
    onPaid,
    onCancel,
  }: {
    onPaid: (id: string) => void | Promise<void>;
    onCancel: () => void;
  }) => (
    <div data-testid="hover-payment-form">
      <button
        data-testid="pay-now"
        onClick={async () => {
          try {
            await onPaid('pi_test_123');
          } catch {
            /* the real form surfaces this; swallow in the stub */
          }
        }}
      >
        Pay
      </button>
      <button data-testid="cancel-pay" onClick={onCancel}>
        Cancel
      </button>
    </div>
  ),
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import {
  useHelpMeasurementsData,
  requestHoverPaymentIntent,
  placeHoverOrder,
  sendMeasurementRequest,
} from '../use-help-measurements-data';
import { isStripeConfigured } from '../HoverPaymentForm';
import { MEASUREMENTS_COPY as M } from '../copy';
import HelpMeasurementsPage, { RESUME_COPY } from '../page';
import {
  saveHoverChargeRecord,
  readHoverChargeRecord,
  clearHoverChargeRecord,
} from '../hover-charge-storage';

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
  (isStripeConfigured as unknown as Fn).mockReturnValue(true);
  // gh-951: a realistic `pi_..._secret_...` shape so paymentIntentIdFromClientSecret (the
  // resume-pointer write in purchaseHover) round-trips in tests that don't override this.
  (requestHoverPaymentIntent as unknown as Fn).mockResolvedValue({
    client_secret: 'pi_test_secret_cs_test',
  });
  (placeHoverOrder as unknown as Fn).mockResolvedValue({ order_id: 'o1', capture_link: null });
  (sendMeasurementRequest as unknown as Fn).mockResolvedValue(undefined);
  // gh-951: start every test with a clean resume pointer (real sessionStorage, not mocked).
  clearHoverChargeRecord();
});

afterEach(() => {
  vi.clearAllMocks();
  clearHoverChargeRecord();
});

// ── 1. Render: header + path selection ─────────────────────────────────────────

describe('help-measurements page — render', () => {
  it('renders the header and both path cards', async () => {
    render(<HelpMeasurementsPage />);
    expect(await screen.findByText(M.pageTitle)).toBeTruthy();
    expect(screen.getByText(M.pathIntroTitle)).toBeTruthy();
    expect(screen.getByText(M.hoverCardTitle)).toBeTruthy();
    expect(screen.getByText(M.adjusterCardTitle)).toBeTruthy();
    // The D-205 price line renders verbatim.
    expect(screen.getByText(M.hoverCardPrice)).toBeTruthy();
  });

  it('shows a boot spinner while data is loading', () => {
    (useHelpMeasurementsData as unknown as Fn).mockReturnValue(readyData({ loading: true }));
    const { container } = render(<HelpMeasurementsPage />);
    expect(container.querySelector('.hm-boot')).toBeTruthy();
  });
});

// ── 2. Path A (Hover) happy path: PI → card form → pay → order → success ────────

describe('help-measurements page — Hover paid path', () => {
  it('creates the PaymentIntent, shows the card form, then places the order on success', async () => {
    render(<HelpMeasurementsPage />);

    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[0]); // Hover card
    expect(await screen.findByText(M.hoverSectionTitle)).toBeTruthy();

    fireEvent.click(screen.getByText(M.hoverPurchaseButton));

    await waitFor(() =>
      expect(requestHoverPaymentIntent as unknown as Fn).toHaveBeenCalledTimes(1),
    );
    // Card form appears only after a client_secret comes back.
    expect(await screen.findByTestId('hover-payment-form')).toBeTruthy();

    fireEvent.click(screen.getByTestId('pay-now'));

    await waitFor(() => expect(placeHoverOrder as unknown as Fn).toHaveBeenCalledTimes(1));
    expect((placeHoverOrder as unknown as Fn).mock.calls[0][0]).toMatchObject({
      claim: { id: 'c1' },
      paymentIntentId: 'pi_test_123',
    });
    // Hover success state.
    expect(await screen.findByText(M.hoverSuccessTitle)).toBeTruthy();
  });

  it('surfaces an init error and does NOT show the card form when no client_secret returns', async () => {
    (requestHoverPaymentIntent as unknown as Fn).mockResolvedValue({ client_secret: null });
    render(<HelpMeasurementsPage />);
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[0]);
    fireEvent.click(await screen.findByText(M.hoverPurchaseButton));

    expect(await screen.findByText(M.statusPaymentInitError)).toBeTruthy();
    expect(screen.queryByTestId('hover-payment-form')).toBeNull();
  });

  it('gates on Stripe config: no key → init error, no PaymentIntent created', async () => {
    (isStripeConfigured as unknown as Fn).mockReturnValue(false);
    render(<HelpMeasurementsPage />);
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[0]);
    fireEvent.click(await screen.findByText(M.hoverPurchaseButton));

    expect(await screen.findByText(M.statusPaymentInitError)).toBeTruthy();
    expect(requestHoverPaymentIntent as unknown as Fn).not.toHaveBeenCalled();
  });

  it('keeps the user on the card form (no success) when the order placement throws', async () => {
    (placeHoverOrder as unknown as Fn).mockRejectedValue(new Error('order failed'));
    render(<HelpMeasurementsPage />);
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[0]);
    fireEvent.click(await screen.findByText(M.hoverPurchaseButton));
    fireEvent.click(await screen.findByTestId('pay-now'));

    await waitFor(() => expect(placeHoverOrder as unknown as Fn).toHaveBeenCalledTimes(1));
    // Order threw → success NOT shown; card form still present.
    expect(screen.queryByText(M.hoverSuccessTitle)).toBeNull();
    expect(screen.getByTestId('hover-payment-form')).toBeTruthy();
  });
});

// ── 3. Path B (Adjuster) happy path + branches ──────────────────────────────────

describe('help-measurements page — adjuster email path', () => {
  it('renders the locked email-preview placeholder (no fabricated body)', async () => {
    render(<HelpMeasurementsPage />);
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[1]); // Adjuster card
    expect(await screen.findByText(M.emailPreviewHeading)).toBeTruthy();
    expect(screen.getByText(M.emailPreviewLoading)).toBeTruthy();
  });

  it('sends the request and advances to the email success state', async () => {
    render(<HelpMeasurementsPage />);
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[1]);

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
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[1]);
    const btn = (await screen.findByText(M.sendMeasurementEmailButton)) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    const email = screen.getByPlaceholderText(M.adjusterEmailPlaceholder) as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'valid@x.com' } });
    expect(btn.disabled).toBe(false);
  });

  it('surfaces an error and stays on the form when the send fails', async () => {
    (sendMeasurementRequest as unknown as Fn).mockRejectedValue(new Error('send failed'));
    render(<HelpMeasurementsPage />);
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[1]);
    const email = screen.getByPlaceholderText(M.adjusterEmailPlaceholder) as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'john@insurance.com' } });
    fireEvent.click(screen.getByText(M.sendMeasurementEmailButton));

    expect(await screen.findByText(M.statusEmailError)).toBeTruthy();
    expect(screen.queryByText(M.emailSuccessTitle)).toBeNull();
  });

  it('shows the already-sent note when a combined request already exists', async () => {
    (useHelpMeasurementsData as unknown as Fn).mockReturnValue(readyData({ alreadySentBoth: true }));
    render(<HelpMeasurementsPage />);
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[1]);
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
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[1]);
    const email = (await screen.findByPlaceholderText(
      M.adjusterEmailPlaceholder,
    )) as HTMLInputElement;
    expect(email.value).toBe('existing@ins.com');
    expect((screen.getByPlaceholderText(M.adjusterNamePlaceholder) as HTMLInputElement).value).toBe(
      'Existing Adj',
    );
  });
});

// ── 4. gh-951 — charge→order reload persistence ─────────────────────────────────

describe('help-measurements page — gh-951 resume after a full-page reload', () => {
  it('persists a resume pointer the moment the PaymentIntent is created, before any charge', async () => {
    (requestHoverPaymentIntent as unknown as Fn).mockResolvedValue({
      client_secret: 'pi_new_charge_secret_abc123',
    });
    render(<HelpMeasurementsPage />);
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[0]);
    fireEvent.click(await screen.findByText(M.hoverPurchaseButton));

    await screen.findByTestId('hover-payment-form');
    // The card was never charged yet (no Pay click) — the pointer must already exist.
    expect(readHoverChargeRecord()).toMatchObject({
      claimId: 'c1',
      paymentIntentId: 'pi_new_charge',
    });
  });

  it('clears the resume pointer once the order is placed via the normal (non-reload) flow', async () => {
    render(<HelpMeasurementsPage />);
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[0]);
    fireEvent.click(await screen.findByText(M.hoverPurchaseButton));
    await screen.findByTestId('hover-payment-form');
    expect(readHoverChargeRecord()).not.toBeNull();

    fireEvent.click(screen.getByTestId('pay-now'));
    await waitFor(() => expect(placeHoverOrder as unknown as Fn).toHaveBeenCalledTimes(1));
    expect(readHoverChargeRecord()).toBeNull();
  });

  it('clears the resume pointer when the user cancels before charging', async () => {
    render(<HelpMeasurementsPage />);
    fireEvent.click((await screen.findAllByText(M.cardSelectButton))[0]);
    fireEvent.click(await screen.findByText(M.hoverPurchaseButton));
    await screen.findByTestId('hover-payment-form');
    expect(readHoverChargeRecord()).not.toBeNull();

    fireEvent.click(screen.getByTestId('cancel-pay'));
    expect(readHoverChargeRecord()).toBeNull();
  });

  it('on mount, resumes automatically and lands on the success screen when the order confirms', async () => {
    saveHoverChargeRecord({ claimId: 'c1', paymentIntentId: 'pi_resume_1', ts: Date.now() });
    (placeHoverOrder as unknown as Fn).mockResolvedValue({
      order_id: 'o1',
      capture_link: 'https://hover.example/capture/1',
      capture_request_id: 'cap_1',
    });

    render(<HelpMeasurementsPage />);

    await waitFor(() => expect(placeHoverOrder as unknown as Fn).toHaveBeenCalledTimes(1));
    expect((placeHoverOrder as unknown as Fn).mock.calls[0][0]).toMatchObject({
      claim: { id: 'c1' },
      paymentIntentId: 'pi_resume_1',
    });
    expect(await screen.findByText(M.hoverSuccessTitle)).toBeTruthy();
    // No path-selection flash left behind, and the pointer is gone either way.
    expect(screen.queryByText(M.pathIntroTitle)).toBeNull();
    expect(readHoverChargeRecord()).toBeNull();
  });

  it('shows the neutral resume-unresolved message (not a false success) when the order does not confirm', async () => {
    saveHoverChargeRecord({ claimId: 'c1', paymentIntentId: 'pi_resume_2', ts: Date.now() });
    // Mirrors create-hover-order's D-181 guard shape: it resolves (does not throw) with
    // `placeholder: true` and no capture_request_id when the PaymentIntent never succeeded.
    (placeHoverOrder as unknown as Fn).mockResolvedValue({
      order_id: 'o1',
      capture_link: null,
      placeholder: true,
      message: 'Hover order creation failed. Please try again.',
    });

    render(<HelpMeasurementsPage />);

    await waitFor(() => expect(placeHoverOrder as unknown as Fn).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(RESUME_COPY.unresolved)).toBeTruthy();
    expect(screen.queryByText(M.hoverSuccessTitle)).toBeNull();
    expect(readHoverChargeRecord()).toBeNull();
  });

  it('clears the pointer and surfaces the unresolved message when the order step throws', async () => {
    saveHoverChargeRecord({ claimId: 'c1', paymentIntentId: 'pi_resume_3', ts: Date.now() });
    (placeHoverOrder as unknown as Fn).mockRejectedValue(new Error('network blip'));

    render(<HelpMeasurementsPage />);

    await waitFor(() => expect(placeHoverOrder as unknown as Fn).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(RESUME_COPY.unresolved)).toBeTruthy();
    expect(readHoverChargeRecord()).toBeNull();
  });

  it('ignores a pending pointer left over from a different claim — no resume attempt', async () => {
    saveHoverChargeRecord({ claimId: 'some-other-claim', paymentIntentId: 'pi_stale', ts: Date.now() });

    render(<HelpMeasurementsPage />);

    expect(await screen.findByText(M.pathIntroTitle)).toBeTruthy();
    expect(placeHoverOrder as unknown as Fn).not.toHaveBeenCalled();
    // A mismatched pointer is left alone (harmless in sessionStorage; it never matches).
    expect(readHoverChargeRecord()).toMatchObject({ claimId: 'some-other-claim' });
  });

  it('does nothing when there is no pending pointer at all', async () => {
    render(<HelpMeasurementsPage />);

    expect(await screen.findByText(M.pathIntroTitle)).toBeTruthy();
    expect(placeHoverOrder as unknown as Fn).not.toHaveBeenCalled();
  });
});
