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
import { MEASUREMENTS_COPY as M, CHARGE_STEP_COPY_PENDING_GH3865 as PENDING, MEASUREMENT_REFUSAL_COPY } from '../copy';
import HelpMeasurementsPage, { HOVER_RETIRED_COPY, RESUME_COPY } from '../page';
import { isMeasurementChargeEnabled } from '@/lib/measurement-charge-flag';
import { clearHoverChargeRecord, saveHoverChargeRecord, readHoverChargeRecord } from '../hover-charge-storage';
import { ORDER_RETRY_COPY } from '../HoverPaymentForm';

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

// ── RETURNED / FIX (review of #3872 / #3873): flag-ON defects ─────────────────────────────────────────────────────────────
describe('flag ON: reload resume, path switching, refusals, revisit, order-write failure', () => {
  const invoke = () => sbMock.functions.invoke as unknown as Fn;
  const readyWith = (over: Record<string, unknown> = {}) => ({
    claim: { id: 'c1', property_address: '123 Oak St', claim_number: 'CLM-1', adjuster_name: null, adjuster_email: null, adjuster_phone: null },
    profile: { full_name: 'Jane Roof', phone: '(317) 555-1234' },
    alreadySentBoth: false,
    existingOrder: false,
    loading: false,
    error: null,
    ...over,
  });
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_MEASUREMENT_CHARGE_ENABLED', 'true');
  });

  it('1. a reload with a saved PaymentIntent finishes the order write instead of offering a fresh charge', async () => {
    saveHoverChargeRecord({ claimId: 'c1', paymentIntentId: 'pi_saved_1', ts: Date.now() });
    invoke().mockResolvedValue({ data: { order_id: 'o1' }, error: null });

    render(<HelpMeasurementsPage />);

    expect(await screen.findByTestId('charge-confirmation')).toBeTruthy();
    expect(invoke()).toHaveBeenCalledTimes(1);
    expect(invoke().mock.calls[0][0]).toBe('create-measurement-order');
    expect(invoke().mock.calls[0][1].body).toMatchObject({ claim_id: 'c1', payment_intent_id: 'pi_saved_1' });
    expect(screen.queryByText(PENDING.startButton)).toBeNull();
    expect(screen.queryByText(RESUME_COPY.unresolved)).toBeNull();
    expect(createHoverPaymentIntent as unknown as Fn).not.toHaveBeenCalled();
    expect(readHoverChargeRecord()).toBeNull();
  });

  it('1b. a saved id the server will not record (never charged) shows the existing contact-support text and clears the pointer', async () => {
    saveHoverChargeRecord({ claimId: 'c1', paymentIntentId: 'pi_unpaid', ts: Date.now() });
    invoke().mockResolvedValue({ data: null, error: { context: { status: 402, json: async () => ({ error: 'not paid' }) } } });

    render(<HelpMeasurementsPage />);

    expect(await screen.findByText(RESUME_COPY.unresolved)).toBeTruthy();
    expect(screen.queryByTestId('charge-confirmation')).toBeNull();
    expect(readHoverChargeRecord()).toBeNull();
  });

  it('1c. a pointer for a different claim is not resumed', async () => {
    saveHoverChargeRecord({ claimId: 'other', paymentIntentId: 'pi_other', ts: Date.now() });
    render(<HelpMeasurementsPage />);
    expect(await screen.findByText(PENDING.startButton)).toBeTruthy();
    expect(invoke()).not.toHaveBeenCalled();
  });

  it('2 and 5. while the card form is up the path cards are gone; a charged state with a failed order write shows Retry Order, no confirmation, no way to click away', async () => {
    (createHoverPaymentIntent as unknown as Fn).mockResolvedValue({ client_secret: 'pi_gh3858_3_secret_abc' });
    confirmCardPayment.mockResolvedValue({ paymentIntent: { id: 'pi_gh3858_3', status: 'succeeded' } });
    invoke().mockResolvedValue({ data: null, error: { context: { json: async () => ({ error: 'order write failed' }) } } });

    render(<HelpMeasurementsPage />);
    expect((await screen.findAllByText(M.cardSelectButton)).length).toBe(1); // before the charge starts the adjuster card is offered
    fireEvent.click(await screen.findByText(PENDING.startButton));
    await screen.findByTestId('hover-payment-form', {}, { timeout: 5000 });
    expect(screen.queryAllByText(M.cardSelectButton)).toHaveLength(0);

    await waitFor(() => expect(cardElement.mount).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText(M.hoverPayButton));
    expect(await screen.findByText(ORDER_RETRY_COPY.retryButton, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryAllByText(M.cardSelectButton)).toHaveLength(0);
    expect(screen.queryByText(PENDING.startButton)).toBeNull();
    expect(screen.queryByTestId('charge-confirmation')).toBeNull();
  });

  it.each([
    ['MEASUREMENT_ALREADY_PAID', MEASUREMENT_REFUSAL_COPY.alreadyPaid],
    ['MEASUREMENT_PAYMENT_CANNOT_START', MEASUREMENT_REFUSAL_COPY.cannotStart],
    ['MEASUREMENT_PAYMENT_CHECK_UNAVAILABLE', MEASUREMENT_REFUSAL_COPY.checkUnavailable],
  ])('3. refusal %s shows its own sentence, not the generic init error, and mounts no form', async (code, text) => {
    (createHoverPaymentIntent as unknown as Fn).mockResolvedValue({ client_secret: null, refused: true, code });
    render(<HelpMeasurementsPage />);
    fireEvent.click(await screen.findByText(PENDING.startButton));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByText(M.statusPaymentInitError)).toBeNull();
    expect(screen.queryByTestId('hover-payment-form')).toBeNull();
    // ALREADY_PAID retires the start button (static page parity); the other two keep it for a retry.
    expect(!!screen.queryByText(PENDING.startButton)).toBe(code !== 'MEASUREMENT_ALREADY_PAID');
  });

  it('4. a claim that already has a paid order shows the confirmation and no start button', async () => {
    (useHelpMeasurementsData as unknown as Fn).mockReturnValue(readyWith({ existingOrder: true }));
    saveHoverChargeRecord({ claimId: 'c1', paymentIntentId: 'pi_old', ts: Date.now() });
    render(<HelpMeasurementsPage />);
    expect(await screen.findByTestId('charge-confirmation')).toBeTruthy();
    expect(screen.queryByText(PENDING.startButton)).toBeNull();
    expect(invoke()).not.toHaveBeenCalled();
    expect(createHoverPaymentIntent as unknown as Fn).not.toHaveBeenCalled();
    expect(readHoverChargeRecord()).toBeNull();
  });
});

