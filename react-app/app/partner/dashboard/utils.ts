/**
 * Partner Dashboard — pure logic (D-211 Phase 12).
 *
 * Framework-free, side-effect-free helpers extracted for unit testing.
 * All network / supabase calls live in page.tsx and lib/partner-record.ts —
 * never here.
 *
 * Port of partner-dashboard.html @ main behavior 1:1 (updateUI / renderW9Card /
 * loadStats / populateReferralsTable / loadRecruits / populateRecruitsTable /
 * the D-180 payout-badge map).
 *
 * ⚠️  W-9 / PAYOUT CONTRACTS — DO NOT TRANSFORM (Tier-3).
 * The referral_agents / referrals / payout_approvals reads, the submit-partner-w9
 * EF request shape, and the W-9/payout copy reproduce the static page byte-for-byte.
 *
 * §XSS: every value here is returned as plain data; JSX rendering in page.tsx is
 * inherently escaped. No HTML strings are built here (the static page used
 * innerHTML + escapeHtml(); the React port closes that sink by construction).
 */

import type { PartnerRecord } from '@/lib/partner-record';
import { PARTNER_DISPLAY_LABELS } from '@/lib/agent-types';

// ── Data models ───────────────────────────────────────────────────────────────

/** A row of the `referrals` table (the partner's own referrals). */
export interface PartnerReferral {
  id: string;
  homeowner_name?: string | null;
  homeowner_email?: string | null;
  created_at?: string | null;
  status?: string | null;
  job_value?: number | null;
  commission_amount?: number | null;
  recruit_commission_amount?: number | null;
  referral_agent_id?: string | null;
  [key: string]: unknown;
}

/** A recruited sub-partner: a `referral_agents` row with the per-row earnings tacked on. */
export interface RecruitRecord extends PartnerRecord {
  /** Sum of recruit_commission_amount across this recruit's referrals (page-computed). */
  _yourEarnings?: number;
}

/** A `payout_approvals` row (only the columns the dashboard reads). */
export interface PayoutApproval {
  referral_id?: string | null;
  status?: string | null;
  payout_type?: string | null;
  [key: string]: unknown;
}

// ── Gating decision (settled-gate; referral_agents-table-first) ───────────────

export type PartnerResolutionKind = 'pending' | 'ok' | 'no-record';
export type PartnerGateAction = 'loading' | 'bounce-login' | 'bounce-signup' | 'ready';

/**
 * The gating parity table (matches partner-dashboard.html init() ordering):
 *   - not settled                → 'loading'   (never act on the transient blank screen)
 *   - settled & no user          → 'bounce-login'  (→ React /login)
 *   - settled & user, unresolved → 'loading'
 *   - settled & user, no record  → 'bounce-signup' (→ STATIC /partner-re.html)
 *   - settled & user, record ok  → 'ready'
 */
export function partnerGateDecision(input: {
  settled: boolean;
  hasUser: boolean;
  resolution: PartnerResolutionKind;
}): PartnerGateAction {
  if (!input.settled) return 'loading';
  if (!input.hasUser) return 'bounce-login';
  if (input.resolution === 'no-record') return 'bounce-signup';
  if (input.resolution === 'ok') return 'ready';
  return 'loading';
}

// ── Hero / identity display ───────────────────────────────────────────────────

