/**
 * Contractor Pre-Approval — ported PURE logic (D-211 Phase 6, port of contractor-pre-approval.html).
 *
 * Framework-free, side-effect-free helpers extracted for unit testing. ALL network
 * (Supabase reads/writes, contractor-documents/contractor-templates storage uploads,
 * the create-hubspot-contact / send-support-email / record-attestation EFs) lives in
 * page.tsx — never here. Mirrors the static page's behaviour 1:1 so the parity tests
 * can pin it.
 *
 * Tier-3 note: the IC 24-5-11 attestation text version + payload shape and the
 * cpa/agreement version strings are ported VERBATIM (ATTESTATION_TEXT_VERSION,
 * CPA_VERSION, AGREEMENT_VERSION, buildAttestationPayload, buildStep3ContractorUpdate).
 * Any wording/version change is Tier-3 -> STOP and gate to Dustin (legal copy lives in
 * copy.ts). The record-attestation / create-hubspot-contact / send-support-email EF
 * contracts and the contractors / contractor_licenses table writes are called UNCHANGED.
 */

// -- shared coercions ---------------------------------------------
export function str(v: unknown): string {
  return v == null ? '' : String(v);
}

// ================================================================
// Signup payload (localStorage 'cs_contractor_signup') + initial row
// ================================================================

export interface ContractorSignup {
  company_name?: string;
  contact_name?: string;
  signer_title?: string;
  phone?: string;
}

/** Parse the localStorage signup blob defensively. Port of the JSON.parse guards. */
export function parseSignup(raw: string | null): ContractorSignup {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? (o as ContractorSignup) : {};
  } catch {
    return {};
  }
}

/**
 * Initial contractors-row insert when init() finds no row for the live user.
 * Port of contractor-pre-approval.html:1189-1199 (status pending_approval, step 1,
 * phone carried only if present in the signup payload).
 */
export function buildInitialContractorInsert(
  userId: string,
  email: string,
  signup: ContractorSignup,
): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    user_id: userId,
    email,
    company_name: signup.company_name || '',
    contact_name: signup.contact_name || '',
    attestation_signer_title: signup.signer_title || '',
    status: 'pending_approval',
    onboarding_step: 1,
  };
  if (signup.phone) obj.phone = signup.phone;
  return obj;
}

// ================================================================
// Initial-state gating (init state machine) — port of :1229-1243
// ================================================================

export type InitialState =
  | { kind: 'active-redirect' }
  | { kind: 'submitted' }
  | { kind: 'wizard'; step: 2 | 3 | 4 };

/**
 * Decide the landing state for a loaded/created contractor record. EXACT port of the
 * static init tail:
 *   - status === 'active'                       -> redirect to the dashboard
 *   - onboarding_step >= 4 (submitted)          -> the "Application Submitted" panel
 *   - else show step = min(max(2, (step||1)+1), 4)
 *
 * NOTE (brief): pre-approval is the PENDING contractor's landing page. The static init
 * does NOT bounce a pending contractor away — ONLY status === 'active' redirects. We
 * deliberately do NOT add a pending->dashboard gate (that is the OPPOSITE of the
 * dashboard/opportunities gate). "Match the static page's ACTUAL gating order."
 */
export function resolveInitialState(
  contractor: { status?: unknown; onboarding_step?: unknown } | null | undefined,
): InitialState {
  const status = str(contractor?.status);
  const stepNum = Number(contractor?.onboarding_step) || 0;
  if (status === 'active') return { kind: 'active-redirect' };
  // static: onboarding_step >= 4 || (status==='pending_approval' && onboarding_step>=4)
  if (stepNum >= 4 || (status === 'pending_approval' && stepNum >= 4)) {
    return { kind: 'submitted' };
  }
  // static: Math.min(Math.max(2, (contractor.onboarding_step || 1) + 1), 4)
  const base = (contractor?.onboarding_step as number) || 1;
  const next = Math.min(Math.max(2, Number(base) + 1), 4);
  return { kind: 'wizard', step: next as 2 | 3 | 4 };
}

