/**
 * Contractor Opportunities — UI copy + filter option catalogs (D-211 Phase 3).
 * Ported from contractor-opportunities.html. Non-legal marketing/UX copy
 * (Tier-A/B); no D-numbered or legal-locked strings on this page.
 */

import { bidRoutePath, renewBidRoutePath } from '../bid/[claimId]/copy';

export interface SelectOption {
  value: string;
  label: string;
}

export const OPP_COPY = {
  salesBanner:
    "Fully executed, ready-to-install contracts. Not referrals — we're your sales team that doesn't need a truck, a manager, or an advance.",
  pageTitle: 'Available Opportunities',
  pageSubtitle: 'Signed contracts in your service area',

  filterLabels: {
    jobType: 'Job Type',
    trade: 'Trade',
    material: 'Material',
    distance: 'Distance',
    sort: 'Sort By',
  },

  documentsLabel: 'Documents',
  lossSheetBtn: '📄 Loss Sheet',
  hoverPdfBtn: '📏 Hover PDF',
  loadingLabel: 'Loading…',
  lossSheetError: 'Unable to open the loss sheet. Please try again.',
  hoverPdfError:
    'Hover measurement PDF is not available for this project yet. The measurement may still be in progress.',
  notConnected: 'Not connected. Please refresh and try again.',

  detailsBtn: 'Details',
  submitBidBtn: 'Submit Bid',
  renewBidBtn: '🔄 Renew Bid',
  detailBidBtn: 'Bid on This Project →',
  detailClose: 'Close',
  viewScope: '📋 View Scope',
  homeownerNotesLabel: 'Homeowner Notes',

  expiredBidNotice:
    'Your previous bid on this project expired. Renew it to stay in contention.',

  // Empty state — zero base opportunities (new market, chicken-and-egg).
  emptyEarly: {
    headline: "You're in early.",
    headlineEm: 'The best contractors always are.',
    sub: "We're actively recruiting homeowners in your service area right now. The moment a matching project comes in, you'll be the first to know — we won't make you check back.",
    notifyPill: '📲 Text & email the instant a match drops — guaranteed.',
    checklistHeading: 'While you wait — lock in your spot:',
    items: [
      {
        label: 'Complete your contractor profile',
        desc: 'Homeowners review your profile before approving a bid. A complete profile wins more jobs.',
        linkText: 'Go to Profile →',
        href: '/contractor/profile',
      },
      {
        label: 'Upload your contract templates',
        desc: 'Pre-loaded contracts let you close in minutes. When a project drops, speed wins.',
        linkText: 'Upload Templates →',
        href: '/contractor/profile#templates',
      },
      {
        label: 'Confirm your service area & trade preferences',
        desc: 'Accurate settings mean we only ping you on jobs you actually want — no noise, no misses.',
        linkText: 'Update Settings →',
        href: '/contractor/settings',
      },
    ],
  },

  // Empty state — filters narrowed results to zero.
  emptyFiltered: {
    title: 'No opportunities match your filters',
    text: 'Try adjusting your filters to see more available projects.',
  },

  // D-178 parked state — contractor's registered state not yet open.
  parked: {
    headPrefix: "We're launching in ",
    headSuffix: ' soon.',
    sub: "You're on the list — we'll notify you the moment jobs become available in your area.",
    notifyPill: "📲 You'll be the first to know when we go live near you.",
  },
} as const;

// Deep-link targets into the bid form — FLIPPED to the React route /contractor/bid/[claimId]
// (D-211 Phase 7 / BF-2). Consumes the PR-1 route helpers (the single source of truth);
// the static contractor-bid-form.html base + quote_id query are no longer used — the React
// route resolves the existing quote from claim_id + contractor.
export function submitBidHref(claimId: string): string {
  return bidRoutePath(claimId);
}
export function renewBidHref(claimId: string, _expiredQuoteId?: string): string {
  return renewBidRoutePath(claimId);
}
export function detailBidHref(claimId: string): string {
  return bidRoutePath(claimId);
}

export const JOB_TYPE_OPTIONS: SelectOption[] = [
  { value: '', label: 'All Types' },
  { value: 'insurance_rcv', label: 'Insurance (RCV)' },
  { value: 'insurance_acv', label: 'Insurance (ACV)' },
  { value: 'retail', label: 'Retail / Cash' },
  { value: 'repair', label: 'Repair' },
];

export const TRADE_OPTIONS: SelectOption[] = [
  { value: '', label: 'All Trades' },
  { value: 'roofing', label: 'Roofing' },
  { value: 'siding', label: 'Siding' },
  { value: 'gutters', label: 'Gutters' },
  { value: 'windows', label: 'Windows' },
  { value: 'multi', label: 'Multi-Trade' },
];

export const MATERIAL_OPTIONS: SelectOption[] = [
  { value: '', label: 'All Materials' },
  { value: 'architectural', label: 'Architectural Shingle' },
  { value: 'designer', label: 'Designer Shingle' },
  { value: 'metal-seam', label: 'Metal Standing Seam' },
  { value: 'metal-fastener', label: 'Metal Exposed Fastener' },
];

export const DISTANCE_OPTIONS: SelectOption[] = [
  { value: '', label: 'All Distances' },
  { value: '10', label: 'Within 10 mi' },
  { value: '25', label: 'Within 25 mi' },
  { value: '50', label: 'Within 50 mi' },
];

export const SORT_OPTIONS: SelectOption[] = [
  { value: 'newest', label: 'Newest First' },
  { value: 'value-high', label: 'Highest Value' },
  { value: 'closest', label: 'Closest Distance' },
  { value: 'urgent-first', label: 'Urgent First' },
];