/** Welcome name: `[first, last]` joined, falsy dropped, else 'Agent' (updateUI). */
export function agentDisplayName(p: Pick<PartnerRecord, 'first_name' | 'last_name'>): string {
  return [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Agent';
}

/**
 * Partner badge label by agent_type (updateUI badge map). gh-914 single
 * source (@/lib/agent-types PARTNER_DISPLAY_LABELS) — previously a
 * hand-copied 4-of-6-key subset that silently omitted `adjuster`/`other`
 * (both fell through to the generic 'Partner' fallback instead of a real
 * label); importing the complete map fixes that omission as a side effect
 * of the refactor. Unknown / missing → 'Partner'.
 */
export function partnerBadgeLabel(agentType: string | null | undefined): string {
  return PARTNER_DISPLAY_LABELS[agentType as keyof typeof PARTNER_DISPLAY_LABELS] ?? 'Partner';
}

/** Referral link: `https://otterquote.com/ref.html?code=${unique_code || id}`. */
export function referralLinkFor(p: Pick<PartnerRecord, 'unique_code' | 'id'>): string {
  const code = p.unique_code || p.id;
  return `https://otterquote.com/ref.html?code=${code}`;
}

export interface RecruitLinkState {
  enabled: boolean;
  /** The link URL when enabled, or the "being generated" message when not. */
  text: string;
}

/**
 * Recruit link state (updateUI). When `recruit_code` is present → enabled link;
 * otherwise disabled with the "being generated" message (pre-v36 backfill).
 * The "being generated" copy is injected by the caller (copy.ts) to keep this pure.
 */
export function recruitLinkState(
  p: Pick<PartnerRecord, 'recruit_code'>,
  pendingMessage: string,
): RecruitLinkState {
  if (p.recruit_code) {
    return { enabled: true, text: `otterquote.com/recruit.html?code=${p.recruit_code}` };
  }
  return { enabled: false, text: pendingMessage };
}

// ── W-9 card state machine (renderW9Card) — D-172 ─────────────────────────────

export type W9CardState = 'hidden' | 'verified' | 'submitted' | 'action-required';

/**
 * Resolve the W-9 card state EXACTLY like renderW9Card():
 *   !payments_blocked && !w9_submitted_at → 'hidden'   (card not shown)
 *   w9_verified_at                        → 'verified'
 *   w9_submitted_at                       → 'submitted' (under review)
 *   else (blocked, no submission)         → 'action-required'
 * The priority order is checked top-to-bottom, matching the static branches.
 */
export function w9CardState(
  p: Pick<PartnerRecord, 'payments_blocked' | 'w9_submitted_at' | 'w9_verified_at'>,
): W9CardState {
  if (!p.payments_blocked && !p.w9_submitted_at) return 'hidden';
  if (p.w9_verified_at) return 'verified';
  if (p.w9_submitted_at) return 'submitted';
  return 'action-required';
}

/** Default-locale date label — mirrors `new Date(iso).toLocaleDateString()` in renderW9Card(). */
export function w9CardDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString();
}

// ── Referral table (populateReferralsTable) ───────────────────────────────────

/** Human-readable status labels (v7 schema). Fallback: the raw status. */
export const REFERRAL_STATUS_LABELS: Record<string, string> = {
  clicked: 'Clicked',
  registered: 'Registered',
  claim_submitted: 'Submitted',
  bid_received: 'Bid Received',
  contract_signed: 'Contract Signed',
  job_completed: 'Completed',
  commission_paid: 'Paid',
};

/** Status → CSS class. Fallback: 'status-clicked'. */
export const REFERRAL_STATUS_CLASS: Record<string, string> = {
  clicked: 'status-clicked',
  registered: 'status-registered',
  claim_submitted: 'status-submitted',
  bid_received: 'status-in-progress',
  contract_signed: 'status-in-progress',
  job_completed: 'status-completed',
  commission_paid: 'status-paid',
};

export function referralStatusLabel(status: string | null | undefined): string {
  return REFERRAL_STATUS_LABELS[status ?? ''] ?? (status ?? '');
}

export function referralStatusClass(status: string | null | undefined): string {
  return REFERRAL_STATUS_CLASS[status ?? ''] ?? 'status-clicked';
}

/** Client cell: homeowner_name || homeowner_email || 'Visitor'. */
export function referralClientName(ref: Pick<PartnerReferral, 'homeowner_name' | 'homeowner_email'>): string {
  return ref.homeowner_name || ref.homeowner_email || 'Visitor';
}

