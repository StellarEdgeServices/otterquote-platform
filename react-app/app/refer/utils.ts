/**
 * Refer-a-Friend — pure logic (D-211 Phase 13, re-ported #576).
 *
 * Framework-free, side-effect-free helpers extracted for unit testing.
 * All network / supabase calls live in page.tsx — never here.
 *
 * Port of refer-a-friend.html @ main behavior 1:1 (fetchOrCreateReferralCode /
 * loadReferrals / populateReferralsTable / calculateSummary / the share
 * message builders / renderW9Banner gate).
 *
 * #576: this file previously targeted an older static-page shape (a phantom
 * `referral_agents.code` column, `referrals.referrer_id`, client-side code
 * generation, a 3-status model). The static page has since moved twice more —
 * #567 (two-step referral_agents.id -> referrals.referral_agent_id resolution,
 * since referrals has no referrer_id) and v100/#624 (get_or_create_customer_
 * referral_code() SECURITY DEFINER RPC replaces the direct client insert,
 * which the D-211 2026-06-13 RLS lockdown made non-functional; unique_code is
 * trigger-generated, never client-supplied). This file now mirrors that
 * current shape, including the full 7-value referrals.status enum and the
 * paid/pending commission split (D-139 / #567), not just the two bugs an
 * earlier pass folded in.
 *
 * §XSS: every value here is returned as plain data; JSX rendering in page.tsx is
 * inherently escaped (the static page used innerHTML/textContent assignment).
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Public site origin — matches CONFIG.SITE_URL in js/config.js (hardcoded, as
 *  in the Phase-12 referralLinkFor precedent). */
export const PUBLIC_SITE_URL = 'https://otterquote.com';

/** Customer referral bonus, USD (D-139 / #567). */
export const REFERRAL_COMMISSION_USD = 200;

/** referral_agents.agent_type for this (customer/homeowner) referral program. */
export const REFERRAL_AGENT_TYPE = 'customer';

/** Coming-soon redirect target when the homeowner launch gate is OFF (verbatim). */
export const COMING_SOON_REDIRECT = '/coming-soon.html?from=refer-a-friend&persona=homeowner';

// ── Data models (only the columns this page reads) ────────────────────────────

/** A row of the `referrals` table for a customer referrer (own row resolved via
 *  referral_agents.id -> referrals.referral_agent_id — see #567; there is no
 *  referrer_id column). */
export interface CustomerReferral {
  id?: string;
  homeowner_name?: string | null;
  homeowner_email?: string | null;
  status?: string | null;
  created_at?: string | null;
  [key: string]: unknown;
}

/** The shape returned by the get_or_create_customer_referral_code() RPC
 *  (v100/#624) — never the raw referral_agents row; unique_code is
 *  trigger-generated and never client-supplied. */
export interface CustomerReferralAgent {
  unique_code?: string | null;
  payments_blocked?: boolean | null;
  w9_notification_sent_at?: string | null;
  w9_submitted_at?: string | null;
  created?: boolean;
  [key: string]: unknown;
}

// ── Referral link + code ──────────────────────────────────────────────────────

/** Referral URL: `${siteUrl}/ref/${code}` — byte-for-byte from getReferralUrl(). */
export function referralUrl(code: string, siteUrl: string = PUBLIC_SITE_URL): string {
  return `${siteUrl}/ref/${code}`;
}

// ── Referrals table cells (populateReferralsTable) ─────────────────────────────

/** All 7 referrals.status enum values -> friendly labels (static, verbatim). */
export const REFERRAL_STATUS_LABELS: Record<string, string> = {
  clicked: 'Clicked',
  registered: 'Signed Up',
  claim_submitted: 'Project Submitted',
  bid_received: 'Bids In',
  contract_signed: 'Contract Signed',
  job_completed: 'Job Completed',
  commission_paid: 'Commission Paid',
};

/** Same 7 statuses -> badge CSS classes (static, verbatim). */
export const REFERRAL_STATUS_CLASSES: Record<string, string> = {
  clicked: 'status-clicked',
  registered: 'status-registered',
  claim_submitted: 'status-submitted',
  bid_received: 'status-in-progress',
  contract_signed: 'status-in-progress',
  job_completed: 'status-completed',
  commission_paid: 'status-paid',
};

/** "Friend's Name" cell: homeowner_name || homeowner_email || positional
 *  fallback (both are nullable — static). */
export function referralFriendName(
  ref: Pick<CustomerReferral, 'homeowner_name' | 'homeowner_email'>,
  index: number,
): string {
  return ref.homeowner_name || ref.homeowner_email || `Referral #${index + 1}`;
}

/** "Date Referred" cell — `toLocaleDateString('en-US', {month,day,year})`; null -> '—'. */
export function referralDate(iso: string | null | undefined): string {
  return iso
    ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';
}

/** Status -> friendly label; unrecognized/empty -> 'Pending' (static). */
export function referralStatusLabel(status: string | null | undefined): string {
  return (status && REFERRAL_STATUS_LABELS[status]) || 'Pending';
}

/** Status -> CSS badge class; unrecognized/empty -> 'status-clicked' (static). */
export function referralStatusClass(status: string | null | undefined): string {
  return (status && REFERRAL_STATUS_CLASSES[status]) || 'status-clicked';
}

/**
 * "Commission" cell — a referral earns the $200 bonus once its job has
 * completed (accrued, `job_completed`) or been paid out (`commission_paid`);
 * otherwise no commission yet (static).
 */