// ================================================================
// Step 2 — Profile basics validation (readProfileBasics :718-732)
// ================================================================

export interface ProfileBasics {
  phone: string;
  trades: string[];
  counties: string[];
  phoneOk: boolean;
  tradesOk: boolean;
  countyOk: boolean;
}

/** County token format: "CountyName-StateCode" (e.g. Marion-IN). Verbatim from the static regex. */
export const COUNTY_RE = /^[A-Za-z][A-Za-z .'-]*-[A-Z]{2}$/;

/** Split the counties free-text field. Port of split(',').map(trim).filter(Boolean). */
export function parseCounties(raw: string): string[] {
  const t = (raw || '').trim();
  return t ? t.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/** Evaluate the profile-basics card. Port of readProfileBasics (phone >=10 digits; county regex). */
export function evaluateProfileBasics(
  phoneRaw: string,
  trades: string[],
  countiesRaw: string,
): ProfileBasics {
  const phone = (phoneRaw || '').trim();
  const counties = parseCounties(countiesRaw || '');
  const digits = phone.replace(/\D/g, '');
  const phoneOk = digits.length >= 10;
  const countyOk = counties.length > 0 && counties.every((c) => COUNTY_RE.test(c));
  return { phone, trades, counties, phoneOk, tradesOk: trades.length > 0, countyOk };
}

// ================================================================
// Step 2 — document gate checks (updateWCCardState / updateStep2Button)
// ================================================================

export type WcChoice = 'file' | 'exemption' | null;

/** WC card satisfied. Port of updateWCCardState:573-588 (file+expiry OR wce1+expiry). */
export function wcSatisfied(
  choice: WcChoice,
  hasFile: boolean,
  fileExpiry: string,
  hasWce1: boolean,
  wce1Expiry: string,
): boolean {
  if (choice === 'file') return hasFile && !!fileExpiry;
  if (choice === 'exemption') return hasWce1 && !!wce1Expiry;
  return false;
}

/** COI card satisfied. Port of docState.coi.file !== null && !!coiExpiryVal. */
export function coiSatisfied(hasFile: boolean, expiry: string): boolean {
  return hasFile && !!expiry;
}

/** License card satisfied. Port of entries.length > 0 || noLicense. */
export function licenseSatisfied(entryCount: number, noLicense: boolean): boolean {
  return entryCount > 0 || noLicense;
}

/** Whole Step-2 gate. Port of updateStep2Button:744-761 (profile && coi && wc && license). */
export function step2Complete(
  profile: { phoneOk: boolean; tradesOk: boolean; countyOk: boolean },
  coiOk: boolean,
  wcOk: boolean,
  licenseOk: boolean,
): boolean {
  return profile.phoneOk && profile.tradesOk && profile.countyOk && coiOk && wcOk && licenseOk;
}

// ================================================================
// Step 2 — multi-license capture (D-218)
// ================================================================

export type JurisdictionLevel = 'state' | 'county' | 'city' | 'other';

export interface LicenseEntry {
  /** Local id (Date.now() in the static page) — stable key, never persisted. */
  id: number;
  jurisdictionLevel: JurisdictionLevel | '';
  jurisdiction: string;
  licenseNumber: string;
  expiryDate: string | null;
  verificationUrl: string | null;
}

export const LICENSE_BADGE_LABELS: Record<string, string> = {
  state: 'State',
  county: 'County',
  city: 'City',
  other: 'Other',
};

/** Validate the inline add/edit license form. Port of saveLicenseEntry:683-685. */
export function validateLicenseEntry(form: {
  jurisdictionLevel: string;
  jurisdiction: string;
  licenseNumber: string;
}): string | null {
  if (!form.jurisdictionLevel) return 'Please select a jurisdiction level.';
  if (!form.jurisdiction.trim()) return 'Please enter the jurisdiction.';
  if (!form.licenseNumber.trim()) return 'Please enter the license number.';
  return null;
}

/** One-line summary for a saved license row. Port of renderLicenseEntries:603-609. */
export function licenseEntrySummary(entry: LicenseEntry): string {
  const badge = LICENSE_BADGE_LABELS[entry.jurisdictionLevel] || entry.jurisdictionLevel;
  const expiry = entry.expiryDate ? `exp ${entry.expiryDate}` : 'No expiry';
  return `${badge} · ${entry.jurisdiction} — License #${entry.licenseNumber} (${expiry})`;
}

/**
 * contractor_licenses insert for one entry (D-218). Port of :961-969 — including the
 * `municipality` column carrying the jurisdiction free-text and the optional doc_url.
 */
export function buildLicenseInsert(
  contractorId: string,
  entry: {
    jurisdiction: string;
    licenseNumber: string;
    expiryDate: string | null;
    jurisdictionLevel: string;
    verificationUrl: string | null;
  },
  docUrl: string | null,
): Record<string, unknown> {
  return {
    contractor_id: contractorId,
    municipality: entry.jurisdiction,
    license_number: entry.licenseNumber || null,
    license_document_url: docUrl,
    expiration_date: entry.expiryDate || null,
    jurisdiction_level: entry.jurisdictionLevel,
    verification_url: entry.verificationUrl || null,
  };
}

// ================================================================
// Step 2 — storage paths (contractor-documents bucket)
// ================================================================

/** COI / WC certificate path. Port of `${user_id}/${Date.now()}-${name}`. */
export function docPath(userId: string, fileName: string, nowMs: number): string {
  return `${userId}/${nowMs}-${fileName}`;
}

/** WCE-1 exemption document path (D-213). Port of `${user_id}/wce1_cert_${Date.now()}_${name}`. */
export function wce1Path(userId: string, fileName: string, nowMs: number): string {
  return `${userId}/wce1_cert_${nowMs}_${fileName}`;
}

/**
 * Per-entry license document path - UID-first (D-220 convention) so the
 * contractor-documents RLS policy (foldername[1] === auth.uid()) admits the
 * upload. The legacy `licenses/${userId}/...` prefix put 'licenses' in
 * segment 1 and was silently RLS-rejected (86e1nyc60); mirrors the static
 * page fix in contractor-pre-approval.html.
 */
export function licenseDocPath(userId: string, fileName: string, nowMs: number): string {
  return `${userId}/licenses/${nowMs}-${fileName}`;
}

// ================================================================
// Step 2 — contractors update + create-fallback payloads
// ================================================================

export interface Step2Inputs {
  coiFileUrl: string | null;
  /** coi_expires_at — yyyy-mm-dd (the date input value, stored as-is by the static page). */
  coiExpiry: string;
  phone: string;
  trades: string[];
  counties: string[];
  wcChoice: WcChoice;
  wcCertFileRef: string | null;
  /** wc_cert_expiry — ISO string (static converts the date input to toISOString). */
  wcCertExpiry: string | null;
  noLicense: boolean;
}

/**
 * contractors UPDATE built at Step-2 submit. Port of the updateObj at :878-902 — the v61
 * column names, both WC branches writing wc_cert_file_ref/expiry/uploaded_at, and the
 * license_path='not_provided' sentinel only when "no license" is checked.
 */
export function buildStep2ContractorUpdate(i: Step2Inputs, nowIso: string): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    coi_file_url: i.coiFileUrl,
    coi_expires_at: i.coiExpiry || null,
    coi_uploaded_at: nowIso,
    phone: i.phone,
    trades: i.trades,
    service_counties: i.counties,
    onboarding_step: 2,
    updated_at: nowIso,
  };
  if (i.wcChoice === 'file' || i.wcChoice === 'exemption') {
    obj.wc_cert_file_ref = i.wcCertFileRef;
    obj.wc_cert_expiry = i.wcCertExpiry;
    obj.wc_cert_uploaded_at = nowIso;
  }
  if (i.noLicense) obj.license_path = 'not_provided';
  return obj;
}

