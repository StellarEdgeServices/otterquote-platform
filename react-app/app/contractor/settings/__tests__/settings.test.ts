/**
 * Unit + parity tests for the contractor Settings page (D-211 Phase 5).
 * Exercises the ported pure logic against contractor-settings.html @ main: notification
 * serialization, payment-method formatting + payload builders + removal planning, the
 * IC 24-5-11 attestation payload (+ verbatim legal copy), COI banner state + update
 * payloads (+ verbatim copy), and the feature-request insert. Plus a gating-parity section
 * pinning the CPA-only gate (the static settings page has NO pending-approval gate) and a
 * Stripe-key guard pinning publishable-only. Network/storage/EF/Stripe.js calls live in the
 * page + components, not here.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  NOTIFICATION_TYPES, getNotificationEmails, getNotificationPhones, resolveNotificationPrefs,
  buildSettingsPayload, formatPaymentMethod, paymentMethodsBanner, isFirstMethod, buildSetupIntentBody,
  buildCardInsert, buildAchInsert, buildLegacyContractorUpdate, legacyBrandFor, nextDefaultAfterRemoval,
  removalConfirmMessage, billingName, stripePublishableKeyConfigured, ATTESTATION_TEXT_VERSION,
  shouldShowAttestationCard, validateAttestation, buildAttestationPayload, buildAttestationContractorUpdate,
  validateCoi, coiNeedsFile, coiFilePath, buildCoiUpdate, coiBannerState, validateFeatureRequest,
  buildFeatureRequestInsert, type PaymentMethodRecord, type SettingsFormState,
} from '../utils';
import { SETTINGS_COPY } from '../copy';
import { enforceCpaRedirect, CURRENT_CPA_VERSION } from '../../_shell/cpa-guard';
import { isPendingApproval } from '../../_shell/contractor-gating';

describe('notification preferences', () => {
  it('catalog: 9 types in order, 2 disabled Coming-Soon, defaults match the static checked attrs', () => {
    expect(NOTIFICATION_TYPES.length).toBe(9);
    expect(NOTIFICATION_TYPES.map((t) => t.prefKey)).toEqual([
      'new_opportunity', 'bid_accepted', 'contract_signed', 'color_complete', 'deductible_collected',
      'reminder_48h', 'auto_bid_placed', 'bid_expired', 'bid_renewal_requested',
    ]);
    expect(NOTIFICATION_TYPES.filter((t) => t.disabled).map((t) => t.prefKey)).toEqual(['color_complete', 'deductible_collected']);
    expect(NOTIFICATION_TYPES.find((t) => t.prefKey === 'color_complete')!.defaultOn).toBe(false);
    expect(NOTIFICATION_TYPES.find((t) => t.prefKey === 'new_opportunity')!.defaultOn).toBe(true);
  });

  it('emails/phones: fall back to [email]/[phone] then drop blanks', () => {
    expect(getNotificationEmails({ notification_emails: ['a@x.com', '  ', 'b@x.com'] })).toEqual(['a@x.com', 'b@x.com']);
    expect(getNotificationEmails({ email: 'solo@x.com' })).toEqual(['solo@x.com']);
    expect(getNotificationEmails({ email: null })).toEqual([]);
    expect(getNotificationPhones({ notification_phones: ['317', ''] })).toEqual(['317']);
    expect(getNotificationPhones({ phone: '(317) 530-3054' })).toEqual(['(317) 530-3054']);
  });

  it('resolveNotificationPrefs: defaults, then override only present keys', () => {
    const def = resolveNotificationPrefs(null);
    expect(def.new_opportunity).toBe(true);
    expect(def.color_complete).toBe(false);
    const over = resolveNotificationPrefs({ notification_preferences: { new_opportunity: false, color_complete: true } });
    expect(over.new_opportunity).toBe(false);
    expect(over.color_complete).toBe(true);
    expect(over.bid_accepted).toBe(true); // untouched default
  });

  it('buildSettingsPayload: persists the bundle, gates guarantee on the toggle, excludes auto_bid_*', () => {
    const form: SettingsFormState = {
      emails: ['a@x.com', ' '], phones: ['317'], notifPrefs: { new_opportunity: false },
      repairsAccepted: false, guaranteeChecked: true, autoRenewBids: false, publicDirectoryOptin: true,
    };
    const p = buildSettingsPayload(form, 'ISO');
    expect(p.notification_emails).toEqual(['a@x.com']);
    expect(p.guarantee_accepted).toBe(false); // repairs off -> guarantee can't be accepted
    expect(p.auto_renew_bids).toBe(false);
    expect(p.public_directory_optin).toBe(true);
    expect(p.updated_at).toBe('ISO');
    expect(Object.keys(p.notification_preferences as object).length).toBe(9);
    expect((p.notification_preferences as Record<string, boolean>).new_opportunity).toBe(false);
    expect('auto_bid_enabled' in p).toBe(false);
    expect('auto_bid_value_adds' in p).toBe(false);
  });
});

describe('payment methods', () => {
  const card: PaymentMethodRecord = { id: 'm1', payment_type: 'card', brand: 'visa', last_four: '4242', is_default: true, stripe_payment_method_id: 'pm_1', created_at: '2026-06-01' };
  const bank: PaymentMethodRecord = { id: 'm2', payment_type: 'us_bank_account', bank_name: 'Chase', last_four: '6789', is_default: false, stripe_payment_method_id: 'pm_2' };

  it('formatPaymentMethod: card vs bank icon/label/fee', () => {
    expect(formatPaymentMethod(card)).toMatchObject({ isCard: true, icon: '💳', typeLabel: 'VISA', last4Display: '•••• 4242', fee: 'card', isDefault: true });
    expect(formatPaymentMethod(bank)).toMatchObject({ isCard: false, icon: '🏦', typeLabel: 'Chase', last4Display: '•••• 6789', fee: 'bank', isDefault: false });
    expect(formatPaymentMethod({ id: 'x', payment_type: 'card' }).typeLabel).toBe('CARD');
    expect(formatPaymentMethod({ id: 'x', payment_type: 'us_bank_account' }).typeLabel).toBe('Bank Account');
  });

  it('banner + first-method', () => {
    expect(paymentMethodsBanner([])).toBe('none');
    expect(paymentMethodsBanner([card])).toBe('encourage');
    expect(paymentMethodsBanner([card, bank])).toBe('success');
    expect(isFirstMethod([])).toBe(true);
    expect(isFirstMethod([card])).toBe(false);
  });

  it('EF body + insert payloads (contracts unchanged)', () => {
    expect(buildSetupIntentBody('c1', 'us_bank_account')).toEqual({ contractor_id: 'c1', payment_type: 'us_bank_account' });
    expect(buildCardInsert('c1', 'pm_1', '4242', 'VISA', true)).toEqual({ contractor_id: 'c1', stripe_payment_method_id: 'pm_1', payment_type: 'card', last_four: '4242', brand: 'VISA', is_default: true });
    expect(buildAchInsert('c1', 'pm_2', '6789', 'Chase', false)).toEqual({ contractor_id: 'c1', stripe_payment_method_id: 'pm_2', payment_type: 'us_bank_account', last_four: '6789', bank_name: 'Chase', is_default: false });
  });

  it('legacy contractors fields: follow a method, or clear', () => {
    expect(legacyBrandFor(card)).toBe('visa');
    expect(legacyBrandFor(bank)).toBe('Chase');
    expect(buildLegacyContractorUpdate(card, 'ISO')).toEqual({ stripe_payment_method_id: 'pm_1', stripe_payment_method_last4: '4242', stripe_payment_method_brand: 'visa', updated_at: 'ISO' });
    expect(buildLegacyContractorUpdate(null, 'ISO')).toEqual({ stripe_payment_method_id: null, stripe_payment_method_last4: null, stripe_payment_method_brand: null, updated_at: 'ISO' });
  });

  it('removal plan: promote next when default removed; clear when last; nothing otherwise', () => {
    expect(nextDefaultAfterRemoval([card, bank], 'm1')).toEqual({ promote: bank, clearLegacy: false }); // default removed -> promote
    expect(nextDefaultAfterRemoval([card], 'm1')).toEqual({ promote: null, clearLegacy: true });        // last removed -> clear
    expect(nextDefaultAfterRemoval([card, bank], 'm2')).toEqual({ promote: null, clearLegacy: false }); // non-default removed -> nothing
  });

  it('removal confirm message: only-method, then default-method, else none', () => {
    expect(removalConfirmMessage([card], card)).toContain('only payment method');
    expect(removalConfirmMessage([card, bank], card)).toContain('default payment method');
    expect(removalConfirmMessage([card, bank], bank)).toBeNull();
  });

  it('billingName fallback chain', () => {
    expect(billingName({ company_name: 'Acme' })).toBe('Acme');
    expect(billingName({ contact_name: 'Dustin' })).toBe('Dustin');
    expect(billingName({})).toBe('Contractor');
  });
});

describe('Stripe publishable-key guard (NEVER a secret key in the client)', () => {
  it('accepts pk_*, rejects empty / secret keys', () => {
    expect(stripePublishableKeyConfigured('pk_live_abc')).toBe(true);
    expect(stripePublishableKeyConfigured('pk_test_abc')).toBe(true);
    expect(stripePublishableKeyConfigured('')).toBe(false);
    expect(stripePublishableKeyConfigured(undefined)).toBe(false);
    expect(stripePublishableKeyConfigured('sk_live_abc')).toBe(false);
    expect(stripePublishableKeyConfigured('rk_live_abc')).toBe(false);
  });
});

describe('IC 24-5-11 attestation (D-170) — payload + VERBATIM legal copy', () => {
  it('version + show-card + validation', () => {
    expect(ATTESTATION_TEXT_VERSION).toBe('ic-24511-v1-2026-04');
    expect(shouldShowAttestationCard({})).toBe(true);
    expect(shouldShowAttestationCard({ attestation_accepted_at: '2026-01-01' })).toBe(false);
    expect(validateAttestation('', 'Owner', true)).toBe('Enter the signer name and title.');
    expect(validateAttestation('Dustin', 'Owner', false)).toBe('Please check the acceptance box.');
    expect(validateAttestation('Dustin', 'Owner', true)).toBeNull();
  });

  it('payload + contractors update mirror the static save (source preserved)', () => {
    const p = buildAttestationPayload('  Dustin  ', '  Owner  ', 'UA/1.0', 'ISO');
    expect(p).toEqual({ text_version: 'ic-24511-v1-2026-04', accepted: true, accepted_client_ts: 'ISO', user_agent: 'UA/1.0', signer_name: 'Dustin', signer_title: 'Owner', source: 'contractor-settings' });
    const upd = buildAttestationContractorUpdate(p, 'ISO');
    expect(upd).toEqual({ ic_24511_attestation: p, attestation_accepted_at: 'ISO', attestation_signer_name: 'Dustin', attestation_signer_title: 'Owner', attestation_text_version: 'ic-24511-v1-2026-04', updated_at: 'ISO' });
  });

  it('verbatim copy: 4 bullets with the locked obligations', () => {
    const a = SETTINGS_COPY.attestation;
    expect(a.bullets.length).toBe(4);
    expect(a.bullets[1]).toContain('$1M per occurrence / $2M aggregate');
    expect(a.bullets[1]).toContain('additional insured on a primary and non-contributory basis');
    expect(a.bullets[2]).toContain('Indiana Code 24-5-11');
    expect(a.bullets[3]).toContain('joint and several');
    expect(a.bullets[3]).toContain('survives termination');
    expect(a.esignLine).toContain('E-SIGN Act');
    expect(a.esignLine).toContain('Indiana UETA');
  });
});

describe('CGL Certificate of Insurance (D-170)', () => {
  it('validate + needFile + path + update payload', () => {
    expect(validateCoi('', 'P1', '2026-07-01')).toBe('Please enter the insurer, policy number, and expiration date.');
    expect(validateCoi('Nationwide', 'P1', '2026-07-01')).toBeNull();
    expect(coiNeedsFile({}, '2026-07-01')).toBe(true);
    expect(coiNeedsFile({ coi_file_url: 'x', coi_expires_at: '2026-07-01' }, '2026-07-01')).toBe(false);
    expect(coiNeedsFile({ coi_file_url: 'x', coi_expires_at: '2026-07-01' }, '2026-08-01')).toBe(true);
    expect(coiFilePath('U1', 'My Cert.PDF', 123)).toBe('U1/coi/coi-123.pdf');
    const upd = buildCoiUpdate('U1/coi/coi-123.pdf', ' Nationwide ', ' P1 ', '2026-07-01', 'ISO');
    expect(upd).toMatchObject({ coi_file_url: 'U1/coi/coi-123.pdf', coi_insurer: 'Nationwide', coi_policy_number: 'P1', coi_expires_at: '2026-07-01', coi_uploaded_at: 'ISO', coi_reminder_30_sent_at: null, coi_reminder_14_sent_at: null, coi_reminder_7_sent_at: null, coi_expired_notified_at: null, updated_at: 'ISO' });
  });

  it('banner state: none / expired / expiring / current', () => {
    const today = new Date('2026-06-16T00:00:00');
    expect(coiBannerState({}, today).kind).toBe('none');
    expect(coiBannerState({ coi_file_url: 'x', coi_expires_at: '2026-06-10' }, today).kind).toBe('expired');
    const expiring = coiBannerState({ coi_file_url: 'x', coi_expires_at: '2026-06-30' }, today);
    expect(expiring.kind).toBe('expiring');
    expect(expiring.daysLeft).toBe(14);
    expect(coiBannerState({ coi_file_url: 'x', coi_expires_at: '2026-07-20' }, today).kind).toBe('current');
  });

  it('verbatim copy: requirements + minimums', () => {
    expect(SETTINGS_COPY.coi.requirements.length).toBe(3);
    expect(SETTINGS_COPY.coi.subtitle).toContain('$1,000,000 per occurrence / $2,000,000 aggregate');
    expect(SETTINGS_COPY.repair.guaranteeBody).toContain('pay the homeowner $100 and charge your account $250');
  });
});

describe('feature request', () => {
  it('validate + insert payload', () => {
    expect(validateFeatureRequest('   ')).toBe('Please describe your feature request before submitting.');
    expect(validateFeatureRequest('add dark mode')).toBeNull();
    expect(buildFeatureRequestInsert({ id: 'c1', company_name: 'Acme', email: 'a@x.com' }, '  add dark mode  ', 'ISO'))
      .toEqual({ contractor_id: 'c1', contractor_name: 'Acme', contractor_email: 'a@x.com', request_text: 'add dark mode', created_at: 'ISO' });
    expect(buildFeatureRequestInsert(null, 'x', 'ISO')).toMatchObject({ contractor_id: null, contractor_name: 'Unknown Contractor', contractor_email: 'Unknown Email' });
  });
});

describe('gating parity — CPA-only, NO pending-approval gate', () => {
  function fakeStorage() {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => { m.set(k, v); },
      removeItem: (k: string) => { m.delete(k); },
    } as unknown as Storage;
  }

  it('redirects when the CPA is stale (and not already bounced)', () => {
    const redirect = vi.fn();
    const out = enforceCpaRedirect({ cpa_version: 'old', agreement_accepted_at: '2026-01-01' }, redirect, '/contractor/dashboard', fakeStorage());
    expect(out).toBe(true);
    expect(redirect).toHaveBeenCalledWith('/contractor/dashboard');
  });

  it('does NOT redirect when the CPA is current', () => {
    const redirect = vi.fn();
    const out = enforceCpaRedirect({ cpa_version: CURRENT_CPA_VERSION }, redirect, '/contractor/dashboard', fakeStorage());
    expect(out).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('a PENDING contractor with a current CPA is NOT redirected (settings is pending-accessible)', () => {
    const pending = { status: 'pending_approval', cpa_version: CURRENT_CPA_VERSION };
    expect(isPendingApproval(pending)).toBe(true); // true, but the settings page never acts on it
    const redirect = vi.fn();
    const out = enforceCpaRedirect(pending, redirect, '/contractor/dashboard', fakeStorage());
    expect(out).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });
});
