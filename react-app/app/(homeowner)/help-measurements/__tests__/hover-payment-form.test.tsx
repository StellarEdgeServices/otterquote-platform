/**
 * Retry-safety tests for HoverPaymentForm (gh-416) — the client-side double-charge guard
 * on /help-measurements.
 *
 * Drives the REAL component against a mocked window.Stripe (no Stripe.js CDN, no
 * network). Asserts the gh-416 acceptance criteria:
 *   1. Charge succeeds → order step throws → the Pay button (and Cancel) never re-arm;
 *      the form parks in the post-charge order-failed state with a Retry Order
 *      affordance. Simulates a Hover order failure immediately after a successful
 *      charge and confirms no second Stripe charge is triggered.
 *   2. Retry Order re-runs ONLY the order step, with the SAME recorded paymentIntent
 *      id — confirmCardPayment is never called a second time.
 *   3. Charge FAILS (Stripe decline / confirm throw — no successful charge observed) →
 *      Pay legitimately re-arms and no order is attempted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// STRIPE_PK is read at module-evaluation time in HoverPaymentForm — set it before the
// module imports below are evaluated.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_gh416';
});

import { HoverPaymentForm, ORDER_RETRY_COPY } from '../HoverPaymentForm';
import { MEASUREMENTS_COPY as M } from '../copy';

type Fn = ReturnType<typeof vi.fn>;

// ── window.Stripe mock (matches the component's minimal StripeLike typings) ──────

const cardElement = {
  mount: vi.fn(),
  unmount: vi.fn(),
  clear: vi.fn(),
  on: vi.fn(),
};
const confirmCardPayment = vi.fn();
const stripeMock = {
  elements: () => ({ create: () => cardElement }),
  confirmCardPayment,
};

beforeEach(() => {
  (window as unknown as { Stripe?: unknown }).Stripe = vi.fn(() => stripeMock);
});

afterEach(() => {
  vi.clearAllMocks();
  delete (window as unknown as { Stripe?: unknown }).Stripe;
});

async function renderMounted(onPaid: Fn, onCancel: Fn = vi.fn()) {
  render(<HoverPaymentForm clientSecret="cs_test_416" onPaid={onPaid} onCancel={onCancel} />);
  // Wait for the async Stripe.js bootstrap to mount the Card Element.
  await waitFor(() => expect(cardElement.mount).toHaveBeenCalledTimes(1));
}

const chargeSucceeds = () =>
  confirmCardPayment.mockResolvedValue({
    paymentIntent: { id: 'pi_gh416_1', status: 'succeeded' },
  });

const payButton = () =>
  screen.getByText(M.hoverPayButton).closest('button') as HTMLButtonElement;

// ── 1. Post-charge order failure: Pay/Cancel retired, retry affordance shown ─────

describe('HoverPaymentForm — order throws AFTER a successful charge (gh-416)', () => {
  it('never re-arms Pay or Cancel; parks in the order-failed state with Retry Order', async () => {
    chargeSucceeds();
    const onPaid = vi.fn().mockRejectedValue(new Error('hover order failed'));
    await renderMounted(onPaid);

    fireEvent.click(payButton());

    // Parked in the post-charge order-failed state…
    expect(await screen.findByText(ORDER_RETRY_COPY.retryButton)).toBeTruthy();
    expect(screen.getByText('hover order failed')).toBeTruthy();
    expect(screen.getByText(ORDER_RETRY_COPY.paidNoRecharge)).toBeTruthy();
    // …with the charge controls permanently retired (the old defect re-armed Pay here).
    expect(screen.queryByText(M.hoverPayButton)).toBeNull();
    expect(screen.queryByText(M.hoverCancelButton)).toBeNull();
    // Exactly ONE charge attempt; the order step received the confirmed intent id.
    expect(confirmCardPayment).toHaveBeenCalledTimes(1);
    expect(onPaid).toHaveBeenCalledTimes(1);
    expect(onPaid).toHaveBeenCalledWith('pi_gh416_1');
  });

  it('Retry Order re-runs only the order step with the SAME paymentIntent id — no second charge', async () => {
    chargeSucceeds();
    const onPaid = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockRejectedValueOnce(new Error('still down'))
      .mockResolvedValueOnce(undefined);
    await renderMounted(onPaid);

    fireEvent.click(payButton());

    // First failure → retry (fails again) → still parked; still exactly one charge.
    fireEvent.click(await screen.findByText(ORDER_RETRY_COPY.retryButton));
    expect(await screen.findByText('still down')).toBeTruthy();
    expect(screen.queryByText(M.hoverPayButton)).toBeNull();

    // Second retry succeeds → order placed (the parent advances/unmounts in prod).
    fireEvent.click(screen.getByText(ORDER_RETRY_COPY.retryButton));
    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(3));

    // The double-charge guard: confirmCardPayment ran EXACTLY once across all retries,
    // and every order attempt reused the same recorded paymentIntent id.
    expect(confirmCardPayment).toHaveBeenCalledTimes(1);
    expect(onPaid.mock.calls).toEqual([['pi_gh416_1'], ['pi_gh416_1'], ['pi_gh416_1']]);
    // Retry affordance cleared once the order went through; Pay still retired.
    await waitFor(() => expect(screen.queryByText(ORDER_RETRY_COPY.retryButton)).toBeNull());
    expect(screen.queryByText(M.hoverPayButton)).toBeNull();
  });

  it('order succeeds first try → ordering state only; no retry affordance, no re-armed Pay', async () => {
    chargeSucceeds();
    const onPaid = vi.fn().mockResolvedValue(undefined);
    await renderMounted(onPaid);

    fireEvent.click(payButton());
    await waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));

    expect(screen.getByText(M.payOrderingButton)).toBeTruthy();
    expect(screen.queryByText(ORDER_RETRY_COPY.retryButton)).toBeNull();
    expect(screen.queryByText(M.hoverPayButton)).toBeNull();
    expect(confirmCardPayment).toHaveBeenCalledTimes(1);
  });
});

// ── 2. Charge failure: legitimate re-arm (no successful charge was observed) ─────

describe('HoverPaymentForm — charge fails BEFORE any successful payment (legitimate re-arm)', () => {
  it('Stripe decline → error surfaces, Pay re-arms, no order attempted', async () => {
    confirmCardPayment.mockResolvedValue({ error: { message: 'Your card was declined.' } });
    const onPaid = vi.fn();
    await renderMounted(onPaid);

    fireEvent.click(payButton());

    expect(await screen.findByText('Your card was declined.')).toBeTruthy();
    expect(payButton().disabled).toBe(false); // re-armed — no charge happened
    expect(onPaid).not.toHaveBeenCalled();
    expect(screen.queryByText(ORDER_RETRY_COPY.retryButton)).toBeNull();

    // A second attempt may legitimately confirm again (still no successful charge).
    fireEvent.click(payButton());
    await waitFor(() => expect(confirmCardPayment).toHaveBeenCalledTimes(2));
    expect(onPaid).not.toHaveBeenCalled();
  });

  it('confirm itself throws (no charge observed) → Pay re-arms, no order attempted', async () => {
    confirmCardPayment.mockRejectedValue(new Error('network blip'));
    const onPaid = vi.fn();
    await renderMounted(onPaid);

    fireEvent.click(payButton());

    expect(await screen.findByText('network blip')).toBeTruthy();
    expect(payButton().disabled).toBe(false);
    expect(onPaid).not.toHaveBeenCalled();
    expect(screen.queryByText(ORDER_RETRY_COPY.retryButton)).toBeNull();
  });

  it('unexpected (non-succeeded) payment status → Pay re-arms, no order attempted', async () => {
    confirmCardPayment.mockResolvedValue({
      paymentIntent: { id: 'pi_gh416_1', status: 'requires_action' },
    });
    const onPaid = vi.fn();
    await renderMounted(onPaid);

    fireEvent.click(payButton());

    expect(
      await screen.findByText(/Unexpected payment status: requires_action/),
    ).toBeTruthy();
    expect(payButton().disabled).toBe(false);
    expect(onPaid).not.toHaveBeenCalled();
  });
});