/**
 * Create-fallback when the Step-2 UPDATE affects 0 rows (86e1p4pre — init never created
 * the stub). Port of :922-930 (folds the signup stub fields under the step-2 update).
 */
export function buildStep2FallbackCreate(
  userId: string,
  email: string,
  signup: ContractorSignup,
  step2Update: Record<string, unknown>,
): Record<string, unknown> {
  return {
    user_id: userId,
    email: email || '',
    company_name: signup.company_name || '',
    contact_name: signup.contact_name || '',
    attestation_signer_title: signup.signer_title || '',
    status: 'pending_approval',
    ...step2Update,
  };
}

// ================================================================
// Step 2 — Edge Function request bodies (called UNCHANGED)
// ================================================================

/** create-hubspot-contact (contractor mode) body. Port of :985-989 — contract UNCHANGED. */
export function buildHubspotContactBody(
  email: string,
  contractorId: string,
): { mode: 'contractor'; email: string; contractor_id: string } {
  return { mode: 'contractor', email, contractor_id: contractorId };
}

/**
 * send-support-email body. Port of :998-1004 — admin-routed (NO to_email, so the EF's
 * recipient-override / open-relay path is never exercised). Contract UNCHANGED.
 */
export function buildSupportEmailBody(
  contractor: { company_name?: unknown; contact_name?: unknown; [key: string]: unknown },
  email: string,
): { from_name: string; from_email: string; subject: string; message: string } {
  return {
    from_name: str(contractor.company_name) || str(contractor.contact_name) || 'New Applicant',
    from_email: email,
    subject: 'New Contractor Application — Documents Received',
    message:
      'Contractor has submitted required insurance and documentation. Ready for verification.',
  };
}

