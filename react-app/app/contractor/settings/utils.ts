/**
 * Contractor Settings — ported PURE logic (D-211 Phase 5, port of contractor-settings.html).
 *
 * Framework-free, side-effect-free helpers extracted for unit testing. ALL network
 * (Supabase reads/writes, storage uploads, the create-setup-intent EF, the Stripe.js
 * Elements flow) lives in the page/components — never here. Mirrors the static page's
 * behaviour 1:1 so the parity tests can pin it.
 *
 * Tier-3 note: the attestation text version + payload shape and the record_attestation_ip
 * flow are ported VERBATIM (see ATTESTATION_TEXT_VERSION + buildAttestationPayload). Any
 * wording change to the attestation/COI legal copy is Tier-3 -> gate to Dustin (copy lives
 * in copy.ts). The create-setup-intent EF and contractor_payment_methods contracts are
 * called UNCHANGED.
 */

// -- shared coercions ---------------------------------------------
export function str(v: unknown): string {
  return v == null ? '' : String(v);
}
export function bool(v: unknown): boolean {
  return v === true;
}

// ================================================================
// Notification preferences
// ================================================================

export interface NotificationType {
  /** DOM id on the static page (kept for traceability). */
  domId: string;
  /** Key under contractors.notification_preferences. */
  prefKey: string;
  /** Checkbox label. */
  label: string;
  /** Default checked state (the static page's `checked` attribute). */
  defaultOn: boolean;
  /** Disabled "Coming Soon" rows (never persisted as on). */
  disabled?: boolean;
}

/**
 * The 9 notification-type checkboxes, in the static page's visual order
 * (contractor-settings.html:721-763). Two are disabled "Coming Soon" rows.
 */
export const NOTIFICATION_TYPES: NotificationType[] = [
  { domId: 'notifNewLead', prefKey: 'new_opportunity', label: 'New opportunity available', defaultOn: true },
  { domId: 'notifBidAccepted', prefKey: 'bid_accepted', label: 'Bid accepted by homeowner', defaultOn: true },
  { domId: 'notifContractSigned', prefKey: 'contract_signed', label: 'Contract signed', defaultOn: true },
  { domId: 'notifColorComplete', prefKey: 'color_complete', label: 'Color selection complete', defaultOn: false, disabled: true },
  { domId: 'notifDeductibleCollected', prefKey: 'deductible_collected', label: 'Deductible collected', defaultOn: false, disabled: true },
  { domId: 'notif48hReminder', prefKey: 'reminder_48h', label: '48-hour contact reminder', defaultOn: true },
  { domId: 'notifAutoBid', prefKey: 'auto_bid_placed', label: 'Auto-bid placed on your behalf', defaultOn: true },
  { domId: 'notifBidExpired', prefKey: 'bid_expired', label: 'Bid expired — get notified so you can renew', defaultOn: true },
  { domId: 'notifBidRenewalRequested', prefKey: 'bid_renewal_requested', label: 'Bid renewal confirmed', defaultOn: true },
];

export interface SettingsRecord {
  email?: unknown;
  phone?: unknown;
  notification_emails?: unknown;
  notification_phones?: unknown;
  notification_preferences?: unknown;
  repairs_accepted?: unknown;
  guarantee_accepted?: unknown;
  auto_renew_bids?: unknown;
  public_directory_optin?: unknown;
  [key: string]: unknown;
}

/**
 * Notification email list. Mirrors `data.notification_emails || [data.email]`, then
 * the static page's `if (!email) return;` truthy filter (contractor-settings.html:2287).
 */
export function getNotificationEmails(record: SettingsRecord | null | undefined): string[] {
  if (!record) return [];
  const list = Array.isArray(record.notification_emails)
    ? (record.notification_emails as unknown[])
    : [record.email];
  return list.map((e) => str(e).trim()).filter((e) => e.length > 0);
}

/** Notification phone list. Mirrors `data.notification_phones || [data.phone]` + truthy filter. */
export function getNotificationPhones(record: SettingsRecord | null | undefined): string[] {
  if (!record) return [];
  const list = Array.isArray(record.notification_phones)
    ? (record.notification_phones as unknown[])
    : [record.phone];
  return list.map((p) => str(p).trim()).filter((p) => p.length > 0);
}

/**
 * Resolve the notification-type checkbox states: start from the catalog defaults
 * (the static page's `checked` attributes), then override with any persisted
 * `notification_preferences` keys that are present. Mirrors initSettings:2298-2318
 * (`if (prefs.X !== undefined) checkbox.checked = prefs.X`).
 */
