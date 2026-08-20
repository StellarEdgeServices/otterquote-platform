'use client';

/**
 * Hover $15 card form (D-291, repricing D-205's now-superseded $150) — D-211 Phase 28,
 * PR 2/2 (Tier-3 surface, NO Tier-3 change).
 *
 * Mounts a Stripe Card Element and confirms the $15 PaymentIntent the parent already
 * created. Mirrors the static help-measurements.html card form (649-659 markup +
 * confirmHoverPayment 939-1002) and the contractor-settings Stripe idiom
 * (StripePaymentMethods.tsx) — but uses confirmCardPayment, not confirmCardSetup.
 *
 * Client-bundle boundary (payment page): the ONLY Stripe key referenced here is the
 * PUBLISHABLE key (NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY). The secret key NEVER appears in
 * this module. Stripe.js loads from the CDN (no @stripe/* npm dependency). When the
 * publishable key is unconfigured the form degrades gracefully (notice + Cancel only),
 * mirroring StripePaymentMethods' `configured` handling.
 *
 * Money rule preserved: the card is charged here; the parent creates the Hover ORDER
 * only after paymentIntent.status === 'succeeded'. A decline/error surfaces inline and
 * does NOT advance the flow.
 *
 * Post-charge retry-safety (gh-416): once confirmCardPayment succeeds, the paymentIntent
 * id is recorded in state and the Pay/Cancel controls are permanently retired for this
 * mount. If the parent's ORDER step then throws, the form parks in an 'orderFailed'
 * state whose only affordance is "Retry Order" — it re-runs the order step with the SAME
 * recorded paymentIntent id and never re-confirms the card. Pay re-arms ONLY when the
 * charge itself failed (decline / unexpected status / confirm threw), where no successful
 * charge was observed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MEASUREMENTS_COPY as M } from './copy';

// ── Minimal Stripe.js typings (no @stripe/* package on the client) ──
interface StripeElementLike {
  mount: (el: HTMLElement | string) => void;
  unmount: () => void;
  clear: () => void;
  on: (event: string, cb: (e: { error?: { message?: string } }) => void) => void;
}
interface StripeElementsLike {
  create: (type: string, options?: unknown) => StripeElementLike;
}
interface PaymentIntentLike {
  id: string;
  status?: string;
}
interface StripeLike {
  elements: () => StripeElementsLike;
  confirmCardPayment: (
    clientSecret: string,
    data: unknown,
  ) => Promise<{ paymentIntent?: PaymentIntentLike; error?: { message?: string } }>;
}

const STRIPE_PK = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
const STRIPE_JS_SRC = 'https://js.stripe.com/v3/';

/**
 * Whether the Stripe PUBLISHABLE key is configured. The page calls this BEFORE creating
 * the PaymentIntent, mirroring the static initHoverStripe() guard (throws without a key).
 * Centralizes the only client-side Stripe key reference in this module.
 */
export function isStripeConfigured(): boolean {
  return !!STRIPE_PK;
}

