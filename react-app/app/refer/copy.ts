/**
 * Refer-a-Friend — UI copy + verbatim Tier-3 tax/legal copy
 * (D-211 Phase 13, port of refer-a-friend.html -> React /refer).
 *
 * This is the HOMEOWNER / CUSTOMER referral page (referral_agents.agent_type =
 * 'customer'), gated behind the homeowner coming-soon launch flag — distinct
 * from the partner program (Phase 12 /partner/dashboard). A customer refers
 * friends and earns a $200 referral fee per completed ($10K+) job.
 *
 * ⚠️ Tier-3 VERBATIM copy lives here and is ported BYTE-FOR-BYTE from the static
 * page (refer-a-friend.html @ main). It is pinned in refer.test.ts so any
 * reword / re-case / re-punctuation fails the build. This covers:
 *   - the Tax Reporting Notice (disclosure version 1099-misc-v1-2026-04; the 1099 filing sentence
 *     was removed under D-319 -- the taxes-are-yours / no-withholding sentences are kept)
 *   - the D-180 referral-fee approval disclosure (gh-3244: "commission" -> "referral fee", D-301)
 *   - the $200 / $10,000 referral-fee representations (hero, How-It-Works, FAQ)
 * Any wording change to these strings is Tier-3 -> STOP and gate to Dustin.
 *
 * The remaining strings are non-legal UX / marketing copy (Tier-A/B), ported
 * as-is. Share-message bodies (which interpolate the referral URL) live in utils.ts.
 */

// ── Cross-stack destinations ──────────────────────────────────────────────────
/** User-less bounce target — the migrated React login route. */
export const LOGIN_ROUTE = '/login';

/** #576/renderReferralCodeError() verbatim: shown when the
 *  get_or_create_customer_referral_code() RPC fails — never fabricate a fake
 *  code / broken /ref/<falsy> link instead. */
export const REFERRAL_CODE_ERROR_TEXT =
  "We couldn't generate your referral link right now. Please refresh the page — if this keeps happening, contact support@otterquote.com.";

// ── Hero ──────────────────────────────────────────────────────────────────────
export const HERO = {
  heading: 'Love Your Project Results? Share the Love — and Earn $200',
  // gh-3244: shown while the customer has not accepted Partner Agreement v4-2026-10 (refer-a-friend.html @ main,
  // gh-3245 fail-closed line). The unconditional subtitle below shows only once acceptance is confirmed.
  subtitlePreAcceptance:
    "Once you accept the Partner Agreement, you earn $200 for every friend you refer who completes a project of $10,000 or more through Otter Quotes. Share your unique link and we'll handle the rest.",
  subtitle:
    "For every friend you refer who completes a project of $10,000 or more through Otter Quotes, you earn $200. Share your unique link and we'll handle the rest.",
} as const;

// ── Partner Agreement v4 acceptance gate (gh-3244; wording from refer-a-friend.html @ main) ──
// A customer becomes a Partner only by accepting Partner Agreement v4-2026-10 (Agreement Section 1). No link is issued before then.
export const AGREEMENT_GATE = {
  heading: 'Accept the Partner Agreement to start earning',
  intro: 'Customers who refer friends join the Otter Quotes partner program and earn referral fees under the same Partner Agreement as every other partner.',
  timing: 'Referral fees apply to friends whose projects start after you accept.',
  checkboxPrefix: 'I agree to the Otter Quotes ',
  linkText: 'Partner Terms',
  linkHref: '/partner-agreement.html',
  checkboxSuffix: ' (Partner Agreement v4-2026-10).',
  button: 'Get My Referral Link',
  saving: 'Saving your acceptance…',
  error: 'We could not record your acceptance. Please try again, or contact support@otterquote.com.',
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
    badgeSub: 'Get your quote',
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
  { number: '3', title: 'You Earn $200', text: 'When their job completes ($10K or more), you earn a $200 referral fee.' },
] as const;

// ── FAQ ───────────────────────────────────────────────────────────────────────
export const FAQ_HEADING = 'Frequently Asked Questions';
export const FAQ = [
  {
    q: 'When do I get paid?',
    a: "Referral fees are paid after job completion and approval. We'll send payment via Venmo or PayPal, whichever you prefer.",
  },
  {
    q: 'Is there a limit to how many people I can refer?',
    a: "No limit! Refer as many people as you want. There's no cap on your referral earnings. The more friends and neighbors you share with, the more you can earn.",
  },
  {
    q: 'What if the job is under $10,000?',
    a: "Your referred friend still gets the full experience with no fee to use Otter Quotes — multiple competing bids, easy comparison, and quality assurance. You won't receive a referral fee for jobs under $10K, but you're still helping them get great bids.",
  },
] as const;

// ── 1099-MISC Tax Reporting Notice — ⚠️ Tier-3 VERBATIM (1099-misc-v1-2026-04) ──
export const TAX_NOTICE = {
  label: 'Tax Reporting Notice',
  version: '1099-misc-v1-2026-04',
  body:
    'Your $200 referral fee is taxable income. You are responsible for all applicable federal, state, and local taxes on referral income. Otter Quotes does not withhold taxes from referral fee payments. We recommend consulting a qualified tax professional if you have questions about your tax obligations.',
} as const;

// ── D-180 Commission Approval Disclosure — ⚠️ Tier-3 VERBATIM ──
// No stated timeline (gh-850 Survivor A, struck 2026-08-14 per Dustin's ~09:00 ET GO,
// "strike the payout timing everywhere") — matches the formulation already live on
// partner-re.html/partner-insurance.html/partner-inspectors.html (PR #812) and
// partner-agreement.html §4.2: paid after completion and approval, no interval promised.
export const COMMISSION_APPROVAL_DISCLOSURE =
  "Referral fee payments are subject to Otter Quotes' approval process. Referral fees are paid after job completion and approval.";

// ── D-266 Referral-fee legality disclaimer — ⚠️ Tier-3 VERBATIM ──
// MANDATORY on every referral funnel surface (Dustin-dictated, final — no
// paraphrase, no shortening). Ported byte-for-byte from the static page
// (refer-a-friend.html @ main), where it sits immediately after the D-180
// block; identical to react-app/app/partner/dashboard/copy.ts's constant of
// the same name. Any wording change is Tier-3 -> STOP and gate to Dustin.
export const REFERRAL_FEE_DISCLAIMER =
  'Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.';

// ── Referrals dashboard ───────────────────────────────────────────────────────
export const REFERRALS = {
  heading: 'Your Referrals',
  totalEarnedLabel: 'Total Earned',
  pendingLabel: 'Pending Payments',
  thFriend: "Friend's Name",
  thDate: 'Date Referred',
  thStatus: 'Status',
  thCommission: 'Referral Fee',
  empty: 'No referrals yet. Share your link above to start earning!',
} as const;