export function resolveNotificationPrefs(record: SettingsRecord | null | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const t of NOTIFICATION_TYPES) out[t.prefKey] = t.defaultOn;
  const prefs = record?.notification_preferences;
  if (prefs && typeof prefs === 'object') {
    for (const t of NOTIFICATION_TYPES) {
      const v = (prefs as Record<string, unknown>)[t.prefKey];
      if (v !== undefined) out[t.prefKey] = v === true;
    }
  }
  return out;
}

export interface SettingsFormState {
  emails: string[];
  phones: string[];
  notifPrefs: Record<string, boolean>;
  repairsAccepted: boolean;
  guaranteeChecked: boolean;
  autoRenewBids: boolean;
  publicDirectoryOptin: boolean;
}

/**
 * Build the `settings` payload persisted to the contractors row. EXACT port of
 * saveSettings (contractor-settings.html:2613-2660) — including the D-193 exclusion
 * of auto_bid_enabled / auto_bid_settings / auto_bid_value_adds (managed solely by
 * contractor-auto-bids.html / the React /contractor/auto-bids route). `guarantee_accepted`
 * is gated on the repair toggle being on (static: `repairsToggle.checked && guaranteeCheck`).
 */
export function buildSettingsPayload(form: SettingsFormState, nowIso: string): Record<string, unknown> {
  const prefs: Record<string, boolean> = {};
  for (const t of NOTIFICATION_TYPES) prefs[t.prefKey] = !!form.notifPrefs[t.prefKey];
  return {
    repairs_accepted: form.repairsAccepted,
    guarantee_accepted: form.repairsAccepted && form.guaranteeChecked,
    notification_emails: form.emails.map((e) => e.trim()).filter((e) => e.length > 0),
    notification_phones: form.phones.map((p) => p.trim()).filter((p) => p.length > 0),
    notification_preferences: prefs,
    auto_renew_bids: form.autoRenewBids,
    public_directory_optin: form.publicDirectoryOptin,
    updated_at: nowIso,
  };
}

// ================================================================
// Payment methods (contractor_payment_methods) — pure formatting + payloads
// ================================================================

export type PaymentType = 'card' | 'us_bank_account';

export interface PaymentMethodRecord {
  id: string;
  contractor_id?: string;
  stripe_payment_method_id?: string | null;
  payment_type: PaymentType | string;
  last_four?: string | null;
  brand?: string | null;
  bank_name?: string | null;
  is_default?: boolean | null;
  created_at?: string | null;
}

export interface PaymentMethodDisplay {
  isCard: boolean;
  icon: string;
  typeLabel: string;
  last4Display: string;
  fee: 'card' | 'bank';
  isDefault: boolean;
}

/** Display fields for one saved method. Port of renderPaymentMethodsList:1689-1703. */
export function formatPaymentMethod(m: PaymentMethodRecord): PaymentMethodDisplay {
  const isCard = m.payment_type === 'card';
  return {
    isCard,
    icon: isCard ? '💳' : '🏦',
    typeLabel: isCard
      ? (m.brand ? String(m.brand).toUpperCase() : 'CARD')
      : (m.bank_name || 'Bank Account'),
    last4Display: m.last_four ? `•••• ${m.last_four}` : '••••',
    fee: isCard ? 'card' : 'bank',
    isDefault: !!m.is_default,
  };
}

/** Which status banner to show. Port of renderPaymentMethodsList:1676-1687. */
export function paymentMethodsBanner(methods: PaymentMethodRecord[]): 'none' | 'encourage' | 'success' {
  if (methods.length === 0) return 'none';
  if (methods.length === 1) return 'encourage';
  return 'success';
}

/** First method = auto-default. Port of `savedPaymentMethods.length === 0`. */
export function isFirstMethod(methods: PaymentMethodRecord[]): boolean {
  return methods.length === 0;
}

/** create-setup-intent EF request body — contract UNCHANGED (contractor-settings.html:1868). */
export function buildSetupIntentBody(contractorId: string, paymentType: PaymentType): {
  contractor_id: string;
  payment_type: PaymentType;
} {
  return { contractor_id: contractorId, payment_type: paymentType };
}

/** contractor_payment_methods insert for a card (confirmCardSetup:1952-1959). */
export function buildCardInsert(
  contractorId: string,
  paymentMethodId: string,
  last4: string,
  brand: string,
  isDefault: boolean,
): Record<string, unknown> {
  return {
    contractor_id: contractorId,
    stripe_payment_method_id: paymentMethodId,
    payment_type: 'card',
    last_four: last4,
    brand,
    is_default: isDefault,
  };
}

/** contractor_payment_methods insert for ACH (saveACHMethod:2083-2091). */
export function buildAchInsert(
  contractorId: string,
  paymentMethodId: string,
  last4: string,
  bankName: string,
  isDefault: boolean,
): Record<string, unknown> {
  return {
    contractor_id: contractorId,
    stripe_payment_method_id: paymentMethodId,
    payment_type: 'us_bank_account',
    last_four: last4,
    bank_name: bankName,
    is_default: isDefault,
  };
}