/** Inject the Stripe.js CDN script once and resolve the global Stripe factory. */
function loadStripeJs(): Promise<((key: string) => StripeLike) | null> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve(null);
    const w = window as unknown as { Stripe?: (key: string) => StripeLike };
    if (w.Stripe) return resolve(w.Stripe);
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${STRIPE_JS_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(w.Stripe ?? null), { once: true });
      existing.addEventListener('error', () => resolve(null), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = STRIPE_JS_SRC;
    s.async = true;
    s.onload = () => resolve(w.Stripe ?? null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
}

interface Props {
  /** The client_secret of the PaymentIntent the parent created (BEFORE this form mounts). */
  clientSecret: string;
  /** Called with paymentIntent.id once the card payment succeeds. */
  onPaid: (paymentIntentId: string) => void | Promise<void>;
  /** Called when the user cancels the card form. */
  onCancel: () => void;
}

type PayState = 'idle' | 'processing' | 'ordering' | 'orderFailed';

/**
 * NEW operational copy for the gh-416 post-charge order-failure state. NOT part of the
 * static verbatim port (the static page never rendered this state distinctly — it
 * re-armed Pay, the double-charge defect this fixes), so these strings live here and
 * deliberately stay OUT of the verbatim-locked ./copy.ts.
 */
export const ORDER_RETRY_COPY = {
  paidNoRecharge:
    'Your $15 payment went through and is confirmed. We could not start your Hover order — use Retry Order below. Retrying will not charge your card again.',
  retryButton: 'Retry Order',
  orderFailedFallback: 'Could not create your Hover order. Please retry.',
  supportNote:
    'If retrying does not work, contact support — your payment is confirmed and will be applied to your order.',
} as const;

export function HoverPaymentForm({ clientSecret, onPaid, onCancel }: Props) {
  const configured = !!STRIPE_PK;

  const stripeRef = useRef<StripeLike | null>(null);
  const cardElRef = useRef<StripeElementLike | null>(null);
  const cardMountRef = useRef<HTMLDivElement | null>(null);

  const [cardError, setCardError] = useState('');
  const [payState, setPayState] = useState<PayState>('idle');
  /**
   * The id of the SUCCESSFULLY CHARGED PaymentIntent (gh-416). Set exactly once, the
   * moment confirmCardPayment reports status === 'succeeded', BEFORE the order step
   * runs. Non-null ⇒ the card has been charged ⇒ the Pay/Cancel controls are retired
   * and only the order step may run (again).
   */
  const [paidIntentId, setPaidIntentId] = useState<string | null>(null);
  const [orderError, setOrderError] = useState('');

  // Mount the Card Element once Stripe.js is ready (static purchaseHover 909-924).
  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    (async () => {
      const factory = await loadStripeJs();
      if (cancelled || !factory) {
        if (!cancelled && !factory) setCardError(M.statusPaymentInitError);
        return;
      }
      const stripe = factory(STRIPE_PK as string);
      stripeRef.current = stripe;
      const card = stripe.elements().create('card', {
        style: {
          base: {
            fontSize: '15px',
            color: '#0D1B2E',
            fontFamily: 'Rubik, sans-serif',
            '::placeholder': { color: '#94A3B8' },
          },
          invalid: { color: '#EF4444' },
        },
      });
      cardElRef.current = card;
      if (cardMountRef.current) card.mount(cardMountRef.current);
      card.on('change', (e) => setCardError(e.error?.message ?? ''));
    })();
    return () => {
      cancelled = true;
      cardElRef.current?.unmount();
      cardElRef.current = null;
    };
  }, [configured]);

  // Run the ORDER step only (gh-416). Retry-safe: a throw parks the form in
  // 'orderFailed' with a Retry-Order affordance reusing the SAME paymentIntent id —
  // it never falls back to 'idle', which would re-arm Pay after a successful charge.
  const runOrder = useCallback(
    async (paymentIntentId: string) => {
      setPayState('ordering');
      setOrderError('');
      try {
        await onPaid(paymentIntentId);
      } catch (err) {
        setOrderError(
          err instanceof Error && err.message ? err.message : ORDER_RETRY_COPY.orderFailedFallback,
        );
        setPayState('orderFailed');
      }
    },
    [onPaid],
  );

  // Confirm the card payment, then hand paymentIntent.id to the parent for the order.
  // Retry-safety (gh-416): once a charge has succeeded (paidIntentId set), this NEVER
  // calls confirmCardPayment again — only the order step may run again.
  const onPay = useCallback(async () => {
    if (paidIntentId) {
      // Defensive: the card is already charged — route any invocation to the order step.
      await runOrder(paidIntentId);
      return;
    }
    const stripe = stripeRef.current;
    const card = cardElRef.current;
    if (!stripe || !card) {
      setCardError(M.statusPaymentInitError);
      return;
    }
    setPayState('processing');
    setCardError('');
    let chargedIntentId: string;
    try {
      const { paymentIntent, error } = await stripe.confirmCardPayment(clientSecret, {
        payment_method: { card },
      });

      if (error) {
        // Stripe declined or card error — surface, do NOT create the order. No charge
        // happened, so re-arming Pay is legitimate.
        setCardError(error.message ?? 'Payment failed. Please try again.');
        setPayState('idle');
        return;
      }
      if (!paymentIntent || paymentIntent.status !== 'succeeded') {
        setCardError(
          `Unexpected payment status: ${paymentIntent?.status ?? 'unknown'}. Please contact support.`,
        );
        setPayState('idle');
        return;
      }
      chargedIntentId = paymentIntent.id;
    } catch (err) {
      // The CONFIRM step itself threw — no successful charge was observed, so re-arming
      // Pay is legitimate (re-confirming the same PaymentIntent cannot double-charge).
      setCardError(err instanceof Error ? err.message : 'Payment failed. Please try again.');
      setPayState('idle');
      return;
    }

    // Charge succeeded — record the paymentIntent id BEFORE the order step so no code
    // path (including an order throw) can re-arm the Pay button (gh-416 guard), then
    // hand off to the parent to create the Hover order.
    setPaidIntentId(chargedIntentId);
    await runOrder(chargedIntentId);
  }, [clientSecret, paidIntentId, runOrder]);

  if (!configured) {
    return (
      <div className="hm-payform">
        <div className="hm-status error" role="alert">
          {M.statusPaymentInitError}
        </div>
        <div className="hm-btn-row">
          <button type="button" className="hm-btn hm-btn-outline" onClick={onCancel}>
            {M.hoverCancelButton}
          </button>
        </div>
      </div>
    );
  }

  // Once the charge has succeeded the card form + Pay/Cancel controls are permanently
  // retired for this mount (gh-416): Cancel would path back to a fresh PaymentIntent
  // (a second charge) and Pay must never re-confirm. Only order-step UI renders.
  const charged = paidIntentId !== null;
  const busy = payState !== 'idle';
  const payLabel = payState === 'processing' ? M.payProcessingButton : M.hoverPayButton;

  if (charged) {
    return (
      <div className="hm-payform">
        {payState === 'orderFailed' ? (
          <>
            <div className="hm-status error" role="alert">
              {orderError || ORDER_RETRY_COPY.orderFailedFallback}
            </div>
            <p className="hm-payform-lead">{ORDER_RETRY_COPY.paidNoRecharge}</p>
            <div className="hm-btn-row">
              <button
                type="button"
                className="hm-btn hm-btn-green"
                onClick={() => void runOrder(paidIntentId)}
              >
                {ORDER_RETRY_COPY.retryButton}
              </button>
            </div>
            <p className="hm-stripe-note">{ORDER_RETRY_COPY.supportNote}</p>
          </>
        ) : (
          <p className="hm-payform-lead" role="status">
            <span className="hm-spinner" aria-hidden="true" /> {M.payOrderingButton}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="hm-payform">
      <p className="hm-payform-lead">{M.hoverCardFormLead}</p>
      <div ref={cardMountRef} className="hm-card-element" />
      <div className="hm-card-errors" role="alert">
        {cardError}
      </div>
      <div className="hm-btn-row">
        <button
          type="button"
          className="hm-btn hm-btn-green"
          disabled={busy}
          onClick={() => void onPay()}
        >
          {busy && <span className="hm-spinner" aria-hidden="true" />} {payLabel}
        </button>
        <button
          type="button"
          className="hm-btn hm-btn-outline"
          disabled={busy}
          onClick={onCancel}
        >
          {M.hoverCancelButton}
        </button>
      </div>
      <p className="hm-stripe-note">{M.stripeSecurityLine}</p>
    </div>
  );
}
