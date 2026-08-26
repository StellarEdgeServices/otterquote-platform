/**
 * Contractor Profile — ported PURE logic (D-211 Phase 4, port of contractor-profile.html).
 *
 * Framework-free, side-effect-free helpers extracted for unit testing. All network
 * (Supabase reads/writes, storage uploads, the validate-contract-template EF) lives
 * in the page/components — never here. Mirrors the static page's behavior 1:1 so the
 * parity tests can pin it.
 */

// ── D-192 service-area: state reference tables (ported from SVC.FIPS / SVC.NAMES) ──
export const STATE_FIPS: Record<string, string> = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10',
  FL: '12', GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20',
  KY: '21', LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27', MS: '28',
  MO: '29', MT: '30', NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36',
  NC: '37', ND: '38', OH: '39', OK: '40', OR: '41', PA: '42', RI: '44', SC: '45',
  SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54',
  WI: '55', WY: '56',
};

export const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

/** Sorted list of state abbreviations (the grid order). */
export const STATE_ABBRS: string[] = Object.keys(STATE_FIPS).sort();

/**
 * Census 2020 PL county-list endpoint for a state abbreviation, or null if the
 * abbreviation is unknown. Ported from SVC.fetchCounties.
 */
export function censusCountyUrl(abbr: string): string | null {
  const fips = STATE_FIPS[abbr];
  if (!fips) return null;
  return `https://api.census.gov/data/2020/dec/pl?get=NAME&for=county:*&in=state:${fips}`;
}

/**
 * Parse the Census API response into a sorted list of county names with the
 * trailing ", <state>" suffix stripped. Mirrors:
 *   d.slice(1).map(row => row[0].replace(/, [^,]+$/, '')).sort()
 * Returns [] for malformed input (the static page's catch path).
 */
export function parseCountyList(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .slice(1)
    .map((row) => (Array.isArray(row) && typeof row[0] === 'string' ? row[0].replace(/, [^,]+$/, '') : ''))
    .filter((name) => name.length > 0)
    .sort();
}

export type SvcMode = 'entire' | 'specific';
export interface SvcStateConfig {
  mode: SvcMode;
  counties: string[];
}
export type SvcConfigs = Record<string, SvcStateConfig>;

/**
 * Build the initial per-state config map from a saved service area. Ported from
 * SVC.populate: when exactly one state is saved, its counties are that saved
 * county list; otherwise counties are empty. A state with counties is 'specific',
 * else 'entire'.
 */
export function buildInitialServiceConfigs(
  savedStates: string[] | null | undefined,
  savedCounties: string[] | null | undefined,
): SvcConfigs {
  const states = savedStates ?? [];
  const counties = savedCounties ?? [];
  const out: SvcConfigs = {};
  for (const abbr of states) {
    const countyList = states.length === 1 ? counties : [];
    out[abbr] = { mode: countyList.length > 0 ? 'specific' : 'entire', counties: countyList };
  }
  return out;
}

/**
 * Collect {service_states, service_counties} from the editor config map. Mirrors
 * SVC.collect: every selected state is a service_state; only 'specific'-mode
 * states contribute counties. (D4: the page persists only service_counties — see
 * collectServiceCountiesForSave.)
 */
export function collectServiceArea(configs: SvcConfigs): { service_states: string[]; service_counties: string[] } {
  const service_states: string[] = [];
  const service_counties: string[] = [];
  for (const abbr of Object.keys(configs)) {
    service_states.push(abbr);
    const cfg = configs[abbr];
    if (cfg.mode === 'specific') {
      for (const c of cfg.counties) service_counties.push(c);
    }
  }
  return { service_states, service_counties };
}

/**
 * County list only, for callers that don't need service_states. gh-749 added
 * `service_states` as a real column and it should be saved alongside this in
 * any actual profile save (see ServiceAreaEditor's onSave, which sends both) —
 * the D4-era premise that it "is not a real column" is stale (gh-1253).
 */
export function collectServiceCountiesForSave(configs: SvcConfigs): string[] {
  return collectServiceArea(configs).service_counties;
}

/** Service-area view summary. Ported from populateViewFromData (service area block). */
export function serviceAreaSummary(
  states: string[] | null | undefined,
  counties: string[] | null | undefined,
  fallbackDescription: string | null | undefined,
): string {
  const svStates = states ?? [];
  const svCounties = counties ?? [];
  if (!svStates.length) return fallbackDescription || '—';
  if (!svCounties.length) return svStates.map((s) => (STATE_NAMES[s] || s) + ' (full state)').join(', ');
  return svCounties.join(', ') + ' (' + svStates.join(', ') + ')';
}

