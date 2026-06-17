/**
 * Admin Contractors — ported PURE logic (D-211 Phase 8, port of admin-contractors.html).
 *
 * Framework-free, side-effect-free helpers extracted for unit testing. ALL network
 * (Supabase reads, the admin-contractor-action EF, the contractor_has_required_docs /
 * acknowledge_alert RPCs, platform-health-check) lives in the page/components — never
 * here. Mirrors the static page's behavior 1:1 so the parity tests can pin it.
 *
 * §6.1 Phase-8 XSS note: the static renderContractors() built an HTML string and
 * interpolated contractor-controlled values both as text and inside onclick="...('${...}')"
 * handlers. This port renders every value as JSX text and wires every action as an
 * onClick closure, so the helpers here return STRUCTURED descriptors (icon/text/colors),
 * never HTML — the component does the (inherently escaped) rendering.
 */

// ── Data model (subset of the contractors row + the contractor_licenses join) ──
export interface ContractorLicense {
  id: string;
  municipality: string | null;
  license_number: string | null;
}

export interface Contractor {
  id: string;
  company_name?: string | null;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  status: string; // 'pending_approval' | 'active' | 'inactive' | …
  created_at: string;
  approved_at?: string | null;
  rejected_at?: string | null;
  rejection_reason?: string | null;
  trades?: string[] | null;
  pc_template_migration_pending?: boolean | null;
  coi_file_url?: string | null;
  coi_expires_at?: string | null;
  wc_cert_file_ref?: string | null;
  contractor_licenses?: ContractorLicense[] | null;
  license_path?: string | null;
  license_attestation_signed_at?: string | null;
  license_verified?: boolean | null;
  license_verified_at?: string | null;
  attestation_accepted_at?: string | null;
  service_counties?: string[] | null;
  has_workers_comp?: boolean | null;
  has_general_liability?: boolean | null;
  contract_templates?: Record<string, unknown> | null;
  agreement_accepted_at?: string | null;
  workers_comp_carrier?: string | null;
  general_liability_carrier?: string | null;
  insurance_verified?: boolean | null;
  insurance_verified_at?: string | null;
  insurance_verification_sent_at?: string | null;
  insurance_verification_email?: string | null;
  admin_notes?: string | null;
  // select('*') returns more columns than we model — tolerate them.
  [key: string]: unknown;
}

// ── COI state (admin-contractors.html:973 coiState) ──────────────────────────
export type CoiState = 'missing' | 'expired' | 'expiring' | 'current';

/**
 * Derive a contractor's COI state for filters + badges. Mirrors coiState():
 * missing when no file/expiry; else day-delta from local-midnight today to the
 * local-midnight expiry (<0 expired, ≤30 expiring, else current). `now` is
 * injectable for deterministic tests; defaults to the real clock like the source.
 */