// ── RETURNED / FIX 2 (second review round) ────────────────────────────────────────────────────────────────────────────────
describe('flag ON, round 2: recorded state survives path switches; resume keeps the id unless the server is definite; lock is same-render', () => {
  const invoke = () => sbMock.functions.invoke as unknown as Fn;
  const failure = (status: number, body: Record<string, unknown>) => ({
    data: null,
    error: { context: { status, json: async () => body } },
  });
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_MEASUREMENT_CHARGE_ENABLED', 'true');
  });

  it('R2-1. pay, record, choose the adjuster path, come back: no enabled start button, the recorded state is still shown', async () => {
    (createHoverPaymentIntent as unknown as Fn).mockResolvedValue({ client_secret: 'pi_r2_1_secret_abc' });
    confirmCardPayment.mockResolvedValue({ paymentIntent: { id: 'pi_r2_1', status: 'succeeded' } });
    invoke().mockResolvedValue({ data: { order_id: 'o1' }, error: null });

    render(<HelpMeasurementsPage />);
    fireEvent.click(await screen.findByText(PENDING.startButton));
    await waitFor(() => expect(cardElement.mount).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText(M.hoverPayButton));
    expect(await screen.findByTestId('charge-step-recorded')).toBeTruthy();

    // After recording the path cards are back: choose the adjuster path, then come back.
    fireEvent.click(screen.getAllByText(M.cardSelectButton)[0]);
    fireEvent.click(await screen.findByText(M.chooseDifferentButton));

    expect(await screen.findByTestId('charge-step-recorded')).toBeTruthy();
    expect(screen.queryByText(PENDING.startButton)).toBeNull();
  });

  it('R2-2a. resume where the order write says payment_captured: the id is KEPT, Retry Order is shown, no start button; Retry then records', async () => {
    saveHoverChargeRecord({ claimId: 'c1', paymentIntentId: 'pi_cap_1', ts: Date.now() });
    invoke().mockResolvedValueOnce(failure(500, { error: 'Your payment went through, but we could not record the order.', payment_captured: true }));

    render(<HelpMeasurementsPage />);

    expect(await screen.findByText(ORDER_RETRY_COPY.retryButton)).toBeTruthy();
    expect(readHoverChargeRecord()?.paymentIntentId).toBe('pi_cap_1');
    expect(screen.queryByText(PENDING.startButton)).toBeNull();
    expect(screen.queryAllByText(M.cardSelectButton)).toHaveLength(0);

    invoke().mockResolvedValueOnce({ data: { order_id: 'o1' }, error: null });
    fireEvent.click(screen.getByText(ORDER_RETRY_COPY.retryButton));
    expect(await screen.findByTestId('charge-step-recorded')).toBeTruthy();
    expect(invoke().mock.calls[1][1].body.payment_intent_id).toBe('pi_cap_1');
    expect(readHoverChargeRecord()).toBeNull();
  });

  it('R2-2b. resume where the call throws (network): the id is KEPT, Retry Order is shown, no start button', async () => {
    saveHoverChargeRecord({ claimId: 'c1', paymentIntentId: 'pi_net_1', ts: Date.now() });
    invoke().mockRejectedValue(new Error('Failed to fetch'));

    render(<HelpMeasurementsPage />);

    expect(await screen.findByText(ORDER_RETRY_COPY.retryButton)).toBeTruthy();
    expect(readHoverChargeRecord()?.paymentIntentId).toBe('pi_net_1');
    expect(screen.queryByText(PENDING.startButton)).toBeNull();
  });

  it('R2-2c. a transient 402 ("could not verify your payment") keeps the id; a definite 402 clears it and offers a fresh start as before', async () => {
    saveHoverChargeRecord({ claimId: 'c1', paymentIntentId: 'pi_t_1', ts: Date.now() });
    invoke().mockResolvedValueOnce(failure(402, { error: 'We could not verify your payment. Please try again or contact support.' }));
    const first = render(<HelpMeasurementsPage />);
    expect(await screen.findByText(ORDER_RETRY_COPY.retryButton)).toBeTruthy();
    expect(readHoverChargeRecord()?.paymentIntentId).toBe('pi_t_1');
    first.unmount();

    invoke().mockResolvedValueOnce(failure(402, { error: 'Payment must complete before we can order your report. Current payment status: requires_payment_method.' }));
    render(<HelpMeasurementsPage />);
    expect(await screen.findByText(RESUME_COPY.unresolved)).toBeTruthy();
    expect(readHoverChargeRecord()).toBeNull();
    expect(await screen.findByText(PENDING.startButton)).toBeTruthy();
  });

  it('R2-3. the path-card lock and the card form appear in the same commit (never both on screen)', async () => {
    (createHoverPaymentIntent as unknown as Fn).mockResolvedValue({ client_secret: 'pi_r2_3_secret_abc' });
    const { container } = render(<HelpMeasurementsPage />);
    const both: string[] = [];
    const observer = new MutationObserver(() => {
      if (container.querySelector('[data-testid="hover-payment-form"]') && container.querySelector('.hm-path-cards')) both.push('both visible');
    });
    observer.observe(container, { childList: true, subtree: true });
    fireEvent.click(await screen.findByText(PENDING.startButton));
    await screen.findByTestId('hover-payment-form', {}, { timeout: 5000 });
    // Synchronous, right after the form appeared: the path cards are already gone.
    expect(container.querySelector('.hm-path-cards')).toBeNull();
    observer.disconnect();
    expect(both).toEqual([]);
  });

  it('R2-4. while the PaymentIntent request is in flight the path cards are hidden, so no unpaid pointer is left by switching away', async () => {
    let release: (v: unknown) => void = () => {};
    (createHoverPaymentIntent as unknown as Fn).mockReturnValue(new Promise((r) => { release = r; }));
    render(<HelpMeasurementsPage />);
    fireEvent.click(await screen.findByText(PENDING.startButton));
    await waitFor(() => expect(createHoverPaymentIntent as unknown as Fn).toHaveBeenCalledTimes(1));
    expect(screen.queryAllByText(M.cardSelectButton)).toHaveLength(0);
    expect((screen.getByText(PENDING.startButton) as HTMLButtonElement).disabled).toBe(true);
    release({ client_secret: 'pi_r2_4_secret_abc' });
    await screen.findByTestId('hover-payment-form');
  });
});
