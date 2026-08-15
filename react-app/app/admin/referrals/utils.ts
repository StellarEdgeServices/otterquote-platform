/**
 * Admin Referral Partners — pure logic (D-211 Phase 11).
 *
 * Framework-free, side-effect-free helpers extracted for unit testing.
 * All network / supabase calls live in page.tsx — never here.
 *
 * Port of admin-referrals.html @ main behavior 1:1.
 *
 * ⚠️  W-9 / PAYMENT-BLOCK CONTRACTS — DO NOT TRANSFORM (Tier-3).
 * The referral_agents read shape (REFERRAL_AGENTS_SELECT), the verify-W9 write
 * payload ({ w9_verified_at }), and the manual-unblock write payload
 * ({ payments_blocked: false }) reproduce the static page's queries byte-for-byte.
 * These are DIRECT table .update() calls, never Edge Functions, and no referral
 * commission logic (apply_referral_commission) is referenced.
 *
 * §6.1 XSS note: all values are returned as plain data; JSX rendering in
 * page.tsx is inherently escaped. No HTML strings are built here. (The static
 * renderTable() interpolated agent_type UNESCAPED into typeBadge() innerHTML —
 * an injection sink closed by construction in the React port.)
 */

// ── Data model (referral_agents — sql/v7-referral-system.sql, v88) ────────────

export interface ReferralAgent {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  agent_type?: string | null;
  created_at?: string | null;
  payments_blocked?: boolean | null;
  w9_file_url?: string | null;
  w9_submitted_at?: string | null;
  w9_verified_at?: string | null;
  w9_notification_sent_at?: string | null;
  [key: string]: unknown; // select(...) is column-scoped, but stay tolerant
}

// ── referral_agents read shape — UNCHANGED CONTRACT (Tier-3, pinned) ──────────
/**
 * EXACT select column list from admin-referrals.html:435 — byte-for-byte.
 * Consumed by the loader in page.tsx and pinned in referrals.test.ts so any
 * drift in the read shape fails the build.
 */
export const REFERRAL_AGENTS_SELECT =
  'id, first_name, last_name, email, agent_type, created_at, payments_blocked, w9_file_url, w9_submitted_at, w9_verified_at, w9_notification_sent_at';

// ── Filter tabs ───────────────────────────────────────────────────────────────

export type ReferralFilter = 'all' | 'blocked' | 'pending_review' | 'verified';

export const REFERRAL_FILTERS: { key: ReferralFilter; label: string }[] = [
  { key: 'all', label: 'All Partners' },
  { key: 'blocked', label: '⚠️ Blocked' },
  { key: 'pending_review', label: '📋 Pending Review' },
  { key: 'verified', label: '✅ Verified' },
];

/**
 * Filter rows for the active tab. Mirrors filteredPartners() in admin-referrals.html:
 *   blocked        → payments_blocked truthy
 *   pending_review → w9_submitted_at set AND w9_verified_at not set
 *   verified       → w9_verified_at set
 *   all (default)  → every row
 */
export function filterPartners(
  partners: ReferralAgent[],
  filter: ReferralFilter,
): ReferralAgent[] {
  switch (filter) {
    case 'blocked':
      return partners.filter((p) => !!p.payments_blocked);
    case 'pending_review':
      return partners.filter((p) => !!p.w9_submitted_at && !p.w9_verified_at);
    case 'verified':
      return partners.filter((p) => !!p.w9_verified_at);
    default:
      return partners;
  }
}

// ── Summary cards ───────────────────────────────────────────────────────────

export interface ReferralSummary {
  total: number;
  blocked: number;
  pendingReview: number;
  verified: number;
}

/**
 * Summary card counts. Mirrors updateSummaryCards() EXACTLY:
 *   total         = partners.length
 *   blocked       = count payments_blocked
 *   pendingReview = count (w9_submitted_at && !w9_verified_at)
 *   verified      = count w9_verified_at
 */
export function summaryCards(partners: ReferralAgent[]): ReferralSummary {
  return {
    total: partners.length,
    blocked: partners.filter((p) => !!p.payments_blocked).length,
    pendingReview: partners.filter((p) => !!p.w9_submitted_at && !p.w9_verified_at).length,
    verified: partners.filter((p) => !!p.w9_verified_at).length,
  };
}

// ── Display helpers ───────────────────────────────────────────────────────────

/**
 * Full name: [first, last] joined by a space, falsy parts dropped; '—' if empty.
 * Mirrors `([p.first_name, p.last_name].filter(Boolean).join(' ')) || '—'`.
 */
export function fullName(p: Pick<ReferralAgent, 'first_name' | 'last_name'>): string {
  return [p.first_name, p.last_name].filter(Boolean).join(' ') || '—';
}

