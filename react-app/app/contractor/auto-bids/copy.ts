/**
 * Contractor Auto-Bid Settings — UI copy + option catalogs (D-211 Phase 3).
 * Ported from contractor-auto-bids.html. Non-legal marketing/UX + config copy
 * (Tier-A/B); no D-numbered or legal-locked strings on this page.
 */

export interface Opt {
  value: string;
  label: string;
}

export const AB_COPY = {
  pageTitle: 'Auto-Bid Settings',
  pageSubtitle:
    'Configure your auto-bid preferences for insurance roofing opportunities. When enabled, Otter Quotes places bids on your behalf for matching jobs in your service area.',

  pendingNotice:
    'Your contractor account is still under review. You can configure auto-bid now — it will start placing bids on your behalf once an admin approves your account.',

  cardTitle: 'Auto-Bid Settings',
  cardSubtitle:
    'When auto-bid is enabled, Otter Quotes will automatically place bids on your behalf for matching insurance full roof replacement opportunities in your service area.',
  toggleLabel: 'Enable Auto-Bid for Insurance Roofing',
  toggleSuffix: '(for RCV policies only)',
  statusOn: 'ACTIVE',
  statusOff: 'OFF',

  howItWorks:
    "When a homeowner in your service area submits an insurance claim for a full roof replacement, Otter Quotes will automatically place a bid on your behalf at the insurance company's approved RCV (Replacement Cost Value) amount plus any approved supplements. The homeowner sees your bid instantly and can sign a contract right away. You can manually generate a more tailored bid after reviewing the customer's request.",

  summaryTitle: 'Your Auto-Bid Will Match On:',
  summaryItems: [
    { k: 'Funding type:', v: 'RCV insurance claims only' },
    { k: 'Scope:', v: 'Full roof replacement only (not repairs)' },
    { k: 'Trade:', v: 'Roofing' },
    { k: 'Price:', v: 'RCV amount from the insurance estimate' },
    { k: 'Location:', v: 'Within your configured service area' },
  ],
  manageServiceAreaLabel: 'Manage service area →',
  manageServiceAreaHref: 'https://otterquote.com/contractor-profile.html',

  tip: "Auto-bid gives you a huge advantage. Homeowners are far more likely to sign when a contract is ready immediately. You can still manually bid on opportunities that don't match your auto-bid criteria.",

  previewToggleShow: '👁 See What My Auto Bid Looks Like',
  previewToggleHide: '▲ Hide Bid Preview',
  previewHeader: 'Sample Auto-Bid Preview — What the Homeowner Sees',
  previewBidSubtitle: 'Full Roof Replacement — RCV Insurance Bid',
  previewBidAmountLabel: 'Bid Amount',
  previewBidAmountValue: '$[RCV + Supplements]',
  previewIntro:
    'Thank you for considering {company}. Our team will review your request and send an updated bid if we can do something that better meets your needs. In the meantime, here is our standard offer for full roof replacements covered by RCV insurance policies. If this offer meets your needs, please sign our agreement and we will call you within 48 hours to get you on our calendar and finalize any other details.',
  previewAcvWarning: 'THIS OFFER IS NOT VALID FOR ACV POLICIES OR OUT OF POCKET JOBS.',
  previewIncludesHeading: "WHAT'S INCLUDED:",
  previewWarrantyHeading: 'Warranty:',
  previewEmpty: 'No items configured yet — fill out the sections above.',
  previewFootnote:
    '⚡ This bid is auto-generated at the RCV + supplements amount. Your contractor may adjust the bid after reviewing your specific claim details.',

  valueAddsHeading: "What's Included With Every Auto-Bid?",
  valueAddsWarning:
    'THESE ARE THE TERMS YOU OFFER CLIENTS FOR ANY FULL RCV ROOF. THE CLIENT WILL HAVE THE OPPORTUNITY TO ACCEPT YOUR CONTRACT WITH THESE TERMS. Do not include a benefit unless it is available for all roofs paid for by RCV policies. You can customize your offerings for specific jobs manually after reviewing the details of the job.',

  preferredShingleHeading: 'Preferred Shingle & Materials',
  preferredShingleHint:
    'Your preferred shingle is the product your auto-bid is based on. Warranty terms you set below apply to this shingle.',
  preferredBrandLabel: 'Preferred Shingle Brand',
  preferredBrandPlaceholder: 'e.g., GAF, Owens Corning, CertainTeed...',
  preferredLineLabel: 'Preferred Shingle Line / Product',
  preferredLinePlaceholder: 'e.g., Timberline HDZ, Duration, Landmark Pro...',

  otherShinglesHeading: 'Other Shingles Available',
  otherShinglesHint:
    'These shingles are available for install at the price the insurance is paying. Warranty terms may be different from those offered for your preferred shingle.',

  warrantyHeading: 'Warranty',
  warrantyHint:
    'Select the warranty types you offer and describe each one. Check a box to enable it and appear on your bid.',
  warrantyDisclaimerBanner:
    'Disclaimer (shown to homeowners): Warranty terms listed below apply only to your Preferred Shingle. Different warranty terms may apply if the homeowner selects a different shingle.',
  warrantyNotesLabel: 'Additional Warranty Notes',

  otherOffersHeading: 'Other Special Offers',
  otherOffersHint: 'Financing, extended warranties, free inspections, etc.',
  otherTradesHeading: 'Other Trades Covered by Insurance',
  otherTradesHint:
    'Which trades are you willing to perform if covered by insurance? These will appear on your bid so homeowners know what you can handle.',

  saveButton: 'Save Auto-Bid Settings',
  saving: 'Saving...',
  saved: 'Saved!',
  saveErrorNotConnected: 'Error — Not Connected',
  saveErrorRetry: 'Error — Try Again',

  futureTitle: 'Auto-Bid for Retail Jobs',
  futureBadge: 'Coming Soon',
  futureDescription:
    'Set custom pricing per material type for retail (non-insurance) roofing opportunities. Coming after insurance auto-bid is established.',
} as const;