export function referralCommissionCell(status: string | null | undefined): string {
  return status === 'job_completed' || status === 'commission_paid'
    ? `$${REFERRAL_COMMISSION_USD}`
    : '—';
}

/** All four table cells in header order [Friend, Date, Status, Commission]. */
export interface ReferralRowCells {
  friend: string;
  date: string;
  statusLabel: string;
  statusClass: string;
  commission: string;
}
export function referralRowCells(ref: CustomerReferral, index: number): ReferralRowCells {
  return {
    friend: referralFriendName(ref, index),
    date: referralDate(ref.created_at),
    statusLabel: referralStatusLabel(ref.status),
    statusClass: referralStatusClass(ref.status),
    commission: referralCommissionCell(ref.status),
  };
}

// ── Summary (calculateSummary) — D-139 / #567 paid/pending split ──────────────

export interface ReferralSummary {
  total: number;
  /** paid + completedUnpaid — both count toward the "completed" stat line. */
  completed: number;
  /** paid * $200 only — matches the static "Total Earned" box + summary line. */
  earned: number;
  /** completedUnpaid (job_completed, not yet paid) * $200 — "Pending Payments" box. */
  pending: number;
}

/**
 * Summary stats (calculateSummary). `job_completed` has accrued but not yet
 * been paid out; `commission_paid` is paid. Earned counts paid only —
 * pending is tracked separately, matching the static split.
 */
export function summarizeReferrals(referrals: CustomerReferral[]): ReferralSummary {
  const total = referrals.length;
  const paid = referrals.filter((r) => r.status === 'commission_paid').length;
  const completedUnpaid = referrals.filter((r) => r.status === 'job_completed').length;
  const completed = paid + completedUnpaid;
  const earned = paid * REFERRAL_COMMISSION_USD;
  const pending = completedUnpaid * REFERRAL_COMMISSION_USD;
  return { total, completed, earned, pending };
}

/** Summary line — byte-for-byte format from the static (`N referral(s) · M completed · $E earned`). */
export function referralSummaryLine(s: ReferralSummary): string {
  return `${s.total} referral${s.total !== 1 ? 's' : ''} · ${s.completed} completed · $${s.earned} earned`;
}

// ── W-9 banner gate (renderW9Banner) — D-172 ──────────────────────────────────

/** Show the W-9 banner iff payments_blocked && notified && not-yet-submitted. */
export function shouldShowW9Banner(
  a: Pick<CustomerReferralAgent, 'payments_blocked' | 'w9_notification_sent_at' | 'w9_submitted_at'> | null | undefined,
): boolean {
  if (!a) return false;
  return Boolean(a.payments_blocked && a.w9_notification_sent_at && !a.w9_submitted_at);
}

// ── Homeowner coming-soon launch gate ─────────────────────────────────────────

/**
 * Homeowner launch gate (mirrors `!CONFIG.HOMEOWNER_LAUNCH_ENABLED` in the static
 * <head>). The static config flag is currently `true` (open). In React the value
 * comes from NEXT_PUBLIC_HOMEOWNER_LAUNCH_ENABLED; UNSET / anything other than the
 * string 'false' => enabled (preserving the current open state). Only the literal
 * 'false' re-gates the page to /coming-soon.html.
 */
export function isHomeownerLaunchEnabled(envValue: string | undefined): boolean {
  return envValue !== 'false';
}

// ── Share-message builders (verbatim marketing copy; URL-interpolated) ─────────

/** Fixed Facebook share quote (no URL) — verbatim. */
export const FACEBOOK_SHARE_MESSAGE =
  'I just got my roof replaced through Otter Quotes — multiple contractors competed for the job and I got a great deal. Check it out if you need any exterior work done!';

export function smsShareMessage(url: string): string {
  return `Hey! I just got my roof done through Otter Quotes — they had multiple contractors compete for the job. If you need any exterior work done, check them out: ${url}`;
}

export function nextdoorShareMessage(url: string): string {
  return `Just got my roof replaced through Otter Quotes. Four contractors competed for the job, and I got to compare bids side-by-side. If anyone in the neighborhood needs exterior work done (roof, siding, gutters), I'd recommend checking them out: ${url}`;
}

export const EMAIL_SHARE_SUBJECT = 'Check out Otter Quotes — best way to get contractor quotes';

export function emailShareBody(url: string): string {
  return `Hi there!\n\nI recently used Otter Quotes to get my roof replaced, and I wanted to share it with you. The platform is amazing — you get competing bids from multiple licensed, insured contractors, which means you get the best deal and can compare options side-by-side.\n\nIf you need any exterior work done (roof, siding, gutters, etc.), check out Otter Quotes here:\n\n${url}\n\nBest regards`;
}

/** Email-signature badge HTML the user copies (rendered as TEXT in a code box; never injected). */
export function emailSignatureBadgeHtml(url: string, siteUrl: string = PUBLIC_SITE_URL): string {
  return `<a href="${url}" target="_blank" style="display: inline-block; padding: 8px 12px; background: #E07B00; color: #0D1B2E; text-decoration: none; border-radius: 8px; font-family: 'Rubik', sans-serif; font-size: 12px; font-weight: 600;">\n  <img src="${siteUrl}/img/otter-logo.svg" alt="Otter Quotes" style="width: 16px; height: 16px; margin-right: 4px; vertical-align: middle;">\n  <span>I trust Otter Quotes</span>\n</a>`;
}

export function facebookShareUrl(url: string, quote: string = FACEBOOK_SHARE_MESSAGE): string {
  return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}&quote=${encodeURIComponent(quote)}`;
}