// ================================================================
// Step 3 — Platform Agreements + IC 24-5-11 attestation (Tier-3 VERBATIM)
// ================================================================

/** Locked legal version strings — ported verbatim (contractor-pre-approval.html:1032,1044,1047,1052). */
export const ATTESTATION_TEXT_VERSION = 'ic-24511-v1-2026-04';
export const CPA_VERSION = 'v1-2026-04';
export const AGREEMENT_VERSION = 'v1-2026-04';

export interface PreApprovalAttestation {
  text_version: string;
  accepted: true;
  accepted_client_ts: string;
  user_agent: string;
  platform_agreement_ack: true;
  cancellation_policy_ack: true;
}

/** ic_24511_attestation JSONB. VERBATIM port of submitStep3:1031-1038. */
export function buildAttestationPayload(userAgent: string, nowIso: string): PreApprovalAttestation {
  return {
    text_version: ATTESTATION_TEXT_VERSION,
    accepted: true,
    accepted_client_ts: nowIso,
    user_agent: userAgent,
    platform_agreement_ack: true,
    cancellation_policy_ack: true,
  };
}

/** The 3 REQUIRED agreement checkboxes (agreeTcpaSms is optional). Port of :1021. */
export const REQUIRED_AGREEMENT_CHECKS = [
  'agreeToPartnerAgreement',
  'agreeToCancellationPolicy',
  'agreeToAttestation',
] as const;

/** Step-3 gate. Port of the required-check loop at :1022-1028 (TCPA optional). */
export function step3Complete(partner: boolean, cancellation: boolean, attestation: boolean): boolean {
  return partner && cancellation && attestation;
}

/**
 * contractors UPDATE at Step-3 submit. VERBATIM port of :1041-1055 — the cpa/attestation/
 * agreement version stamps, the ic_24511_attestation JSONB, sms_consent_ts gated on the
 * optional TCPA box, and onboarding_step=3.
 */