/** Referral date label — `toLocaleDateString('en-US', {month,day,year})`. */
export function referralDate(iso: string | null | undefined): string {
  return new Date(iso ?? '').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Money for table cells: falsy → '—', else `$${Number(n).toLocaleString()}`. */
export function fmtMoneyCell(n: number | null | undefined): string {
  return n ? `$${Number(n).toLocaleString()}` : '—';
}

// ── D-180 payout-approval badge ───────────────────────────────────────────────

export interface PayoutBadge {
  className: 'payout-badge-pending' | 'payout-badge-rejected';
  label: string;
  title: string;
}

/**
 * Map a payout_approvals.status to a partner-facing badge (or null = no badge).
 * The label/title copy is injected from copy.ts (PAYOUT_COPY) to keep this pure.
 *   pending_approval → pending badge
 *   rejected         → rejected badge
 *   else             → null (approved / auto_approved / pre_approved show no badge)
 */
export function payoutBadge(
  status: string | null | undefined,
  copy: {
    pending: { label: string; title: string };
    rejected: { label: string; title: string };
  },
): PayoutBadge | null {
  if (status === 'pending_approval') {
    return { className: 'payout-badge-pending', label: copy.pending.label, title: copy.pending.title };
  }
  if (status === 'rejected') {
    return { className: 'payout-badge-rejected', label: copy.rejected.label, title: copy.rejected.title };
  }
  return null;
}

/** Referral ids that need a payout-approval lookup (commission_amount > 0). */
export function referralIdsForPayout(referrals: PartnerReferral[]): string[] {
  return referrals.filter((r) => Number(r.commission_amount) > 0).map((r) => r.id);
}

/**
 * Build referral_id → status, newest-wins. Mirrors the static reducer: rows are
 * ordered created_at DESC, and the FIRST row seen for each referral_id wins
 * (`if (!map[id]) map[id] = status`).
 */
export function payoutStatusByReferral(approvals: PayoutApproval[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const a of approvals) {
    const id = a.referral_id;
    const status = a.status;
    if (id && status && !(id in map)) map[id] = status;
  }
  return map;
}

// ── Stats (loadStats) ─────────────────────────────────────────────────────────

export interface PartnerStats {
  total: number;
  active: number;
  completed: number;
  earned: number;
}

const ACTIVE_STATUSES = ['registered', 'claim_submitted', 'bid_received', 'contract_signed'];
const COMPLETED_STATUSES = ['job_completed', 'commission_paid'];

/**
 * Compute the four headline stats EXACTLY like loadStats():
 *   total     = partner.total_referrals || referrals.length
 *   active    = count(status ∈ registered|claim_submitted|bid_received|contract_signed)
 *   completed = count(status ∈ job_completed|commission_paid)
 *   earned    = partner.total_commission_earned
 *               || Σ commission_amount where status === 'commission_paid'
 */
export function computeStats(
  partner: Pick<PartnerRecord, 'total_referrals' | 'total_commission_earned'>,
  referrals: PartnerReferral[],
): PartnerStats {
  const total = Number(partner.total_referrals) || referrals.length;
  const active = referrals.filter((r) => ACTIVE_STATUSES.includes(r.status ?? '')).length;
  const completed = referrals.filter((r) => COMPLETED_STATUSES.includes(r.status ?? '')).length;
  const earned =
    Number(partner.total_commission_earned) ||
    referrals
      .filter((r) => r.status === 'commission_paid')
      .reduce((sum, r) => sum + (Number(r.commission_amount) || 0), 0);
  return { total, active, completed, earned };
}

/** `$${Number(n).toLocaleString('en-US', {min:0, max:0})}` — Total Earned / Recruit Earnings cards. */
export function fmtMoneyWhole(n: number): string {
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

/** Stat subtexts (pluralization), matching loadStats()/updateRecruitStats(). */
export function referralsSubtext(total: number): string {
  return total === 1 ? '1 referral' : `${total} referrals`;
}
export function activeSubtext(active: number): string {
  return active === 1 ? '1 active' : `${active} active`;
}
export function completedSubtext(completed: number): string {
  return completed === 1 ? '1 job' : `${completed} jobs`;
}
export function partnersRecruitedSubtext(count: number): string {
  return count === 1 ? '1 partner' : `${count} partners`;
}

// ── Recruits (loadRecruits / populateRecruitsTable / updateRecruitStats) ───────

/**
 * Recruit type labels. gh-914 single source (@/lib/agent-types
 * PARTNER_DISPLAY_LABELS) — previously a hand-copied 4-of-6-key subset that
 * silently omitted `adjuster`/`other`; importing the complete map fixes that
 * omission as a side effect of the refactor. Now the same map as the badge
 * label above (both source the static page's single AgentTypes.PARTNER_DISPLAY_LABELS
 * post-refactor — the pre-refactor `customer` divergence, 'Partner' here vs
 * 'Customer' there, was drift, not intentional design).
 */
export const RECRUIT_TYPE_LABELS: Record<string, string> = PARTNER_DISPLAY_LABELS;

export function recruitTypeLabel(agentType: string | null | undefined): string {
  return RECRUIT_TYPE_LABELS[agentType ?? ''] ?? 'Partner';
}

/** Recruit display name: `[first, last]` joined || email || 'Partner'. */
export function recruitName(
  r: Pick<RecruitRecord, 'first_name' | 'last_name' | 'email'>,
): string {
  return [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || 'Partner';
}

/**
 * Aggregate recruit earnings: sum recruit_commission_amount per referral_agent_id.
 * Mirrors loadRecruits()'s earningsByRecruit reducer — deliberately NOT count×$50
 * (that would include sub-$10K jobs that pay nothing; D-139).
 */
export function aggregateRecruitEarnings(paidRefs: PartnerReferral[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const r of paidRefs) {
    const id = r.referral_agent_id;
    if (!id) continue;
    map[id] = (map[id] || 0) + Number(r.recruit_commission_amount || 0);
  }
  return map;
}

export interface RecruitStats {
  count: number;
  earnings: number;
}

/**
 * Recruit summary (updateRecruitStats): count = recruits.length; earnings =
 * partner.recruit_earnings (the authoritative aggregate, NOT the per-row sum).
 */
export function recruitStats(
  partner: Pick<PartnerRecord, 'recruit_earnings'> | null | undefined,
  recruits: RecruitRecord[],
): RecruitStats {
  return {
    count: recruits.length,
    earnings: Number((partner && partner.recruit_earnings) || 0),
  };
}

/** Per-recruit "Your Earnings" cell: `$${Number(n).toLocaleString('en-US')}`. */
export function fmtRecruitEarnings(n: number): string {
  return `$${Number(n).toLocaleString('en-US')}`;
}

/**
 * Relative "signed up" label (formatRelativeDate). `nowMs` is injectable for
 * deterministic tests (defaults to the call-time clock in the page).
 *   invalid/empty → '—'; future → abs date; 0d → Today; 1d → Yesterday;
 *   <7d → "N days ago"; <30d → "N week(s) ago"; <365d → "N month(s) ago";
 *   else → "Mon YYYY".
 */
export function formatRelativeDate(dateStr: string | null | undefined, nowMs: number): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '—';
  const diffDays = Math.floor((nowMs - date.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) {
    const w = Math.floor(diffDays / 7);
    return `${w} week${w === 1 ? '' : 's'} ago`;
  }
  if (diffDays < 365) {
    const m = Math.floor(diffDays / 30);
    return `${m} month${m === 1 ? '' : 's'} ago`;
  }
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// ── submit-partner-w9 EF endpoint — UNCHANGED CONTRACT (Tier-3) ───────────────

/** Build the EF URL: `${supabaseUrl}/functions/v1/submit-partner-w9`. */
export function w9SubmitUrl(supabaseUrl: string): string {
  return `${supabaseUrl}/functions/v1/submit-partner-w9`;
}
