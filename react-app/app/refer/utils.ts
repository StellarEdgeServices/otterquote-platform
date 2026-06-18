/**
 * Refer-a-Friend — pure logic (D-211 Phase 13).
 *
 * Framework-free, side-effect-free helpers extracted for unit testing.
 * All network / supabase calls live in page.tsx — never here.
 *
 * Port of refer-a-friend.html @ main behavior 1:1 (fetchOrCreateReferralCode /
 * displayReferralLink / populateReferralsTable / calculateSummary / the share
 * message builders / renderW9Banner gate), with the two documented bugs FOLDED:
 *
 *   BUG 1 (column-order render bug): the static table header is
 *     [Friend's Name | Date Referred | Status | Commission] but
 *     populateReferralsTable() rendered only THREE cells, transposed, with the
 *     Commission column missing entirely. Fixed: referralRowCells() returns all
 *     four cells in header order (see referralCommissionCell).
 *
 *   BUG 2 ($50 vs $200 commission mismatch): calculateSummary() computed
 *     `earned = completed * 50`, contradicting the $200 bonus stated everywhere
 *     on the page (title, hero, How-It-Works, FAQ, and the verbatim 1099 tax
 *     notice). Fixed: REFERRAL_COMMISSION_USD = 200 (see summarizeReferrals).
 *
 * §XSS: every value here is returned as plain data; JSX rendering in page.tsx is
 * inherently escaped (the static page used innerHTML/textContent assignment).
 */

// ── Constants ───────────────────────────────────────────────────────────────────

/** Public site origin — matches CONFIG.SITE_URL in js/config.js (hardcoded, as
 *  in the Phase-12 referralLinkFor precedent). */
export const PUBLIC_SITE_URL = 'https://otterquote.com';

/** Customer referral bonus, USD. BUG-2 FIX: $200 (the static summary used $50,
 *  contradicting every other $200 representation on the page). */
export const REFERRAL_COMMISSION_USD = 200;

/** referral_agents.agent_type for this (customer/homeowner) referral program. */
export const REFERRAL_AGENT_TYPE = 'customer';

/** generateCode() alphabet + length — byte-for-byte from the static page. */
export const REFERRAL_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const REFERRAL_CODE_LENGTH = 8;

/** Coming-soon redirect target when the homeowner launch gate is OFF (verbatim). */
export const COMING_SOON_REDIRECT = '/coming-soon.html?from=refer-a-friend&persona=homeowner';

// ── Data models (only the columns this page reads) ───────────────────────────

/** A row of the `referrals` table for a customer referrer (referrer_id = user.id). */
export interface CustomerReferral {
  id?: string;
  referee_email?: string | null;
  status?: string | null;
  created_at?: string | null;
  [key: string]: unknown;
}

/** The `referral_agents` row for a customer (agent_type = 'customer'). */
export interface CustomerReferralAgent {
  code?: string | null;
  agent_type?: string | null;
  payments_blocked?: boolean | null;
  w9_notification_sent_at?: string | null;
  w9_submitted_at?: string | null;
  [key: string]: unknown;
}

// ── Referral link + code ───────────────────────────────────────────────────────

/** Referral URL: `${siteUrl}/ref/${code}` — byte-for-byte from displayReferralLink(). */
export function referralUrl(code: string, siteUrl: string = PUBLIC_SITE_URL): string {
  return `${siteUrl}/ref/${code}`;
}

/**
 * Generate an 8-char A–Z0–9 code (generateCode()). `rand` is injectable so the
 * test is deterministic; defaults to Math.random in the page.
 */
export function generateReferralCode(rand: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    code += REFERRAL_CODE_CHARS.charAt(Math.floor(rand() * REFERRAL_CODE_CHARS.length));
  }
  return code;
}

// ── Referrals table cells (populateReferralsTable) — BUG-1 FIX ────────────────

/** "Friend's Name" cell: referee_email || '—' (static). */
export function referralFriendName(ref: Pick<CustomerReferral, 'referee_email'>): string {
  return ref.referee_email || '—';
}

/** "Date Referred" cell — `toLocaleDateString('en-US', {month,day,year})`; null -> '—'. */
export function referralDate(iso: string | null | undefined): string {
  return iso
    ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';
}