// ── option catalogs ─────────────────────────────────────────────────────────

export const GUTTER_OPTIONS: Opt[] = [
  { value: 'none', label: 'Not included / N/A' },
  { value: '5inch_included', label: '5" gutters included (no out-of-pocket for homeowner)' },
  { value: '6inch_included', label: '6" gutters included (no out-of-pocket for homeowner)' },
  { value: 'other', label: 'Other' },
];

export const CHIMNEY_FLASHING_OPTIONS: Opt[] = [
  { value: 'na', label: 'N/A' },
  { value: 'replace', label: 'Replacement Included' },
];

export const GUTTER_GUARD_OPTIONS: Opt[] = [
  { value: 'insurance_covered', label: 'As covered by insurance or paid for by homeowner.' },
  { value: 'included', label: 'Included — Type:' },
  { value: 'other', label: 'Other' },
];

export const GUTTER_GUARD_TYPES: Opt[] = [
  { value: 'mesh', label: 'Mesh' },
  { value: 'screw_in', label: 'Screw-In' },
  { value: 'other', label: 'Other' },
];

export const CHIMNEY_REFLASH_OPTIONS: Opt[] = [
  { value: 'na', label: 'N/A' },
  { value: 'included', label: 'Included at no cost' },
  { value: 'oop', label: 'OOP cost of' },
];

export const UNDERLAYMENT_OPTIONS: Opt[] = [
  { value: 'synthetic', label: 'Synthetic' },
  { value: 'felt', label: 'Felt' },
];

export const STARTER_STRIP_OPTIONS: Opt[] = [
  { value: 'eaves', label: 'Eaves' },
  { value: 'rakes', label: 'Rakes' },
  { value: 'eaves_and_rakes', label: 'Eaves and Rakes' },
  { value: 'none', label: 'None' },
];

export const OTHER_TRADES_OPTIONS: Opt[] = [
  { value: 'siding_full', label: 'Siding (full replace)' },
  { value: 'siding_repair', label: 'Siding (repair)' },
  { value: 'gutters_full', label: 'Gutters (full replace)' },
  { value: 'gutters_repair', label: 'Gutters (repair)' },
  { value: 'interior_repairs', label: 'Interior repairs' },
  { value: 'paint', label: 'Paint' },
];

export interface WarrantyRowDef {
  key: 'materialDefects' | 'labor' | 'algae' | 'hail' | 'wind';
  label: string;
  placeholder: string;
}

