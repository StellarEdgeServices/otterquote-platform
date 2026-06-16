'use client';

/**
 * Stripe payment-method manager — D-211 Phase 5 (port of the Multi-Payment Method
 * section of contractor-settings.html:1620-2124).
 *
 * Tier-3 surface, ported WITHOUT any Tier-3 change:
 *   - Loads Stripe.js from the CDN (https://js.stripe.com/v3/) exactly like the static
 *     page — NO new npm dependency, so the route stays additive.
 *   - Reads the Stripe PUBLISHABLE key from NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ONLY
 *     (the static page read CONFIG.STRIPE_PK). A secret key is NEVER referenced here.
 *     ⚠️ The Netlify `otterquote-app` site must define NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
 *     for the "add method" flow to work; until then the section degrades gracefully
 *     (saved methods stay visible + removable; the add buttons show an unavailable notice).
 *   - Calls the EXISTING create-setup-intent Edge Function with its contract UNCHANGED.
 *   - Reads/writes contractor_payment_methods + the legacy contractors columns via the
 *     existing client contracts UNCHANGED. All method values render as JSX text (no innerHTML).
 *
 * Pure logic (formatting, payload builders, removal planning) lives in ./utils and is
 * unit-tested; this component is the thin side-effectful shell.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { SETTINGS_COPY as T } from './copy';
import {
  type PaymentMethodRecord, type PaymentType,
  formatPaymentMethod, paymentMethodsBanner, isFirstMethod, buildSetupIntentBody,
  buildCardInsert, buildAchInsert, buildLegacyContractorUpdate, nextDefaultAfterRemoval,
  removalConfirmMessage, legacyBrandFor, stripePublishableKeyConfigured,
} from './utils';

// ── Minimal Stripe.js typings (no @stripe/* package on the client) ──
interface StripeElementLike {
  mount: (el: HTMLElement | string) => void;
  unmount: () => void;
  on: (event: string, cb: (e: { error?: { message?: string } }) => void) => void;
}
interface StripeElementsLike {
  create: (type: string, options?: unknown) => StripeElementLike;
}
interface SetupIntentLike { status?: string; payment_method?: string }
interface PaymentMethodLike {
  card?: { last4?: string; brand?: string };
  us_bank_account?: { last4?: string; bank_name?: string };
}
interface StripeLike {
  elements: () => StripeElementsLike;
  confirmCardSetup: (cs: string, data: unknown) => Promise<{ setupIntent?: SetupIntentLike; error?: { message?: string } }>;
  retrievePaymentMethod: (id: string) => Promise<{ paymentMethod?: PaymentMethodLike }>;
  collectBankAccountForSetup: (opts: unknown) => Promise<{ setupIntent?: SetupIntentLike; error?: { message?: string } }>;
  confirmUsBankAccountSetup: (cs: string) => Promise<{ setupIntent?: SetupIntentLike; error?: { message?: string } }>;
}

const STRIPE_PK = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
const STRIPE_JS_SRC = 'https://js.stripe.com/v3/';

function track(event: string, params: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  const g = (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag;
  if (typeof g === 'function') g('event', event, params);
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
  contractorId: string;
  billingName: string;
  billingEmail: string;
}

type FormMode = 'none' | 'card' | 'ach';

export function StripePaymentMethods({ contractorId, billingName, billingEmail }: Props) {
  const [methods, setMethods] = useState<PaymentMethodRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<FormMode>('none');
  const [busy, setBusy] = useState(false);
  const [cardError, setCardError] = useState('');
  const [achError, setAchError] = useState('');
  const [achNotice, setAchNotice] = useState('');

  const stripeRef = useRef<StripeLike | null>(null);
  const elementsRef = useRef<StripeElementsLike | null>(null);
  const cardElRef = useRef<StripeElementLike | null>(null);
  const cardMountRef = useRef<HTMLDivElement | null>(null);
  const clientSecretRef = useRef<string | null>(null);

  const configured = stripePublishableKeyConfigured(STRIPE_PK);

  const loadMethods = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('contractor_payment_methods')
        .select('*')
        .eq('contractor_id', contractorId)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: true });
      if (error) throw error;
      setMethods((data as PaymentMethodRecord[]) ?? []);
    } catch (err) {
      console.error('Failed to load payment methods:', err);
      setMethods([]);
    } finally {
      setLoading(false);
    }
  }, [contractorId]);

  useEffect(() => { loadMethods(); }, [loadMethods]);

  // Lazily construct the Stripe instance + Elements (mirrors initializeStripe).
  const ensureStripe = useCallback(async (): Promise<StripeLike | null> => {
    if (stripeRef.current) return stripeRef.current;
    if (!configured) return null;
    const factory = await loadStripeJs();
    if (!factory) return null;
    const stripe = factory(STRIPE_PK as string);
    stripeRef.current = stripe;
    elementsRef.current = stripe.elements();
    return stripe;
  }, [configured]);

  function resetForm() {
    setMode('none');
    setCardError('');
    setAchError('');
    setAchNotice('');
    clientSecretRef.current = null;
  }

  // ── create-setup-intent (EF contract UNCHANGED) ──
  async function createSetupIntent(paymentType: PaymentType): Promise<boolean> {
    const { data, error } = await supabase.functions.invoke('create-setup-intent', {
      body: buildSetupIntentBody(contractorId, paymentType),
    });
    if (error) throw new Error(error.message || 'Failed to create setup intent');
    if (!data || !data.client_secret) throw new Error('No client secret returned');
    clientSecretRef.current = data.client_secret as string;
    return true;
  }

  // ── Add card: show form, mount Element, prepare SetupIntent ──
  async function onAddCard() {
    setMode('card');
    setCardError('');
    setBusy(true);
    try {
      const stripe = await ensureStripe();
      if (!stripe || !elementsRef.current) throw new Error('Payment setup is unavailable.');
      if (!cardElRef.current) {
        const el = elementsRef.current.create('card', {
          style: { base: { fontSize: '14px', color: '#0D1B2E', fontFamily: 'Rubik, sans-serif', '::placeholder': { color: '#94A3B8' } }, invalid: { color: '#EF4444' } },
        });
        cardElRef.current = el;
        el.on('change', (e) => setCardError(e.error?.message ?? ''));
      }
      if (cardMountRef.current) cardElRef.current.mount(cardMountRef.current);
      await createSetupIntent('card');
    } catch (err) {
      setCardError('Setup error: ' + errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  // ── Confirm card SetupIntent → insert ──
  async function onSaveCard() {
    const stripe = stripeRef.current;
    const cs = clientSecretRef.current;
    if (!stripe || !cs || !cardElRef.current) { setCardError('Payment setup not initialized. Please try again.'); return; }
    setBusy(true);
    setCardError('');
    try {
      const { setupIntent, error } = await stripe.confirmCardSetup(cs, {
        payment_method: { card: cardElRef.current, billing_details: { name: billingName } },
      });
      if (error) throw new Error(error.message);
      if (!setupIntent || setupIntent.status !== 'succeeded') {
        throw new Error('Setup failed with status: ' + (setupIntent?.status || 'unknown'));
      }
      const pmId = setupIntent.payment_method as string;
      let last4 = '••••';
      let brand = 'CARD';
      try {
        const { paymentMethod } = await stripe.retrievePaymentMethod(pmId);
        if (paymentMethod?.card) { last4 = paymentMethod.card.last4 ?? last4; brand = (paymentMethod.card.brand ?? 'card').toUpperCase(); }
      } catch (e) { console.warn('Could not retrieve PM details:', e); }
      await persistNewMethod(buildCardInsert(contractorId, pmId, last4, brand, isFirstMethod(methods)), { id: '', payment_type: 'card', stripe_payment_method_id: pmId, last_four: last4, brand });
      track('payment_method_saved', { contractor_id: contractorId, payment_type: 'card', card_brand: brand });
    } catch (err) {
      setCardError('Error: ' + errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  // ── Add bank: prepare SetupIntent for ACH ──
  async function onAddBank() {
    setMode('ach');
    setAchError('');
    setAchNotice('');
    setBusy(true);
    try {
      const stripe = await ensureStripe();
      if (!stripe) throw new Error('Payment setup is unavailable.');
      await createSetupIntent('us_bank_account');
    } catch (err) {
      setAchError('Setup error: ' + errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  // ── Connect bank account (Financial Connections) → confirm → insert ──
  async function onConnectBank() {
    const stripe = stripeRef.current;
    const cs = clientSecretRef.current;
    if (!stripe || !cs) { setAchError('Payment setup not initialized. Please try again.'); return; }
    setBusy(true);
    setAchError('');
    setAchNotice('');
    try {
      const collected = await stripe.collectBankAccountForSetup({
        clientSecret: cs,
        params: {
          payment_method_type: 'us_bank_account',
          payment_method_data: { billing_details: { name: billingName, email: billingEmail } },
        },
      });
      if (collected.error) throw new Error(collected.error.message);
      const si = collected.setupIntent;
      if (si?.status === 'requires_confirmation') {
        const confirmed = await stripe.confirmUsBankAccountSetup(cs);
        if (confirmed.error) throw new Error(confirmed.error.message);
        const ci = confirmed.setupIntent;
        if (ci?.status === 'succeeded') {
          await saveAch(ci);
        } else if (ci?.status === 'requires_action') {
          setAchNotice(T.payment.microdepositNotice);
        } else {
          throw new Error('Bank account setup failed with status: ' + (ci?.status || 'unknown'));
        }
      } else if (si?.status === 'succeeded') {
        await saveAch(si);
      } else {
        throw new Error('Bank account connection failed. Status: ' + (si?.status || 'unknown'));
      }
    } catch (err) {
      setAchError('Error: ' + errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveAch(setupIntent: SetupIntentLike) {
    const stripe = stripeRef.current;
    const pmId = setupIntent.payment_method as string;
    let last4 = '••••';
    let bankName = 'Bank Account';
    try {
      const { paymentMethod } = (await stripe?.retrievePaymentMethod(pmId)) ?? {};
      if (paymentMethod?.us_bank_account) { last4 = paymentMethod.us_bank_account.last4 ?? last4; bankName = paymentMethod.us_bank_account.bank_name ?? bankName; }
    } catch (e) { console.warn('Could not retrieve ACH PM details:', e); }
    await persistNewMethod(buildAchInsert(contractorId, pmId, last4, bankName, isFirstMethod(methods)), { id: '', payment_type: 'us_bank_account', stripe_payment_method_id: pmId, last_four: last4, bank_name: bankName });
    track('payment_method_saved', { contractor_id: contractorId, payment_type: 'us_bank_account', bank_name: bankName });
  }

  // Insert the method, sync the legacy contractors fields when it's the first method, reload.
  async function persistNewMethod(insert: Record<string, unknown>, legacyRef: PaymentMethodRecord) {
    const { error: insertError } = await supabase.from('contractor_payment_methods').insert(insert);
    if (insertError) throw insertError;
    if (isFirstMethod(methods)) {
      await supabase.from('contractors').update(buildLegacyContractorUpdate(legacyRef, new Date().toISOString())).eq('id', contractorId);
    }
    resetForm();
    await loadMethods();
  }

  // ── Set default ──
  async function onSetDefault(methodId: string) {
    try {
      await supabase.from('contractor_payment_methods').update({ is_default: false }).eq('contractor_id', contractorId);
      await supabase.from('contractor_payment_methods').update({ is_default: true }).eq('id', methodId);
      const method = methods.find((m) => m.id === methodId);
      if (method) {
        await supabase.from('contractors').update(buildLegacyContractorUpdate(method, new Date().toISOString())).eq('id', contractorId);
      }
      await loadMethods();
    } catch (err) {
      console.error('Failed to set default:', err);
      alert(T.payment.saveErrorDefault);
    }
  }

  // ── Remove ──
  async function onRemove(methodId: string) {
    const method = methods.find((m) => m.id === methodId);
    if (!method) return;
    const confirmMsg = removalConfirmMessage(methods, method);
    if (confirmMsg && !confirm(confirmMsg)) return;
    try {
      await supabase.from('contractor_payment_methods').delete().eq('id', methodId);
      const plan = nextDefaultAfterRemoval(methods, methodId);
      if (plan.promote) {
        await supabase.from('contractor_payment_methods').update({ is_default: true }).eq('id', plan.promote.id);
        await supabase.from('contractors').update(buildLegacyContractorUpdate(plan.promote, new Date().toISOString())).eq('id', contractorId);
      } else if (plan.clearLegacy) {
        await supabase.from('contractors').update(buildLegacyContractorUpdate(null, new Date().toISOString())).eq('id', contractorId);
      }
      await loadMethods();
      track('payment_method_removed', { contractor_id: contractorId, payment_type: method.payment_type });
    } catch (err) {
      console.error('Failed to remove payment method:', err);
      alert(T.payment.saveErrorRemove);
    }
  }

  const banner = paymentMethodsBanner(methods);

  return (
    <section className="oqs-card">
      <h2 className="oqs-card-title">{T.payment.title}</h2>
      <p className="oqs-card-sub">{T.payment.subtitle}</p>

      {loading ? (
        <p className="oqs-muted">Loading payment methods…</p>
      ) : (
        <>
          {banner === 'none' && (
            <div className="oqs-pm-amber">
              <div className="oqs-pm-amber-title">{T.payment.noPaymentTitle}</div>
              <p>{T.payment.noPaymentBody}</p>
            </div>
          )}

          {methods.length > 0 && (
            <div className="oqs-pm-list">
              {methods.map((m) => {
                const d = formatPaymentMethod(m);
                return (
                  <div key={m.id} className={'oqs-pm-row' + (d.isDefault ? ' is-default' : '')}>
                    <div className="oqs-pm-info">
                      <span className="oqs-pm-icon" aria-hidden="true">{d.icon}</span>
                      <div>
                        <div className="oqs-pm-label">
                          {d.typeLabel} {d.last4Display}
                          {d.isDefault && <span className="oqs-pm-badge-default">{T.payment.defaultBadge}</span>}
                          <span className={d.fee === 'card' ? 'oqs-pm-badge-fee' : 'oqs-pm-badge-free'}>
                            {d.fee === 'card' ? T.payment.feeBadgeCard : T.payment.feeBadgeBank}
                          </span>
                        </div>
                        {m.created_at && (
                          <div className="oqs-pm-added">{T.payment.addedPrefix}{new Date(m.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                        )}
                      </div>
                    </div>
                    <div className="oqs-pm-actions">
                      {!d.isDefault && <button type="button" className="oqs-link" onClick={() => onSetDefault(m.id)}>{T.payment.setDefault}</button>}
                      <button type="button" className="oqs-link oqs-link-danger" onClick={() => onRemove(m.id)}>{T.payment.remove}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {banner === 'encourage' && (
            <div className="oqs-pm-encourage">
              <div className="oqs-pm-encourage-title">{T.payment.encourageTitle}</div>
              {T.payment.encourageBody.map((p, i) => <p key={i}>{p}</p>)}
              <button type="button" className="oqs-btn oqs-btn-navy" disabled={!configured} onClick={onAddBank}>{T.payment.encourageBtn}</button>
            </div>
          )}

          {banner === 'success' && (
            <div className="oqs-pm-success"><strong>{T.payment.successText}</strong></div>
          )}

          {!configured && (
            <div className="oqs-pm-amber"><p>{T.payment.unavailable}</p></div>
          )}

          {mode === 'none' && (
            <>
              <div className="oqs-pm-add-buttons">
                <button type="button" className="oqs-btn oqs-btn-primary oqs-pm-add" disabled={!configured} onClick={onAddBank}>
                  {T.payment.addBank}<span className="oqs-pm-add-sub">{T.payment.addBankSub}</span>
                </button>
                <button type="button" className="oqs-btn oqs-btn-secondary oqs-pm-add" disabled={!configured} onClick={onAddCard}>
                  {T.payment.addCard}<span className="oqs-pm-add-sub">{T.payment.addCardSub}</span>
                </button>
              </div>
              <p className="oqs-pm-feenote">{T.payment.feeNote}</p>
            </>
          )}

          {mode === 'card' && (
            <div className="oqs-pm-form">
              <div className="oqs-pm-form-title">{T.payment.cardFormTitle}</div>
              <div ref={cardMountRef} className="oqs-pm-card-element" />
              {cardError && <div className="oqs-pm-error">{cardError}</div>}
              <div className="oqs-actions">
                <button type="button" className="oqs-btn oqs-btn-primary" disabled={busy} onClick={onSaveCard}>{busy ? '…' : T.payment.saveCard}</button>
                <button type="button" className="oqs-btn oqs-btn-secondary" disabled={busy} onClick={resetForm}>{T.payment.cancel}</button>
              </div>
            </div>
          )}

          {mode === 'ach' && (
            <div className="oqs-pm-form oqs-pm-form-ach">
              <div className="oqs-pm-form-title">{T.payment.achFormTitle}</div>
              <p className="oqs-pm-ach-body">{T.payment.achFormBody}</p>
              {achError && <div className="oqs-pm-error">{achError}</div>}
              {achNotice && <div className="oqs-pm-notice">{achNotice}</div>}
              <div className="oqs-actions">
                <button type="button" className="oqs-btn oqs-btn-green" disabled={busy} onClick={onConnectBank}>{busy ? '…' : T.payment.connectBank}</button>
                <button type="button" className="oqs-btn oqs-btn-secondary" disabled={busy} onClick={resetForm}>{T.payment.cancel}</button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