/** Status label: capitalize first letter (static), empty -> 'Pending'. */
export function referralStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Pending';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * Status -> CSS badge class, reproducing the static 3-way color logic
 * (`completed` -> green, `signed` -> amber, else -> gray):
 *   completed -> 'status-completed'; signed -> 'status-in-progress';
 *   else -> 'status-clicked'.
 */
export function referralStatusClass(status: string | null | undefined): string {
  if (status === 'completed') return 'status-completed';
  if (status === 'signed') return 'status-in-progress';
  return 'status-clicked';
}

/**
 * "Commission" cell — the column the static body row OMITTED (BUG 1). A referral
 * earns the $200 bonus when its job is `completed`; otherwise no commission yet.
 */
export function referralCommissionCell(status: string | null | undefined): string {
  return status === 'completed' ? `$${REFERRAL_COMMISSION_USD}` : '—';
}

/** All four table cells in header order [Friend, Date, Status, Commission]. */
export interface ReferralRowCells {
  friend: string;
  date: string;
  statusLabel: string;
  statusClass: string;
  commission: string;
}
export function referralRowCells(ref: CustomerReferral): ReferralRowCells {
  return {
    friend: referralFriendName(ref),
    date: referralDate(ref.created_at),
    statusLabel: referralStatusLabel(ref.status),
    statusClass: referralStatusClass(ref.status),
    commission: referralCommissionCell(ref.status),
  };
}

// ── Summary (calculateSummary) — BUG-2 FIX ───────────────────────────────

export interface ReferralSummary {
  total: number;
  completed: number;
  earned: number;
}

/**
 * Summary stats (calculateSummary). BUG-2 FIX: earned = completed *
 * REFERRAL_COMMISSION_USD ($200), not the static `completed * 50`.
 */
export function summarizeReferrals(referrals: CustomerReferral[]): ReferralSummary {
  const total = referrals.length;
  const completed = referrals.filter((r) => r.status === 'completed').length;
  const earned = completed * REFERRAL_COMMISSION_USD;
  return { total, completed, earned };
}

/** Summary line — byte-for-byte format from the static (`N referral(s) · M completed · $E earned`). */
export function referralSummaryLine(s: ReferralSummary): string {
  return `${s.total} referral${s.total !== 1 ? 's' : ''} · ${s.completed} completed · $${s.earned} earned`;
}

// ── W-9 banner gate (renderW9Banner) — D-172 ─────────────────────────────

/** Show the W-9 banner iff payments_blocked && notified && not-yet-submitted. */
export function shouldShowW9Banner(
  a: Pick<CustomerReferralAgent, 'payments_blocked' | 'w9_notification_sent_at' | 'w9_submitted_at'> | null | undefined,
): boolean {
  if (!a) return false;
  return Boolean(a.payments_blocked && a.w9_notification_sent_at && !a.w9_submitted_at);
}

// ── Homeowner coming-soon launch gate ────────────────────────────────────

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
  return `Hi there!\n\nI recently used Otter Quotes to get my roof replaced, and I wanted to share it with you. The platform is amazing — you get competing bids from multiple licensed, insured contractors, which means you get the best deal and can compare options side-by-side.\n\nIf you need any exterior work done (roof, siding, gutters, etc.), check out Otter Quotes here: ${url}\n\nBest regards`;
}

/** Email-signature badge HTML the user copies (rendered as TEXT in a code box; never injected). */
export function emailSignatureBadgeHtml(url: string, siteUrl: string = PUBLIC_SITE_URL): string {
  return `<a href="${url}" target="_blank" style="display: inline-block; padding: 8px 12px; background: #E07B00; color: #0D1B2E; text-decoration: none; border-radius: 8px; font-family: 'Rubik', sans-serif; font-size: 12px; font-weight: 600;">\n  <img src="${siteUrl}/img/otter-logo.svg" alt="Otter Quotes" style="width: 16px; height: 16px; margin-right: 4px; vertical-align: middle;">\n  <span>I trust Otter Quotes</span>\n</a>`;
}

export function facebookShareUrl(url: string, quote: string = FACEBOOK_SHARE_MESSAGE): string {
  return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}&quote=${encodeURIComponent(quote)}`;
}
