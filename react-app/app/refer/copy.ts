/**
 * Refer-a-Friend — UI copy + verbatim Tier-3 tax/legal copy
 * (D-211 Phase 13, port of refer-a-friend.html -> React /refer).
 *
 * This is the HOMEOWNER / CUSTOMER referral page (referral_agents.agent_type =
 * 'customer'), gated behind the homeowner coming-soon launch flag — distinct
 * from the partner program (Phase 12 /partner/dashboard). A customer refers
 * friends and earns a $200 bonus per completed ($10K+) job.
 *
 * ⚠️ Tier-3 VERBATIM copy lives here and is ported BYTE-FOR-BYTE from the static
 * page (refer-a-friend.html @ main). It is pinned in refer.test.ts so any
 * reword / re-case / re-punctuation fails the build. This covers:
 *   - the 1099-MISC Tax Reporting Notice (disclosure version 1099-misc-v1-2026-04)
 *   - the FAQ tax answer (1099-MISC / $600 / Jan 31)
 *   - the D-180 commission-approval disclosure
 *   - the D-172 W-9 "required before payment" banner
 *   - the $200 / $10,000 commission representations (hero, How-It-Works, FAQ)
 * Any wording change to these strings is Tier-3 -> STOP and gate to Dustin.
 *
 * The remaining strings are non-legal UX / marketing copy (Tier-A/B), ported
 * as-is. Share-message bodies (which interpolate the referral URL) live in utils.ts.
 */

// ── Cross-stack destinations ──────────────────────────────────────────────────
/** User-less bounce target — the migrated React login route. */
export const LOGIN_ROUTE = '/login';
/** D-172 banner deep-link — the STATIC partner dashboard W-9 upload anchor. */
export const W9_UPLOAD_LINK = '/partner-dashboard.html#w9Upload';

/** #576/renderReferralCodeError() verbatim: shown when the
 *  get_or_create_customer_referral_code() RPC fails — never fabricate a fake
 *  code / broken /ref/<falsy> link instead. */
export const REFERRAL_CODE_ERROR_TEXT =
  "We couldn't generate your referral link right now. Please refresh the page — if this keeps happening, contact support@otterquote.com.";

// ── Hero ──────────────────────────────────────────────────────────────────────
export const HERO = {
  heading: 'Love Your Project Results? Share the Love — and Earn $200',
  subtitle:
    "For every friend you refer who completes a project of $10,000 or more through Otter Quotes, you earn $200. Share your unique link and we'll handle the rest.",
} as const;

export const REFERRAL_LINK_LABEL = 'Your Unique Referral Link';
export const QR_HEADING = 'Or scan this QR code';
export const COPY_LINK_LABEL = 'Copy Link';
export const COPIED_LABEL = 'Copied!';
export const SHARE_LABEL = 'Share';

// ── Share section ─────────────────────────────────────────────────────────────
export const SHARE_HEADING = 'Share Your Referral';

export const SHARE_CARDS = {
  facebook: {
    title: 'Share to Facebook',
    description: 'Post your referral link to your Facebook feed and reach friends and family.',
    button: 'Share to Facebook',
    photoHeading: '📸 Upload Before & After Photos (Optional)',
    photoText: 'Add your project photos to create a branded share card.',
    downloadButton: 'Download Image',
    downloadHint: 'Share the downloaded image on Facebook manually',
    previewLabel: 'Preview of your share card',
  },
  sms: {
    title: 'Text a Neighbor',
    description: 'Send an SMS message to friends and neighbors with your referral link.',
    button: 'Send Text',
    copyButton: 'Copy Message',
  },
  nextdoor: {
    title: 'Share on Nextdoor',
    description: 'Share your experience with neighbors on Nextdoor.',
    button: 'Copy Post',
    openLink: 'Open Nextdoor ↗',
    openHref: 'https://nextdoor.com/',
  },
  email: {
    title: 'Email a Friend',
    description: 'Send an email with your referral link and a personal message.',
    button: 'Send Email',
    copyButton: 'Copy Email Text',
  },
  badge: {
    title: 'Email Signature Badge',
    description: 'Add a professional Otter Quotes badge to your email signature.',
    badgeTrust: 'I trust Otter Quotes',
    badgeSub: 'Get your free quote',
    copyButton: 'Copy HTML',
    instructionsTitle: 'How to add to your email signature:',
    gmail: 'Gmail: Settings → See all settings → Signature → Paste the HTML',
    outlook: 'Outlook: File → Options → Mail → Signatures → Paste the HTML',
  },
} as const;