export function coiState(c: Contractor, now: Date = new Date()): CoiState {
  if (!c.coi_file_url || !c.coi_expires_at) return 'missing';
  const today = new Date(now.getTime());
  today.setHours(0, 0, 0, 0);
  const exp = new Date(c.coi_expires_at + 'T00:00:00');
  const days = Math.floor((exp.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (days < 0) return 'expired';
  if (days <= 30) return 'expiring';
  return 'current';
}

// ── Summary cards (admin-contractors.html:956 updateSummaryCards) ────────────
export interface SummaryCounts {
  pending: number;
  active: number;
  total: number;
  pcMigration: number;
  coiMissing: number;
  coiExpiring: number;
}

/**
 * The six contractor-derived summary counts. The seventh card (waitlist) comes
 * from expansion_waitlist separately — see groupWaitlistByState / the page.
 */
export function summaryCounts(contractors: Contractor[], now: Date = new Date()): SummaryCounts {
  return {
    pending: contractors.filter((c) => c.status === 'pending_approval').length,
    active: contractors.filter((c) => c.status === 'active').length,
    total: contractors.length,
    pcMigration: contractors.filter((c) => c.pc_template_migration_pending === true).length,
    coiMissing: contractors.filter((c) => {
      const s = coiState(c, now);
      return s === 'missing' || s === 'expired';
    }).length,
    coiExpiring: contractors.filter((c) => coiState(c, now) === 'expiring').length,
  };
}

// ── Filter tabs (admin-contractors.html:696 + 993 renderContractors) ─────────
export type ContractorFilter =
  | 'pending_approval'
  | 'all'
  | 'pc_migration_pending'
  | 'coi_missing'
  | 'coi_expiring';

export const CONTRACTOR_FILTERS: { key: ContractorFilter; label: string }[] = [
  { key: 'pending_approval', label: 'Pending Review' },
  { key: 'all', label: 'All Contractors' },
  { key: 'pc_migration_pending', label: '⚠️ Needs PC Template Update' },
  { key: 'coi_missing', label: '⚠️ COI Missing / Expired' },
  { key: 'coi_expiring', label: 'COI Expiring ≤30d' },
];

/** The 5 filter predicates as one switch. Mirrors renderContractors()'s filtered = … */
export function filterContractors(
  contractors: Contractor[],
  filter: ContractorFilter,
  now: Date = new Date(),
): Contractor[] {
  if (filter === 'pending_approval') return contractors.filter((c) => c.status === 'pending_approval');
  if (filter === 'pc_migration_pending') return contractors.filter((c) => c.pc_template_migration_pending === true);
  if (filter === 'coi_missing') {
    return contractors.filter((c) => {
      const s = coiState(c, now);
      return s === 'missing' || s === 'expired';
    });
  }
  if (filter === 'coi_expiring') return contractors.filter((c) => coiState(c, now) === 'expiring');
  return contractors; // 'all'
}

// ── D-210 document sub-cards (admin-contractors.html:896 renderDocumentSubCards) ──
export interface DocBadge {
  icon: string;
  text: string;
  bg: string;
  color: string;
}

/** CGL COI badge. The component appends the (display-only) expiry date. */
export function cglDocBadge(c: Contractor): DocBadge {
  const hasCoi = c.coi_file_url != null;
  return {
    icon: hasCoi ? '✅' : '❌',
    text: 'CGL COI',
    bg: hasCoi ? '#dcfce7' : '#fee2e2',
    color: hasCoi ? '#166534' : '#991b1b',
  };
}

/** Workers' Comp badge — incl. the WCE-1-EXEMPT special case. */
export function wcDocBadge(c: Contractor): DocBadge {
  if (c.wc_cert_file_ref != null) {
    if (c.wc_cert_file_ref === 'WCE-1-EXEMPT') {
      return { icon: '🔷', text: 'WCE-1 Exempt', bg: '#ddd6fe', color: '#4f46e5' };
    }
    return { icon: '✅', text: "Workers' Comp", bg: '#dcfce7', color: '#166534' };
  }
  return { icon: '❌', text: "Workers' Comp", bg: '#fee2e2', color: '#991b1b' };
}

/**
 * License badge (D-218): contractor_licenses is a separate joined table; a license
 * doc OR an attestation (license_path==='not_provided' OR a signed attestation)
 * satisfies the requirement. Attestation-only (no doc) → "No License Req.".
 */
export function licenseDocBadge(c: Contractor): DocBadge {
  const hasLicenseDoc =
    (Array.isArray(c.contractor_licenses) && c.contractor_licenses.length > 0) ||
    (!!c.license_path && c.license_path !== 'not_provided');
  const hasLicenseAttest = c.license_path === 'not_provided' || c.license_attestation_signed_at != null;
  if (hasLicenseDoc || hasLicenseAttest) {
    if (hasLicenseAttest && !hasLicenseDoc) {
      return { icon: '📋', text: 'No License Req.', bg: '#fef3c7', color: '#92400e' };
    }
    return { icon: '✅', text: 'License', bg: '#dcfce7', color: '#166534' };
  }
  return { icon: '❌', text: 'License', bg: '#fee2e2', color: '#991b1b' };
}

// ── Header warning badges (admin-contractors.html:1042 header-badges block) ──
export interface HeaderBadge {
  text: string;
  bg: string;
  color: string;
  border: string;
}

/** COI header pill (null when current). Mirrors the IIFE at :1046. */
export function coiHeaderBadge(c: Contractor, now: Date = new Date()): HeaderBadge | null {
  const s = coiState(c, now);
  if (s === 'missing') return { text: '⚠️ COI Missing', bg: '#fee2e2', color: '#991b1b', border: '#fca5a5' };
  if (s === 'expired') return { text: '⚠️ COI Expired', bg: '#fee2e2', color: '#991b1b', border: '#fca5a5' };
  if (s === 'expiring') return { text: 'COI ≤30d', bg: '#fef3c7', color: '#92400e', border: '#E07B00' };
  return null;
}

/** PC-template header badge shows on a truthy flag (source uses truthy at :1045). */
export function showPcTemplateBadge(c: Contractor): boolean {
  return !!c.pc_template_migration_pending;
}

/** "No Attestation" badge shows when attestation_accepted_at is falsy (:1053). */
export function showNoAttestationBadge(c: Contractor): boolean {
  return !c.attestation_accepted_at;
}

// ── Service area (admin-contractors.html:1090 + 1150) ────────────────────────
/** All unique states derived from the "County-ST" suffix. Source: Service Area "States". */
export function deriveServiceStates(c: Contractor): string[] {
  const counties = c.service_counties || [];
  return Array.from(
    new Set(
      counties
        .map((s) => (typeof s === 'string' && s.includes('-') ? (s.split('-').pop() as string) : null))
        .filter((s): s is string => !!s),
    ),
  );
}

/** Primary license-board state: first county suffix, default 'IN'. Source: openLicenseBoard derive. */
export function deriveLicenseBoardState(c: Contractor): string {
  const counties = c.service_counties || [];
  for (const s of counties) {
    if (typeof s === 'string' && s.includes('-')) return s.split('-').pop() as string;
  }
  return 'IN';
}

// ── License board URLs (admin-contractors.html:1211 openLicenseBoard) ────────
/** Static (state-only) license-board lookup URLs. IN + the unknown fallback are query-built. */
export const LICENSE_BOARD_STATIC_URLS: Record<string, string> = {
  OH: 'https://elicense.ohio.gov/oh_verifylicense/',
  IL: 'https://apeironlicensing.idfpr.com/',
  MI: 'https://w2.lara.state.mi.us/VAL/',
  KY: 'https://secure.kentucky.gov/formservices/DBC/LicenseeSearch',
  TN: 'https://verify.tn.gov/',
  FL: 'https://www.myfloridalicense.com/wl11.asp',
  TX: 'https://www.tdlr.texas.gov/licensesearch/',
  CA: 'https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx',
};

/** Resolve the license-board URL for a state, query-building IN + the Google fallback. */
export function licenseBoardUrl(state: string, companyName: string): string {
  if (state === 'IN') {
    return `https://www.in.gov/pla/licensing/find-a-licensee/?q=${encodeURIComponent(companyName)}`;
  }
  if (LICENSE_BOARD_STATIC_URLS[state]) return LICENSE_BOARD_STATIC_URLS[state];
  return `https://www.google.com/search?q=${encodeURIComponent(
    companyName + ' contractor license ' + (state || ''),
  )}`;
}

// ── Profile completeness (admin-contractors.html:1102 checklist) ─────────────
export interface ChecklistItem {
  label: string;
  done: boolean;
}

export function profileChecklist(c: Contractor): ChecklistItem[] {
  return [
    { label: 'Company information', done: !!(c.company_name && c.company_name.trim()) },
    { label: 'Insurance on file', done: !!(c.has_workers_comp || c.has_general_liability) },
    { label: 'Service area', done: (c.service_counties || []).length > 0 },
    { label: 'Contract template', done: !!(c.contract_templates && Object.keys(c.contract_templates).length > 0) },
    { label: 'Payment method', done: false }, // hardcoded ⬜ in source
    { label: 'Agreement accepted', done: !!c.agreement_accepted_at },
  ];
}

// ── admin-contractor-action payload builders (UNCHANGED contracts — Tier-3) ──
export interface MarkLicenseVerifiedPayload {
  action: 'mark_license_verified';
  contractor_id: string;
}
export interface SendInsuranceVerificationPayload {
  action: 'send_insurance_verification';
  contractor_id: string;
  broker_email: string;
  contractor_company_name: string;
}
export interface MarkInsuranceVerifiedPayload {
  action: 'mark_insurance_verified';
  contractor_id: string;
}
export interface SaveNotesPayload {
  action: 'save_notes';
  contractor_id: string;
  notes: string | null;
}
export interface ApprovePayload {
  action: 'approve';
  contractor_id: string;
}
export interface RejectPayload {
  action: 'reject';
  contractor_id: string;
  reason: string;
}

export function markLicenseVerifiedPayload(contractorId: string): MarkLicenseVerifiedPayload {
  return { action: 'mark_license_verified', contractor_id: contractorId };
}

export function sendInsuranceVerificationPayload(
  contractorId: string,
  brokerEmail: string,
  companyName: string | null | undefined,
): SendInsuranceVerificationPayload {
  return {
    action: 'send_insurance_verification',
    contractor_id: contractorId,
    broker_email: brokerEmail,
    contractor_company_name: companyName || 'Contractor',
  };
}

export function markInsuranceVerifiedPayload(contractorId: string): MarkInsuranceVerifiedPayload {
  return { action: 'mark_insurance_verified', contractor_id: contractorId };
}

export function saveNotesPayload(contractorId: string, notes: string): SaveNotesPayload {
  return { action: 'save_notes', contractor_id: contractorId, notes: notes || null };
}

export function approvePayload(contractorId: string): ApprovePayload {
  return { action: 'approve', contractor_id: contractorId };
}

export function rejectPayload(contractorId: string, reason: string): RejectPayload {
  return { action: 'reject', contractor_id: contractorId, reason };
}

// ── Platform monitoring (admin-contractors.html:1493 loadCronHealth + helpers) ──
export interface CronRow {
  job_name: string;
  last_run_at?: string | null;
  last_run_status?: string | null;
  last_error?: string | null;
  run_count?: number | null;
  p_error?: string | null;
  [key: string]: unknown;
}

/** Split cron_health rows into EF-health (ef-*) vs cron-job rows. */
export function splitCronRows(rows: CronRow[] | null | undefined): { efRows: CronRow[]; jobRows: CronRow[] } {
  const all = rows || [];
  return {
    efRows: all.filter((r) => typeof r.job_name === 'string' && r.job_name.startsWith('ef-')),
    jobRows: all.filter((r) => !(typeof r.job_name === 'string' && r.job_name.startsWith('ef-'))),
  };
}

/** Strip the ef- prefix for the EF-health table's Function column. */
export function efFunctionName(jobName: string): string {
  return jobName.replace(/^ef-/, '');
}

/** The 'docusign-usage' row, if present, drives the DocuSign Envelopes card. */
export function findDocusignRow(jobRows: CronRow[]): CronRow | undefined {
  return jobRows.find((r) => r.job_name === 'docusign-usage');
}

/** Cron Job Health table excludes the docusign-usage row (rendered as its own card). */
export function cronJobRows(jobRows: CronRow[]): CronRow[] {
  return jobRows.filter((r) => r.job_name !== 'docusign-usage');
}

export interface DocusignMeta {
  used: number | string;
  limit: number | string;
  pct: number | null;
  alertSent: boolean;
  barColor: string;
  barWidth: number;
}

/** Parse the docusign-usage row's JSON meta (from p_error || last_error). */
export function parseDocusignMeta(row: CronRow): DocusignMeta {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse((row.p_error as string) || (row.last_error as string) || '{}') ?? {};
  } catch {
    meta = {};
  }
  const used = meta.used != null ? (meta.used as number | string) : '—';
  const limit = meta.limit != null ? (meta.limit as number | string) : 40;
  const pct = meta.percentUsed != null ? (meta.percentUsed as number) : null;
  const alertSent = !!meta.alertSent;
  const barColor = pct == null ? '#3b82f6' : pct >= 80 ? '#ef4444' : pct >= 60 ? '#f59e0b' : '#22c55e';
  const barWidth = pct != null ? Math.min(pct, 100) : 0;
  return { used, limit, pct, alertSent, barColor, barWidth };
}

export interface PlatformAlert {
  id: string;
  sent_at?: string | null;
  alert_type: string;
  function_name?: string | null;
  message?: string | null;
  [key: string]: unknown;
}

/**
 * First line of an alert message. The source splits on the LITERAL two-char "\n"
 * (backslash-n) sequence — admin-contractors.html:1540 `.split('\\n')[0]` — because
 * messages are stored with escaped newlines, not real ones. Preserved verbatim.
 */
export function firstMessageLine(message: string | null | undefined): string {
  return String(message || '').split('\\n')[0];
}

export interface AlertTypeStyle {
  text: string;
  bg: string;
  color: string;
}

export const ALERT_TYPE_STYLES: Record<string, AlertTypeStyle> = {
  ef_silent_failure: { text: 'EF FAILURE', bg: '#7c2d12', color: '#fdba74' },
  cron_staleness: { text: 'STALE', bg: '#713f12', color: '#fde68a' },
  cron_error: { text: 'CRON ERROR', bg: '#7f1d1d', color: '#fca5a5' },
  rate_limit: { text: 'RATE LIMIT', bg: '#312e81', color: '#a5b4fc' },
};

/** Alert-type pill descriptor; unknown types fall back to the raw type (rendered as JSX text). */
export function alertTypeLabel(alertType: string): AlertTypeStyle {
  return ALERT_TYPE_STYLES[alertType] || { text: alertType, bg: '#1e293b', color: '#94a3b8' };
}

export interface CronStatusBadge {
  text: string;
  bg: string;
  color: string;
  title?: string;
}

/** OK / ERROR / — badge for a cron or EF row (the title surfaces the error on hover). */
export function cronStatusBadge(status: string | null | undefined, error?: string | null): CronStatusBadge {
  if (status === 'success') return { text: 'OK', bg: '#14532d', color: '#86efac' };
  if (status === 'error') return { text: 'ERROR', bg: '#7f1d1d', color: '#fca5a5', title: error || undefined };
  return { text: '—', bg: '#1e293b', color: '#64748b' };
}

/** Relative-time label. `now` injectable for tests (source uses Date.now()). */
export function timeAgo(isoString: string, now: number = Date.now()): string {
  const diff = now - new Date(isoString).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

// ── D-178 expansion waitlist (admin-contractors.html:1760 loadWaitlistStats) ──
export interface WaitlistRow {
  state?: string | null;
  opted_in?: boolean | null;
  created_at?: string | null;
}

export interface WaitlistStateCount {
  state: string;
  total: number;
  optedIn: number;
}

/** Group waitlist rows by state (null → 'Unknown'), sorted by state localeCompare. */
export function groupWaitlistByState(rows: WaitlistRow[] | null | undefined): WaitlistStateCount[] {
  const byState: Record<string, { total: number; optedIn: number }> = {};
  for (const row of rows || []) {
    const st = row.state || 'Unknown';
    if (!byState[st]) byState[st] = { total: 0, optedIn: 0 };
    byState[st].total++;
    if (row.opted_in) byState[st].optedIn++;
  }
  return Object.entries(byState)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([state, counts]) => ({ state, total: counts.total, optedIn: counts.optedIn }));
}

// ── Display helpers ──────────────────────────────────────────────────────────
/** "Applied" date — toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}). */
export function formatAppliedDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Status pill text: underscores → spaces (e.g. pending_approval → "pending approval"). */
export function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}