/** Legacy brand value written to contractors (card -> brand, bank -> bank_name). */
export function legacyBrandFor(m: PaymentMethodRecord): string | null {
  return m.payment_type === 'card' ? (m.brand ?? null) : (m.bank_name ?? null);
}

/**
 * Legacy contractors-row fields kept in sync with the default method (backward compat).
 * Pass null to CLEAR (no methods left). Port of the `.from('contractors').update(...)`
 * blocks in setDefaultMethod / removePaymentMethod / confirm*Setup.
 */
export function buildLegacyContractorUpdate(
  m: PaymentMethodRecord | null,
  nowIso: string,
): Record<string, unknown> {
  if (!m) {
    return {
      stripe_payment_method_id: null,
      stripe_payment_method_last4: null,
      stripe_payment_method_brand: null,
      updated_at: nowIso,
    };
  }
  return {
    stripe_payment_method_id: m.stripe_payment_method_id ?? null,
    stripe_payment_method_last4: m.last_four ?? null,
    stripe_payment_method_brand: legacyBrandFor(m),
    updated_at: nowIso,
  };
}

export interface RemovalPlan {
  /** Method to promote to default (legacy fields follow it), or null. */
  promote: PaymentMethodRecord | null;
  /** True when the last method was removed — clear the legacy fields. */
  clearLegacy: boolean;
}

/**
 * What to do after deleting `removedId`. Port of removePaymentMethod:1790-1817:
 * if the removed one was default and others remain -> promote remaining[0];
 * if none remain -> clear legacy; otherwise nothing.
 */
export function nextDefaultAfterRemoval(methods: PaymentMethodRecord[], removedId: string): RemovalPlan {
  const removed = methods.find((m) => m.id === removedId);
  const remaining = methods.filter((m) => m.id !== removedId);
  if (removed?.is_default && remaining.length > 0) return { promote: remaining[0], clearLegacy: false };
  if (remaining.length === 0) return { promote: null, clearLegacy: true };
  return { promote: null, clearLegacy: false };
}

/**
 * Confirm() message before removal, or null when no confirm is shown. Port of
 * removePaymentMethod:1768-1772 (only-method warning, then default-method warning).
 */
export function removalConfirmMessage(
  methods: PaymentMethodRecord[],
  method: PaymentMethodRecord,
): string | null {
  if (methods.length === 1) {
    return 'This is your only payment method. Removing it means your bids cannot be accepted until you add a new one. Continue?';
  }
  if (method.is_default) {
    return 'This is your default payment method. Removing it will make another method the default. Continue?';
  }
  return null;
}

/** Billing-details name for the Stripe PM (confirmCardSetup:1925). */
export function billingName(record: { company_name?: unknown; contact_name?: unknown }): string {
  return str(record.company_name) || str(record.contact_name) || 'Contractor';
}

// -- Stripe publishable-key guard (client component reads the env var) --
/** True only for a Stripe PUBLISHABLE key (pk_*). NEVER accept a secret (sk_/rk_) key. */
export function stripePublishableKeyConfigured(key: string | undefined | null): boolean {
  return typeof key === 'string' && key.startsWith('pk_');
}

// ================================================================
// IC 24-5-11 attestation (D-170) — Tier-3 legal: version + payload VERBATIM
// ================================================================

/** Locked legal version string — ported verbatim (contractor-settings.html:2455). */
export const ATTESTATION_TEXT_VERSION = 'ic-24511-v1-2026-04';

/** Attestation card is shown only to contractors with no attestation on file (loadAttestationCard:2425). */
export function shouldShowAttestationCard(record: { attestation_accepted_at?: unknown } | null | undefined): boolean {
  return !!record && !record.attestation_accepted_at;
}

/** Validate the attestation form. Port of saveAttestation:2446-2447. */
export function validateAttestation(name: string, title: string, checked: boolean): string | null {
  if (!name.trim() || !title.trim()) return 'Enter the signer name and title.';
  if (!checked) return 'Please check the acceptance box.';
  return null;
}

export interface AttestationPayload {
  text_version: string;
  accepted: true;
  accepted_client_ts: string;
  user_agent: string;
  signer_name: string;
  signer_title: string;
  source: string;
}

/**
 * The ic_24511_attestation JSONB. VERBATIM port of saveAttestation:2456-2464 —
 * including `source: 'contractor-settings'` (the legal record's surface field is
 * preserved unchanged; changing it is a Tier-3 decision for Dustin).
 */
export function buildAttestationPayload(
  name: string,
  title: string,
  userAgent: string,
  nowIso: string,
): AttestationPayload {
  return {
    text_version: ATTESTATION_TEXT_VERSION,
    accepted: true,
    accepted_client_ts: nowIso,
    user_agent: userAgent,
    signer_name: name.trim(),
    signer_title: title.trim(),
    source: 'contractor-settings',
  };
}