export function buildStep3ContractorUpdate(
  contractor: { contact_name?: unknown; attestation_signer_title?: unknown; [key: string]: unknown },
  attestation: PreApprovalAttestation,
  tcpaChecked: boolean,
  nowIso: string,
): Record<string, unknown> {
  return {
    cpa_accepted_at: nowIso,
    cpa_version: CPA_VERSION,
    attestation_signer_name: str(contractor.contact_name) || '',
    attestation_signer_title: str(contractor.attestation_signer_title) || '',
    attestation_text_version: ATTESTATION_TEXT_VERSION,
    attestation_accepted_at: nowIso,
    ic_24511_attestation: attestation,
    sms_consent_ts: tcpaChecked ? nowIso : null,
    agreement_accepted_at: nowIso,
    agreement_version: AGREEMENT_VERSION,
    onboarding_step: 3,
    updated_at: nowIso,
  };
}

/**
 * record-attestation EF body — ported EXACTLY as the static page calls it (:1063-1068).
 *
 * Parity note: this payload does NOT satisfy the record-attestation EF's documented
 * contract (which requires attestation_type: 'wce1_exempt' | 'no_license_required'), so
 * the EF returns 400 and the call is swallowed as non-fatal — identical to the LIVE static
 * page ("IP capture fails silently; client-side record is primary"). The authoritative
 * attestation record is the contractors UPDATE above (buildStep3ContractorUpdate). Carried
 * forward UNCHANGED for byte-for-byte parity; the EF's unverified-JWT defect (s6.1) is filed
 * for migration-author — do NOT "fix" it by sending attestation_type here (that would change
 * legal semantics and is Tier-3).
 */
export function buildRecordAttestationBody(
  contractorId: string,
  nowIso: string,
): { contractor_id: string; text_version: string; accepted_at: string; accepted_client_ts: string } {
  return {
    contractor_id: contractorId,
    text_version: ATTESTATION_TEXT_VERSION,
    accepted_at: nowIso,
    accepted_client_ts: nowIso,
  };
}

// ================================================================
// Step 4 — Contract Template (D-209: required, no fallback)
// ================================================================

/** Validate the template upload. Port of submitStep4:1089-1092 (trade+funding, PDF, <=10MB). */
export function validateTemplate(
  trade: string,
  funding: string,
  file: { type?: string; size?: number } | null,
): string | null {
  if (!trade || !funding) return 'Please select a trade and funding type before uploading.';
  if (!file) return 'Please select a PDF file to upload.';
  if (file.type !== 'application/pdf') return 'Please upload a PDF file.';
  if ((file.size || 0) > 10 * 1024 * 1024) return 'File too large. Maximum 10MB.';
  return null;
}

/** Storage slot key for the template. Port of :1101 (trade/funding lower, spaces->_, ()-stripped). */
export function templateSlotKey(trade: string, funding: string): string {
  return `${trade.toLowerCase()}/${funding.toLowerCase().replace(/\s+/g, '_').replace(/[()]/g, '')}`;
}

/** contractor-templates path. Port of :1102 (`${contractor.id}/${slotKey}.pdf`). */
export function templateFilePath(contractorId: string, slotKey: string): string {
  return `${contractorId}/${slotKey}.pdf`;
}

export interface ContractTemplate {
  trade: string;
  funding_type: string;
  path: string;
  uploaded_at: string;
}

/**
 * Upsert one template into the contract_templates JSONB array (replace same trade+funding,
 * else append). Port of :1111-1113.
 */
export function buildContractTemplatesArray(
  existing: ContractTemplate[] | null | undefined,
  trade: string,
  funding: string,
  path: string,
  nowIso: string,
): ContractTemplate[] {
  const arr = Array.isArray(existing) ? existing : [];
  const filtered = arr.filter((t) => !(t.trade === trade && t.funding_type === funding));
  return [...filtered, { trade, funding_type: funding, path, uploaded_at: nowIso }];
}

/** Final contractors UPDATE on submit. Port of finishAndSubmit:1126-1132. */
export function buildFinishSubmitUpdate(
  contractTemplates: ContractTemplate[],
  nowIso: string,
): Record<string, unknown> {
  return {
    contract_templates: contractTemplates,
    status: 'pending_approval',
    onboarding_step: 4,
    updated_at: nowIso,
  };
}