// ── How It Works ──────────────────────────────────────────────────────────────
export const HOW_IT_WORKS_HEADING = 'How It Works';
export const HOW_IT_WORKS = [
  { number: '1', title: 'Share Your Link', text: 'Share your unique referral link with friends, family, or neighbors.' },
  { number: '2', title: 'They Get Competing Bids', text: 'They receive competing bids from contractors for their project.' },
  { number: '3', title: 'You Earn $200', text: 'When their job completes ($10K or more), you earn $200 in commission.' },
] as const;

// ── FAQ ───────────────────────────────────────────────────────────────────────
export const FAQ_HEADING = 'Frequently Asked Questions';
export const FAQ = [
  {
    q: 'When do I get paid?',
    a: "You'll receive payment after the referred job is completed and the homeowner's contractor has been paid. We'll send payment via bank transfer or check, whichever you prefer.",
  },
  {
    q: 'Is there a limit to how many people I can refer?',
    a: "No limit! Refer as many people as you want. There's no cap on your referral earnings. The more friends and neighbors you share with, the more you can earn.",
  },
  {
    q: 'What if the job is under $10,000?',
    a: "Your referred friend still gets the full Otter Quotes experience for free — multiple competing bids, easy comparison, and quality assurance. You won't receive a cash commission for jobs under $10K, but you're still helping them get great bids.",
  },
  {
    // ⚠️ Tier-3 — tax/legal (1099-MISC). VERBATIM.
    q: 'Will I receive a tax form for my referral bonuses?',
    a: 'Yes — referral bonuses are taxable income. If you receive $600 or more in bonuses from Otter Quotes in a calendar year, we are required to report those payments to the IRS and will issue you a Form 1099-MISC. You will receive a copy no later than January 31 of the following year. You are responsible for all applicable federal, state, and local taxes on referral income. We recommend consulting a tax professional regarding your specific situation.',
  },
] as const;

// ── 1099-MISC Tax Reporting Notice — ⚠️ Tier-3 VERBATIM (1099-misc-v1-2026-04) ──
export const TAX_NOTICE = {
  label: 'Tax Reporting Notice',
  version: '1099-misc-v1-2026-04',
  body:
    'Your $200 referral bonus is taxable income. If you receive $600 or more in referral bonuses from Otter Quotes in a calendar year, we are required by federal law to file a Form 1099-MISC with the IRS reporting those payments, and to provide you a copy no later than January 31 of the following year. You are responsible for all applicable federal, state, and local taxes on referral income. Otter Quotes does not withhold taxes from bonus payments. We recommend consulting a qualified tax professional if you have questions about your tax obligations.',
} as const;

// ── D-180 Commission Approval Disclosure — ⚠️ Tier-3 VERBATIM ──
// No stated timeline (gh-850 Survivor A, struck 2026-08-14 per Dustin's ~09:00 ET GO,
// "strike the payout timing everywhere") — matches the formulation already live on
// partner-re.html/partner-insurance.html/partner-inspectors.html (PR #812) and
// partner-agreement.html §4.2: paid after completion and approval, no interval promised.
export const COMMISSION_APPROVAL_DISCLOSURE =
  "Commission payments are subject to Otter Quotes' approval process and are paid after the qualifying job is complete and the payout has been approved.";

// ── D-266 Referral-fee legality disclaimer — ⚠️ Tier-3 VERBATIM ──
// MANDATORY on every referral funnel surface (Dustin-dictated, final — no
// paraphrase, no shortening). Ported byte-for-byte from the static page
// (refer-a-friend.html @ main), where it sits immediately after the D-180
// block; identical to react-app/app/partner/dashboard/copy.ts's constant of
// the same name. Any wording change is Tier-3 -> STOP and gate to Dustin.
export const REFERRAL_FEE_DISCLAIMER =
  'Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.';

// ── D-172 W-9 banner — ⚠️ Tier-3 VERBATIM ──
export const W9_BANNER = {
  title: 'W-9 Required Before Payment',
  body: "Your referral generated a commission, but it's on hold until we receive your W-9.",
  link: 'Upload your W-9 in your partner dashboard →',
} as const;

// ── Referrals dashboard ───────────────────────────────────────────────────────
export const REFERRALS = {
  heading: 'Your Referrals',
  totalEarnedLabel: 'Total Earned',
  pendingLabel: 'Pending Payments',
  thFriend: "Friend's Name",
  thDate: 'Date Referred',
  thStatus: 'Status',
  thCommission: 'Commission',
  empty: 'No referrals yet. Share your link above to start earning!',
} as const;