/**
 * Date label. Reproduces fmtDate() in admin-referrals.html exactly:
 *   null/falsy → '—'
 *   else new Date(iso).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
 */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ── Badge descriptors (NOT html) ──────────────────────────────────────────────

export interface BadgeDescriptor {
  label: string;
  /** Badge CSS modifier class, e.g. 'badge-verified'. */
  className: string;
}

/**
 * W-9 status badge. Mirrors w9StatusBadge() priority order + labels EXACTLY:
 *   w9_verified_at          → '✅ Verified'             / badge-verified
 *   w9_submitted_at         → '📋 Pending Review'       / badge-pending
 *   w9_notification_sent_at → '⚠️ Notified — Not Filed' / badge-blocked
 *   else                    → 'Not Required Yet'        / badge-not-filed
 */
export function w9StatusBadge(p: ReferralAgent): BadgeDescriptor {
  if (p.w9_verified_at) return { label: '✅ Verified', className: 'badge-verified' };
  if (p.w9_submitted_at) return { label: '📋 Pending Review', className: 'badge-pending' };
  if (p.w9_notification_sent_at)
    return { label: '⚠️ Notified — Not Filed', className: 'badge-blocked' };
  return { label: 'Not Required Yet', className: 'badge-not-filed' };
}

/**
 * Agent-type badge. Mirrors typeBadge() map EXACTLY (unknown type → raw value or '—').
 * NOTE: the static page interpolated the raw type into innerHTML on the fallback
 * branch (an XSS sink). Here `label` is rendered as JSX text → inert by construction.
 */
export function typeBadge(type: string | null | undefined): BadgeDescriptor {
  const map: Record<string, BadgeDescriptor> = {
    re_agent: { label: 'Real Estate Agent', className: 'badge-type-re' },
    insurance_agent: { label: 'Insurance', className: 'badge-type-ins' },
    home_inspector: { label: 'Inspector', className: 'badge-type-insp' },
    customer: { label: 'Customer', className: 'badge-type-cust' },
  };
  return map[type ?? ''] ?? { label: type || '—', className: 'badge-not-filed' };
}

/**
 * Payments status badge. Mirrors the inline ternary in renderTable():
 *   payments_blocked → 'Blocked' / badge-blocked
 *   else             → 'Enabled' / badge-verified
 */
export function paymentsBadge(p: ReferralAgent): BadgeDescriptor {
  return p.payments_blocked
    ? { label: 'Blocked', className: 'badge-blocked' }
    : { label: 'Enabled', className: 'badge-verified' };
}

// ── Action visibility predicates (mirror buildActions) ────────────────────────

/** View-W9 link shows when a W-9 file path exists. */
export function showViewW9(p: ReferralAgent): boolean {
  return !!p.w9_file_url;
}

/** Verify-W9 button shows when submitted but not yet verified. */
export function showVerifyW9(p: ReferralAgent): boolean {
  return !!p.w9_submitted_at && !p.w9_verified_at;
}

/** Manual-unblock button shows when blocked AND no W-9 submission (edge case). */
export function showUnblock(p: ReferralAgent): boolean {
  return !!p.payments_blocked && !p.w9_submitted_at;
}

// ── Write payloads — UNCHANGED CONTRACTS (Tier-3) ─────────────────────────────

export interface VerifyW9Payload {
  w9_verified_at: string;
}

/**
 * Build the verify-W9 UPDATE body. Field name + shape UNCHANGED from
 * admin-referrals.html verifyW9(): { w9_verified_at: new Date().toISOString() }.
 * The ISO timestamp is injected by the caller (page.tsx) to keep this pure.
 */
export function verifyW9Payload(nowIso: string): VerifyW9Payload {
  return { w9_verified_at: nowIso };
}

export interface UnblockPayload {
  payments_blocked: boolean;
}

/**
 * Build the manual-unblock UPDATE body. Shape UNCHANGED from
 * admin-referrals.html manualUnblock(): { payments_blocked: false }.
 */
export function unblockPayload(): UnblockPayload {
  return { payments_blocked: false };
}

// ── W-9 viewer contract — UNCHANGED (Tier-3) ──────────────────────────────────
/** Storage bucket for partner W-9 PDFs (admin-referrals.html viewW9). */
export const W9_BUCKET = 'partner-w9';
/** Signed-URL TTL in seconds (admin-referrals.html createSignedUrl(path, 60)). */
export const W9_SIGNED_URL_TTL_SECONDS = 60;

// ── Verbatim copy ─────────────────────────────────────────────────────────────
/**
 * Manual-unblock confirmation warning — ported BYTE-FOR-BYTE from
 * admin-referrals.html manualUnblock() confirm(...). Pinned in referrals.test.ts.
 */
export const UNBLOCK_CONFIRM_TEXT =
  'Manually unblock this partner without a W-9 on file? Only do this for grandfathered or exceptional cases.';