export const WARRANTY_ROWS: WarrantyRowDef[] = [
  { key: 'materialDefects', label: 'Material Defects Warranty', placeholder: 'e.g., 30-year manufacturer warranty against material defects on GAF Timberline HDZ shingles.' },
  { key: 'labor', label: 'Labor Warranty', placeholder: 'e.g., 10-year workmanship warranty on all labor and installation.' },
  { key: 'algae', label: 'Algae Resistance Warranty', placeholder: 'e.g., 25-year algae resistance warranty on StainGuard Plus shingles.' },
  { key: 'hail', label: 'Hail Damage Warranty', placeholder: 'e.g., Class 4 impact-resistant shingles with 10-year hail warranty.' },
  { key: 'wind', label: 'Wind Damage Warranty', placeholder: 'e.g., 15-year wind warranty up to 130 mph with proper installation.' },
];

export interface ShingleBrand {
  brand: string;
  items: Opt[]; // value = "Brand|Line", label = display line
}

export const OTHER_SHINGLE_BRANDS: ShingleBrand[] = [
  {
    brand: 'GAF',
    items: [
      { value: 'GAF|Timberline HDZ', label: 'Timberline HDZ' },
      { value: 'GAF|Timberline UHDZ', label: 'Timberline UHDZ' },
      { value: 'GAF|Timberline CS', label: 'Timberline CS (Cool Series)' },
      { value: 'GAF|Camelot II', label: 'Camelot II' },
      { value: 'GAF|Grand Sequoia', label: 'Grand Sequoia' },
      { value: 'GAF|Grand Canyon', label: 'Grand Canyon' },
      { value: 'GAF|Sovereign', label: 'Sovereign' },
    ],
  },
  {
    brand: 'Owens Corning',
    items: [
      { value: 'Owens Corning|Duration', label: 'Duration' },
      { value: 'Owens Corning|Duration FLEX', label: 'Duration FLEX' },
      { value: 'Owens Corning|Duration Storm', label: 'Duration Storm' },
      { value: 'Owens Corning|TruDefinition Duration', label: 'TruDefinition Duration' },
      { value: 'Owens Corning|Oakridge', label: 'Oakridge' },
      { value: 'Owens Corning|Berkshire Collection', label: 'Berkshire Collection' },
    ],
  },
  {
    brand: 'CertainTeed',
    items: [
      { value: 'CertainTeed|Landmark', label: 'Landmark' },
      { value: 'CertainTeed|Landmark Pro', label: 'Landmark Pro' },
      { value: 'CertainTeed|Landmark Premium', label: 'Landmark Premium' },
      { value: 'CertainTeed|Landmark TL', label: 'Landmark TL' },
      { value: 'CertainTeed|Grand Manor', label: 'Grand Manor' },
      { value: 'CertainTeed|Carriage House', label: 'Carriage House' },
      { value: 'CertainTeed|Presidential Shake TL', label: 'Presidential Shake TL' },
    ],
  },
  {
    brand: 'Atlas',
    items: [
      { value: 'Atlas|StormMaster Slate', label: 'StormMaster Slate' },
      { value: 'Atlas|StormMaster Shake', label: 'StormMaster Shake' },
      { value: 'Atlas|ProLam AR', label: 'ProLam AR' },
      { value: 'Atlas|Pinnacle Pristine', label: 'Pinnacle Pristine' },
    ],
  },
  {
    brand: 'Malarkey',
    items: [
      { value: 'Malarkey|Legacy', label: 'Legacy' },
      { value: 'Malarkey|Vista', label: 'Vista' },
      { value: 'Malarkey|Windsor', label: 'Windsor' },
      { value: 'Malarkey|Highlander NEX', label: 'Highlander NEX' },
    ],
  },
  {
    brand: 'IKO',
    items: [
      { value: 'IKO|Dynasty', label: 'Dynasty' },
      { value: 'IKO|Cambridge', label: 'Cambridge' },
      { value: 'IKO|Nordic', label: 'Nordic' },
      { value: 'IKO|Crowne Slate', label: 'Crowne Slate' },
    ],
  },
  {
    brand: 'TAMKO',
    items: [
      { value: 'TAMKO|Heritage', label: 'Heritage' },
      { value: 'TAMKO|Heritage Vintage', label: 'Heritage Vintage' },
      { value: 'TAMKO|Heritage Woodgate', label: 'Heritage Woodgate' },
      { value: 'TAMKO|Elite Glass-Seal', label: 'Elite Glass-Seal' },
    ],
  },
];