/** contractors-row update for the attestation. Port of saveAttestation:2467-2474. */
export function buildAttestationContractorUpdate(
  payload: AttestationPayload,
  nowIso: string,
): Record<string, unknown> {
  return {
    ic_24511_attestation: payload,
    attestation_accepted_at: nowIso,
    attestation_signer_name: payload.signer_name,
    attestation_signer_title: payload.signer_title,
    attestation_text_version: payload.text_version,
    updated_at: nowIso,
  };
}

// ================================================================
// CGL Certificate of Insurance (D-170)
// ================================================================

export interface CoiRecord {
  coi_file_url?: unknown;
  coi_insurer?: unknown;
  coi_policy_number?: unknown;
  coi_expires_at?: unknown;
}

/** Validate the COI form's required text fields. Port of saveCoi:2509-2511. */
export function validateCoi(insurer: string, policy: string, expires: string): string | null {
  if (!insurer.trim() || !policy.trim() || !expires) {
    return 'Please enter the insurer, policy number, and expiration date.';
  }
  return null;
}

/**
 * A new file is required when none is on record OR the expiration date is changing.
 * Port of saveCoi:2515 (`!coi_file_url || coi_expires_at !== expires`).
 */
export function coiNeedsFile(record: CoiRecord, expires: string): boolean {
  return !record.coi_file_url || str(record.coi_expires_at) !== expires;
}

/** Storage path for the uploaded certificate. Port of saveCoi:2535 (bucket: contractor-documents). */
export function coiFilePath(userId: string, fileName: string, nowMs: number): string {
  const ext = (fileName.split('.').pop() || 'pdf').toLowerCase();
  return `${userId}/coi/coi-${nowMs}.${ext}`;
}

/**
 * contractors-row update on COI save — resets the nightly-sweep reminder stamps so the
 * new expiry re-qualifies. Port of saveCoi:2543-2556.
 */
export function buildCoiUpdate(
  filePath: string,
  insurer: string,
  policy: string,
  expires: string,
  nowIso: string,
): Record<string, unknown> {
  return {
    coi_file_url: filePath,
    coi_insurer: insurer.trim(),
    coi_policy_number: policy.trim(),
    coi_expires_at: expires,
    coi_uploaded_at: nowIso,
    coi_reminder_30_sent_at: null,
    coi_reminder_14_sent_at: null,
    coi_reminder_7_sent_at: null,
    coi_expired_notified_at: null,
    updated_at: nowIso,
  };
}

export type CoiBannerKind = 'none' | 'expired' | 'expiring' | 'current';
export interface CoiBannerState {
  kind: CoiBannerKind;
  daysLeft: number | null;
  /** Localized expiry date string (only for 'current'/'expiring' display), or null. */
  expiresLabel: string | null;
}

/**
 * COI status banner state. Port of loadCoiStatus:2362-2419 — no file/expiry -> 'none';
 * else daysLeft<0 -> 'expired'; <=30 -> 'expiring'; else 'current'. `today` should be
 * midnight-floored by the caller; expiry is parsed as `<date>T00:00:00` like the static page.
 */
export function coiBannerState(record: CoiRecord, today: Date): CoiBannerState {
  const fileUrl = str(record.coi_file_url);
  const expiresAt = str(record.coi_expires_at);
  if (!fileUrl || !expiresAt) return { kind: 'none', daysLeft: null, expiresLabel: null };
  const exp = new Date(expiresAt + 'T00:00:00');
  const daysLeft = Math.floor((exp.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  const expiresLabel = exp.toLocaleDateString();
  if (daysLeft < 0) return { kind: 'expired', daysLeft, expiresLabel };
  if (daysLeft <= 30) return { kind: 'expiring', daysLeft, expiresLabel };
  return { kind: 'current', daysLeft, expiresLabel };
}

// ================================================================
// Feature request (feature_requests)
// ================================================================

export function validateFeatureRequest(text: string): string | null {
  if (!text.trim()) return 'Please describe your feature request before submitting.';
  return null;
}

/** feature_requests insert. Port of submitFeatureRequest:2876-2882. */
export function buildFeatureRequestInsert(
  contractor: { id?: unknown; company_name?: unknown; contact_name?: unknown; email?: unknown } | null,
  text: string,
  nowIso: string,
): Record<string, unknown> {
  return {
    contractor_id: (contractor?.id as string) || null,
    contractor_name: str(contractor?.company_name) || str(contractor?.contact_name) || 'Unknown Contractor',
    contractor_email: str(contractor?.email) || 'Unknown Email',
    request_text: text.trim(),
    created_at: nowIso,
  };
}