// ── Display helpers (ported from populateViewFromData) ──

/** Phone display: 10-digit → (xxx) xxx-xxxx; 11-digit leading 1 → same; else raw or em-dash. */
export function formatPhone(phone: string | null | undefined): string {
  const raw = (phone || '').replace(/\D/g, '');
  if (raw.length === 10) return `(${raw.slice(0, 3)}) ${raw.slice(3, 6)}-${raw.slice(6)}`;
  if (raw.length === 11 && raw[0] === '1') return `(${raw.slice(1, 4)}) ${raw.slice(4, 7)}-${raw.slice(7)}`;
  return phone || '—';
}

/** Trades, title-cased and comma-joined; em-dash when empty. */
export function tradesDisplay(trades: string[] | null | undefined): string {
  const t = trades ?? [];
  if (!t.length) return '—';
  return t.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(', ');
}

/** Preferred brands, comma-joined; em-dash when empty/absent. */
export function brandsDisplay(brands: string[] | null | undefined): string {
  return brands && brands.length ? brands.join(', ') : '—';
}

/** Normalize a website value into an href (prepend https:// when no scheme). */
export function normalizeWebsiteHref(url: string): string {
  return url.startsWith('http') ? url : 'https://' + url;
}

// ── Storage path helpers ──

/** Extract the storage path from a stored value that may be a full URL or a bare path. */
export function storagePathFromValue(value: string, bucket: string): string {
  const m = value.match(new RegExp(bucket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\/(.+?)(\\?|$)'));
  return m ? decodeURIComponent(m[1]) : value;
}

/** Friendly filename derived from a stored path/URL. Mirrors loadPcTemplates. */
export function fileNameFromUrl(url: string): string {
  return (url.split('/').pop() || '').split('?')[0] || 'template.pdf';
}

// ── Contract Templates (IMP-009) — contractors.contract_templates JSONB array ──

export interface ContractTemplateSlot {
  trade: string;
  fundingType: string;
}
export const CONTRACT_TEMPLATE_SLOTS: ContractTemplateSlot[] = [
  { trade: 'Roofing', fundingType: 'Insurance (full replacement)' },
  { trade: 'Roofing', fundingType: 'Retail' },
  { trade: 'Siding', fundingType: 'Insurance' },
  { trade: 'Siding', fundingType: 'Retail' },
  { trade: 'Gutters', fundingType: 'Insurance' },
  { trade: 'Gutters', fundingType: 'Retail' },
  { trade: 'Windows', fundingType: 'Insurance' },
  { trade: 'Windows', fundingType: 'Retail' },
];

export interface ContractTemplate {
  trade: string;
  funding_type: string;
  file_url: string;
  file_name?: string;
  uploaded_at?: string;
  field_mappings?: Record<string, string>;
  [key: string]: unknown;
}

/** Sanitize a funding-type into a path/id-safe token. Ported from uploadTemplateFile. */
export function safeFundingToken(fundingType: string): string {
  return fundingType.toLowerCase().replace(/\s+/g, '_').replace(/[()]/g, '');
}

/** DOM-id base for a contract slot. Ported from loadContractTemplates slotId. */
export function contractSlotId(trade: string, fundingType: string): string {
  return `template_${trade.toLowerCase()}_${safeFundingToken(fundingType)}`;
}

/** Storage path for a newly uploaded contract template. Ported from uploadTemplateFile. */
export function contractTemplatePath(contractorId: string, trade: string, fundingType: string, ts: number): string {
  return `${contractorId}/${trade.toLowerCase()}_${safeFundingToken(fundingType)}_${ts}.pdf`;
}

export function findContractTemplate(
  list: ContractTemplate[] | null | undefined,
  trade: string,
  fundingType: string,
): ContractTemplate | undefined {
  return (list ?? []).find((t) => t.trade === trade && t.funding_type === fundingType);
}

/** Replace-or-append a contract template (one per trade×funding). Ported from uploadTemplateFile. */
export function upsertContractTemplate(
  list: ContractTemplate[] | null | undefined,
  trade: string,
  fundingType: string,
  fileUrl: string,
  fileName: string,
  iso: string,
): ContractTemplate[] {
  const kept = (list ?? []).filter((t) => !(t.trade === trade && t.funding_type === fundingType));
  kept.push({ trade, funding_type: fundingType, file_url: fileUrl, file_name: fileName, uploaded_at: iso });
  return kept;
}

/** Apply field mappings to the matching template. Ported from saveFieldMappings. */
export function setContractFieldMappings(
  list: ContractTemplate[] | null | undefined,
  trade: string,
  fundingType: string,
  mappings: Record<string, string>,
): ContractTemplate[] {
  return (list ?? []).map((t) =>
    t.trade === trade && t.funding_type === fundingType ? { ...t, field_mappings: mappings } : t,
  );
}

// ── Project Confirmation Templates (D-161) — contractors.color_confirmation_template JSONB map ──

export interface PcTemplateSlot {
  trade: string;
  fundingType: string;
  label: string;
}
export const PC_TEMPLATE_SLOTS: PcTemplateSlot[] = [
  { trade: 'roofing', fundingType: 'insurance', label: 'Roofing — Insurance' },
  { trade: 'roofing', fundingType: 'retail', label: 'Roofing — Retail' },
  { trade: 'siding', fundingType: 'insurance', label: 'Siding — Insurance' },
  { trade: 'siding', fundingType: 'retail', label: 'Siding — Retail' },
  { trade: 'gutters', fundingType: 'insurance', label: 'Gutters — Insurance' },
  { trade: 'gutters', fundingType: 'retail', label: 'Gutters — Retail' },
  { trade: 'windows', fundingType: 'insurance', label: 'Windows — Insurance' },
  { trade: 'windows', fundingType: 'retail', label: 'Windows — Retail' },
];

export interface PcTemplateEntry {
  file_url: string;
  uploaded_at?: string;
}
export type PcTemplateMap = Record<string, PcTemplateEntry>;

export function pcSlotKey(trade: string, fundingType: string): string {
  return `${trade}/${fundingType}`;
}

/** Storage path for a PC template upload. Ported from uploadPcTemplateFile. */
export function pcTemplatePath(contractorId: string, trade: string, fundingType: string, ts: number): string {
  return `${contractorId}/pc_${trade}_${fundingType}_${ts}.pdf`;
}

/** Merge a new PC slot into the existing JSONB map (non-destructive). Ported from uploadPcTemplateFile. */
export function mergePcTemplate(
  existing: PcTemplateMap | null | undefined,
  slotKey: string,
  fileUrl: string,
  iso: string,
): PcTemplateMap {
  return { ...(existing ?? {}), [slotKey]: { file_url: fileUrl, uploaded_at: iso } };
}

// ── Field Mapping modal helpers ──

export function initialFieldMappingValues(
  template: ContractTemplate | undefined,
  defaults: Record<string, { label: string; description: string }>,
): Record<string, string> {
  const saved = template?.field_mappings || {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(defaults)) {
    out[key] = saved[key] !== undefined ? saved[key] : defaults[key].label;
  }
  return out;
}

export function collectFieldMappings(
  values: Record<string, string>,
  defaults: Record<string, { label: string; description: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(defaults)) {
    const v = values[key];
    out[key] = v !== undefined && v !== null ? String(v).trim() : defaults[key].label;
  }
  return out;
}

// ── D-204 manufacturer certifications (warranty_options + contractor_cert_verifications) ──

export interface WarrantyOption {
  id?: string;
  manufacturer: string;
  tier?: string;
  cert_required?: string | null;
  cert_lookup_url?: string | null;
  active?: boolean;
}

/** Manufacturers that require a cert, unique + sorted. Ported from populateD204Manufacturers. */
export function manufacturersWithCert(opts: WarrantyOption[] | null | undefined): string[] {
  return Array.from(new Set((opts ?? []).filter((o) => o.cert_required).map((o) => o.manufacturer))).sort();
}

/** Cert tiers (the cert_required values) for a manufacturer, unique + sorted. Ported from populateD204CertNames. */
export function certTiersFor(opts: WarrantyOption[] | null | undefined, mfr: string): string[] {
  if (!mfr) return [];
  return Array.from(
    new Set((opts ?? []).filter((o) => o.manufacturer === mfr && o.cert_required).map((o) => String(o.cert_required))),
  ).sort();
}

export interface CertVerification {
  id?: string;
  manufacturer: string;
  cert_name: string;
  status: string;
  source?: string | null;
  source_url?: string | null;
  verified_at?: string | null;
  expires_at?: string | null;
  notes?: string | null;
  created_at?: string | null;
}

/** Split cert verifications into verified vs. everything-else. Ported from renderD204CertBadges. */
export function splitCertVerifications(rows: CertVerification[] | null | undefined): {
  verified: CertVerification[];
  other: CertVerification[];
} {
  const r = rows ?? [];
  return { verified: r.filter((x) => x.status === 'verified'), other: r.filter((x) => x.status !== 'verified') };
}

export interface CertStatusStyle {
  bg: string;
  border: string;
  text: string;
  tag: string;
}
export const CERT_STATUS_STYLES: Record<string, CertStatusStyle> = {
  pending: { bg: '#FEF3C7', border: '#FCD34D', text: '#92400E', tag: 'PENDING REVIEW' },
  scrape_failed: { bg: '#FEE2E2', border: '#FCA5A5', text: '#991B1B', tag: 'NEEDS UPLOAD' },
  blocked_by_robots: { bg: '#DBEAFE', border: '#93C5FD', text: '#1E40AF', tag: 'NEEDS UPLOAD' },
  rejected: { bg: '#FCE7F3', border: '#F9A8D4', text: '#9F1239', tag: 'REJECTED' },
};

/** Style bucket for a non-verified cert status (defaults to 'pending'). */
export function certStatusStyle(status: string): CertStatusStyle {
  return CERT_STATUS_STYLES[status] || CERT_STATUS_STYLES.pending;
}

/** Human label for the verification source. Ported from renderD204CertBadges. */
export function certSourceLabel(source: string | null | undefined): string {
  if (source === 'public_lookup') return 'Verified via public lookup';
  if (source === 'admin_review') return 'Verified by admin review';
  return 'Verified';
}

/** True when a cert expires within 30 days of `now`. Ported from renderD204CertBadges (expSoon). */
export function isCertExpiringSoon(expiresAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - now < 30 * 24 * 60 * 60 * 1000;
}

/** Storage path for a submitted cert letter. Ported from submitCertClaim. */
export function certLetterPath(userId: string, mfr: string, certName: string, fileName: string, ts: number): string {
  const safeMfr = mfr.replace(/[^A-Za-z0-9_-]+/g, '_');
  const safeCert = certName.replace(/[^A-Za-z0-9_-]+/g, '_');
  const ext = (fileName.split('.').pop() || 'pdf').toLowerCase();
  return `${userId}/${safeMfr}__${safeCert}__${ts}.${ext}`;
}

// ── D-199 anchor-validation status (display) ──

export function tradeKey(t: string): string {
  return String(t || '').toLowerCase();
}
export function fundingKey(f: string): string {
  return String(f || '').toLowerCase();
}

export interface D199Anchor {
  anchor: string;
  field?: string;
  source?: string;
  found?: boolean;
  manualOverride?: boolean;
}
export interface D199ValidationResult {
  requiredFoundCount?: number;
  requiredCount?: number;
  anchors?: D199Anchor[];
}
export interface D199Row {
  id?: string;
  status: string;
  validation_result?: D199ValidationResult | null;
  manual_overrides?: unknown;
}

/** Anchor count summary, or null when counts are absent. Ported from renderValidationRow. */
export function validationCounts(vr: D199ValidationResult | null | undefined): { found: number; total: number } | null {
  if (!vr) return null;
  if (typeof vr.requiredFoundCount === 'number' && typeof vr.requiredCount === 'number') {
    return { found: vr.requiredFoundCount, total: vr.requiredCount };
  }
  return null;
}

/** Statuses that surface the manual-mapping / admin-review action row. Ported from renderValidationRow. */
export const D199_FAIL_STATES = ['manual_mapping_pending', 'rejected'];

/** Missing anchors from a validation result (for the manual-mapping modal). */
export function missingAnchors(vr: D199ValidationResult | null | undefined): D199Anchor[] {
  return (vr && Array.isArray(vr.anchors) ? vr.anchors : []).filter((a) => !a.found);
}

// ── File-validation guards (ported from the various upload handlers) ──

export interface FileLike {
  type: string;
  size: number;
  name: string;
}

/** PDF + 10MB guard used by all template uploads. Returns an error string or null. */
export function validatePdfUpload(file: FileLike): string | null {
  if (file.type !== 'application/pdf') return 'Please upload a PDF file.';
  if (file.size > 10 * 1024 * 1024) return 'File too large. Maximum 10MB.';
  return null;
}

/** Intro-video guard: MP4/MOV + 200MB. Ported from saveProfile('introVideo'). */
export function validateIntroVideo(file: FileLike): string | null {
  const allowed = ['video/mp4', 'video/quicktime'];
  if (!allowed.includes(file.type)) return 'Please upload an MP4 or MOV file.';
  if (file.size > 200 * 1024 * 1024) return 'File too large. Maximum 200 MB.';
  return null;
}

/** Cert-letter guard: required mfr+tier+file, 10MB. Ported from submitCertClaim. */
export function validateCertClaim(mfr: string, certName: string, file: FileLike | null): string | null {
  if (!mfr || !certName) return 'Select a manufacturer and tier first.';
  if (!file) return 'Attach your cert letter (PDF or image).';
  if (file.size > 10 * 1024 * 1024) return 'File too large — 10MB max.';
  return null;
}
