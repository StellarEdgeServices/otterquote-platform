/**
 * Partner Dashboard — UI copy + verbatim Tier-3 legal/payout copy
 * (D-211 Phase 12, port of partner-dashboard.html → React /partner/dashboard).
 *
 * ⚠️ Tier-3 VERBATIM copy lives here and is ported BYTE-FOR-BYTE from the static
 * page (partner-dashboard.html @ main). It is pinned in dashboard.test.ts so any
 * reword/re-case/re-punctuation fails the build. This includes the W-9 / IRS
 * Form-W-9 legal copy (D-172) and the D-180 payout-approval partner-facing
 * status copy. Any wording change to these strings is Tier-3 → STOP and gate to
 * Dustin (mirrors the Phase-6 pre-approval copy lock).
 *
 * The remaining strings are non-legal UX copy (Tier-A/B), ported as-is.
 *
 * Cross-stack destinations: the no-partner-record bounce goes to the STATIC
 * /partner-re.html signup chooser (NOT yet migrated — coexistence); the
 * user-less bounce goes to the migrated React /login route.
 */

// ── Cross-stack / in-app destinations ─────────────────────────────────────────
/** User-less bounce target — the migrated React login route. */
export const LOGIN_ROUTE = '/login';
/**
 * No-partner-record bounce target — the STATIC signup chooser (partner-re.html).
 * Reached via a full-page navigation (window.location), NOT the Next router,
 * because it lives outside the React app (coexistence — do NOT build a React
 * signup chooser).
 */
export const PARTNER_SIGNUP_REDIRECT = '/partner-re.html';

/** IRS blank Form W-9 (D-172) — verbatim URL from the static page. */
export const IRS_W9_URL = 'https://www.irs.gov/pub/irs-pdf/fw9.pdf';

/** Public referral landing base — `ref.html?code=<unique_code|id>`. */
export const REFERRAL_LINK_BASE = 'https://otterquote.com/ref.html?code=';
/** Public recruit landing base — `recruit.html?code=<recruit_code>` (v36). */
export const RECRUIT_LINK_BASE = 'otterquote.com/recruit.html?code=';

// ── submit-partner-w9 Edge Function contract — UNCHANGED (Tier-3) ──────────────
/** EF name (POST ${SUPABASE_URL}/functions/v1/submit-partner-w9). */
export const W9_EF_NAME = 'submit-partner-w9';
/** Multipart form-data field carrying the W-9 PDF — byte-for-byte the static contract. */
export const W9_EF_FORM_FIELD = 'w9_file';

// ── W-9 status card — D-172 VERBATIM legal copy ───────────────────────────────
/**
 * The three W-9 card states + the IRS $600 disclosure, ported byte-for-byte from
 * renderW9Card() (partner-dashboard.html). Dynamic dates are interpolated by the
 * page; the surrounding phrasing here is the locked copy.
 */
export const W9_COPY = {
  verified: {
    title: 'W-9 Verified',
    // `Verified on ${date}. Commission payments are enabled.`
    bodyPrefix: 'Verified on ',
    bodySuffix: '. Commission payments are enabled.',
  },
  submitted: {
    title: 'W-9 Received — Under Review',
    // `Submitted on ${date}. Our team will review your W-9 and enable payments promptly.`
    bodyPrefix: 'Submitted on ',
    bodySuffix: '. Our team will review your W-9 and enable payments promptly.',
    replaceLink: 'Need to replace your W-9? Upload a new one',
  },
  actionRequired: {
    title: 'Action Required: Submit Your W-9',
    body:
      'Commission payments are held until we have a completed IRS Form W-9 on file. This is required by the IRS for any partner receiving $600 or more in referral payments per year.',
    uploadBtn: 'Upload W-9 PDF',
    irsLinkText: 'Download blank W-9 from IRS →',
  },
  uploadingText: 'Uploading…',
} as const;

// ── D-180 payout-approval badges — VERBATIM partner-facing payout copy ─────────
/**
 * The commission-row payout badges (shown alongside the commission amount).
 * Status meanings for partner display (deliberately NOT showing rejection_reason):
 *   pending_approval → amber "Pending — typically 5 days"
 *   rejected         → red "Under Review — our team will be in touch"
 *   approved / auto_approved / pre_approved → no badge.
 * Ported byte-for-byte from populateReferralsTable().
 */
export const PAYOUT_COPY = {
  pending: {
    label: 'Pending — typically 5 days',
    title: 'Your commission is pending approval — typically within 5 business days',
  },
  rejected: {
    label: 'Under Review — our team will be in touch',
    title: 'Your commission is under review — our team will be in touch',
  },
} as const;

// ── D-266 funnel-legality disclaimer ──────────────────────────────────────────────────
/**
 * D-266 — MANDATORY referral-fee legality disclaimer (VERBATIM, Dustin-dictated,
 * final — no paraphrase, no shortening). Ported byte-for-byte from the static
 * partner-dashboard.html referral-link block. Required on every partner funnel
 * surface. Any wording change is Tier-3 → STOP and gate to Dustin.
 */
export const REFERRAL_FEE_DISCLAIMER =
  'Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.';

// ── Recruit-link hint (payout disclosure) ─────────────────────────────────────
export const RECRUIT_LINK_HINT =
  'Share this with other professionals. When they sign up and their referrals close jobs, you earn $50 per job.';

/** Recruit-link "still generating" message when recruit_code is missing (pre-v36 backfill). */
export const RECRUIT_LINK_PENDING =
  'Your recruit link is being generated. Refresh the page in a moment.';

/** Recruit "Your Earnings" column tooltip ($10K threshold disclosure — D-139). */
export const RECRUIT_EARNINGS_TOOLTIP =
  'Paid on completed jobs over $10,000. Smaller jobs earn no recruit bonus.';

// ── Hero / static labels ──────────────────────────────────────────────────────
export const HERO_COPY = {
  referralLinkLabel: 'Your Referral Link',
  recruitLinkLabel: 'Your Recruit Link',
  copyLink: 'Copy Link',
  copied: 'Copied!',
} as const;

// ── Empty states ──────────────────────────────────────────────────────────────
export const EMPTY_STATES = {
  referrals: {
    icon: '🌟',
    title: 'No Referrals Yet',
    text:
      "You haven't made any referrals yet. Share your link or send it directly to a client above!",
  },
  recruits: {
    icon: '🤝',
    title: 'No Recruits Yet',
    text:
      "You haven't recruited any partners yet. Share your recruit link with other professionals to start earning recruit bonuses.",
  },
} as const;

// ── Quick Actions / marketing copy (non-legal, Tier-A) ────────────────────────
export const SECTION_HEADERS = {
  quickActions: 'Quick Actions',
  portfolio: 'Portfolio Report',
  recruitNetwork: 'Your Recruit Network',
  profile: 'Profile Settings',
} as const;
