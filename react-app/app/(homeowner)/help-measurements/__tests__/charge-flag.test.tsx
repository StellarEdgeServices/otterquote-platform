/**
 * gh-3858 (P23 piece B): the measurement charge is mounted on /help-measurements only behind
 * NEXT_PUBLIC_MEASUREMENT_CHARGE_ENABLED, which is ON only for the exact string 'true'.
 *
 *   - flag OFF (unset, 'false', 'TRUE', '1', '', ' true'): the paused notice (HOVER_RETIRED_COPY) renders, the card form is NOT
 *     mounted, no Edge Function is called, and no `[PENDING #3865` placeholder can reach the page;
 *   - flag ON: the charge step mounts, a PaymentIntent for 2263 is requested for the claim, the card form mounts, and the order
 *     (create-measurement-order -> the awaiting_fulfillment hover_orders row) is recorded ONLY after Stripe reports 'succeeded'.
 * The live test-mode walk on an is_test claim is NOT covered here; it needs the deployed Edge Functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// STRIPE_PK is read when HoverPaymentForm is evaluated.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_gh3858';
});

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: () => ({ count: 0, loading: false, error: null }),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    auth: { getSession: vi.fn() },
    functions: { invoke: vi.fn() },
    rpc: vi.fn(() => Promise.resolve({ data: true, error: null, status: 200 })),
  },
}));
vi.mock('@/lib/services', () => ({
  sendAdjusterEmail: vi.fn(),
  createHoverPaymentIntent: vi.fn(),
}));
// Real data helpers (requestMeasurementPaymentIntent / recordMeasurementOrder); only the page's read hook is faked.
vi.mock('../use-help-measurements-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../use-help-measurements-data')>()),
  useHelpMeasurementsData: vi.fn(),
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase as sbMock } from '@/lib/supabase';
import { createHoverPaymentIntent } from '@/lib/services';
import { useHelpMeasurementsData } from '../use-help-measurements-data';
import { MEASUREMENTS_COPY as M, CHARGE_STEP_COPY_PENDING_GH3865 as PENDING } from '../copy';
import HelpMeasurementsPage, { HOVER_RETIRED_COPY } from '../page';
import { isMeasurementChargeEnabled } from '@/lib/measurement-charge-flag';
import { clearHoverChargeRecord } from '../hover-charge-storage';

type Fn = ReturnType<typeof vi.fn>;

const cardElement = { mount: vi.fn(), unmount: vi.fn(), clear: vi.fn(), on: vi.fn() };
const confirmCardPayment = vi.fn();
const stripeMock = { elements: () => ({ create: () => cardElement }), confirmCardPayment };

beforeEach(() => {
  (useAuthReady as unknown as Fn).mockReturnValue({
    user: { id: 'u1', email: 'jane@example.com' },
    role: 'homeowner',
    isAdmin: false,
    loading: false,
    settled: true,
    signOut: vi.fn(),
  });
  (useHelpMeasurementsData as unknown as Fn).mockReturnValue({
    claim: { id: 'c1', property_address: '123 Oak St', claim_number: 'CLM-1', adjuster_name: null, adjuster_email: null, adjuster_phone: null },
    profile: { full_name: 'Jane Roof', phone: '(317) 555-1234' },
    alreadySentBoth: false,
    loading: false,
    error: null,
  });
  (window as unknown as { Stripe?: unknown }).Stripe = vi.fn(() => stripeMock);
  clearHoverChargeRecord();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  delete (window as unknown as { Stripe?: unknown }).Stripe;
  clearHoverChargeRecord();
});

describe('isMeasurementChargeEnabled: ON only for the exact string "true"', () => {
  it.each([
    ['true', true],
    [undefined, false],
    ['', false],
    ['false', false],
    ['TRUE', false],
    ['True', false],
    ['1', false],
    ['yes', false],
    [' true', false],
    ['true ', false],
  ])('%j -> %s', (v, expected) => {
    expect(isMeasurementChargeEnabled(v as string | undefined)).toBe(expected);
  });
});

describe('flag OFF: the page is the paused-notice page (the same output main renders)', () => {
  it.each([[undefined], ['false'], ['TRUE'], ['1'], [''], [' true']])(
    'value %j: paused notice, no charge step, no card form, no Edge Function, no [PENDING #3865 marker',
    async (value) => {
      if (value !== undefined) vi.stubEnv('NEXT_PUBLIC_MEASUREMENT_CHARGE_ENABLED', value);
      else vi.stubEnv('NEXT_PUBLIC_MEASUREMENT_CHARGE_ENABLED', undefined as unknown as string);
      const { container } = render(<HelpMeasurementsPage />);

      const notice = await screen.findByTestId('hover-retired-notice');
      expect(notice.textContent).toContain(HOVER_RETIRED_COPY.title);
      expect(screen.queryByTestId('charge-step')).toBeNull();
      expect(screen.queryByTestId('hover-payment-form')).toBeNull();
      expect(container.querySelector('.hm-payform')).toBeNull();

      // The lock: a placeholder marker can never render with the flag off (select view, then the adjuster view).
      expect(container.textContent).not.toContain('[PENDING #3865');
      fireEvent.click(screen.getAllByText(M.cardSelectButton)[0]);
      await screen.findByText(M.emailPreviewHeading);
      expect(container.textContent).not.toContain('[PENDING #3865');

      expect((sbMock.functions.invoke as unknown as Fn)).not.toHaveBeenCalled();
      expect(createHoverPaymentIntent as unknown as Fn).not.toHaveBeenCalled();
    },
  );

  it('every placeholder value really is a [PENDING #3865 marker (so the lock above guards all of them)', () => {
    const values = Object.values(PENDING);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v.startsWith('[PENDING #3865')).toBe(true);
  });
});

describe('flag ON: the charge step mounts the card form and records the order only after a succeeded payment', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_MEASUREMENT_CHARGE_ENABLED', 'true');
  });

  it('replaces the paused notice with the charge step; the form is not mounted until the PaymentIntent exists', async () => {
    render(<HelpMeasurementsPage />);
    expect(await screen.findByTestId('charge-step')).toBeTruthy();
    expect(screen.queryByTestId('hover-retired-notice')).toBeNull();
    expect(screen.queryByTestId('hover-payment-form')).toBeNull();
    expect(createHoverPaymentIntent as unknown as Fn).not.toHaveBeenCalled();
  });

  it('creates a PaymentIntent for 2263 on the claim, mounts HoverPaymentForm, then records the order after "succeeded"', async () => {
    (createHoverPaymentIntent as unknown as Fn).mockResolvedValue({ client_secret: 'pi_gh3858_1_secret_abc' });
    confirmCardPayment.mockResolvedValue({ paymentIntent: { id: 'pi_gh3858_1', status: 'succeeded' } });
    (sbMock.functions.invoke as unknown as Fn).mockResolvedValue({ data: { order_id: 'o1', status: 'awaiting_fulfillment' }, error: null });

    render(<HelpMeasurementsPage />);
    fireEvent.click(await screen.findByText(PENDING.startButton));

    expect(await screen.findByTestId('hover-payment-form')).toBeTruthy();
    expect(createHoverPaymentIntent as unknown as Fn).toHaveBeenCalledTimes(1);
    expect((createHoverPaymentIntent as unknown as Fn).mock.calls[0][0]).toMatchObject({ claim_id: 'c1', amount: 2263 });
    // No order before the card is charged.
    expect(sbMock.functions.invoke as unknown as Fn).not.toHaveBeenCalled();

    await waitFor(() => expect(cardElement.mount).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText(M.hoverPayButton));

    await waitFor(() => expect(sbMock.functions.invoke as unknown as Fn).toHaveBeenCalledTimes(1));
    expect((sbMock.functions.invoke as unknown as Fn).mock.calls[0][0]).toBe('create-measurement-order');
    expect((sbMock.functions.invoke as unknown as Fn).mock.calls[0][1]).toEqual({
      body: { claim_id: 'c1', product_code: 'roof_basic', payment_intent_id: 'pi_gh3858_1', buyer_role: 'homeowner' },
    });
    // gh-3859: the confirmation state, its strings from copy.ts (CHARGE_STEP_COPY_PENDING_GH3865).
    const confirmation = await screen.findByTestId('charge-confirmation');
    expect(confirmation.textContent).toContain(PENDING.confirmationHeading);
    expect(confirmation.textContent).toContain(PENDING.confirmationBody);
    expect(confirmCardPayment).toHaveBeenCalledTimes(1);
  });

  it('a declined card never records an order', async () => {
    (createHoverPaymentIntent as unknown as Fn).mockResolvedValue({ client_secret: 'pi_gh3858_2_secret_abc' });
    confirmCardPayment.mockResolvedValue({ error: { message: 'Your card was declined.' } });

    render(<HelpMeasurementsPage />);
    fireEvent.click(await screen.findByText(PENDING.startButton));
    await waitFor(() => expect(cardElement.mount).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText(M.hoverPayButton));

    expect(await screen.findByText('Your card was declined.')).toBeTruthy();
    expect(sbMock.functions.invoke as unknown as Fn).not.toHaveBeenCalled();
    expect(screen.queryByTestId('charge-confirmation')).toBeNull();
  });

  it('no PaymentIntent (placeholder / refusal) shows the existing init error and mounts no form', async () => {
    (createHoverPaymentIntent as unknown as Fn).mockResolvedValue({ client_secret: null, placeholder: true });

    render(<HelpMeasurementsPage />);
    fireEvent.click(await screen.findByText(PENDING.startButton));

    expect(await screen.findByText(M.statusPaymentInitError)).toBeTruthy();
    expect(screen.queryByTestId('hover-payment-form')).toBeNull();
  });
});
