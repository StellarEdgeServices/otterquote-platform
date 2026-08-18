/**
 * Contractor Profile — UI copy + catalogs (D-211 Phase 4, port of contractor-profile.html).
 * Non-legal marketing/UX copy (Tier-A/B). The D-202/D-204 explanatory strings are
 * product copy ported verbatim from the static page; no D-244-style locked legal copy
 * lives on this page.
 */

export const PROFILE_COPY = {
  pageTitle: 'Your Contractor Profile',

  company: {
    title: 'Company Information',
    edit: 'Edit Company Info',
    save: 'Save Changes',
    cancel: 'Cancel',
    saveError: 'Failed to save changes. Please try again.',
    notConnected: 'Unable to save — not connected to database.',
  },

  photos: {
    title: 'Photos',
    edit: 'Edit Photos',
    save: 'Save Photos',
    cancel: 'Cancel',
    ownerLabel: 'Owner / Team Photo',
    uploadError: 'Failed to upload photo. Please try again.',
  },

  introVideo: {
    title: 'Intro Video',
    edit: 'Edit Intro Video',
    save: 'Save Video',
    cancel: 'Cancel',
    help: 'Upload a short intro video (MP4 or MOV, max 200 MB) shown to homeowners on your public profile.',
    choose: 'Please choose a video file.',
    uploading: 'Uploading…',
    saved: 'Saved.',
    uploadFailed: 'Upload failed. Please try again.',
    disabled: "Intro video uploads aren't enabled yet. Check back soon.",
  },

  credentials: {
    title: 'Credentials & Verification',
    edit: 'Edit Insurance & Certifications',
    saveInsurance: 'Save Insurance Info',
    close: 'Close',
    insuranceSaved: 'Insurance information saved.',
    saveError: 'Failed to save changes. Please try again.',
    licenseLabelPrefix: 'Contractor License — ',
    licenseGeneral: 'General',
    licenseOnFile: 'On file',
    verified: 'Verified',
    pendingVerification: 'Pending Verification',
    noLicenseRequired: 'No municipal license required in service area',
    noLicenses: 'No licenses on file',
    wcLabel: "Workers' Compensation Insurance",
    glLabel: 'General Liability Insurance',
    onFile: '✓ On File',
    notOnFile: 'Not on File',
    certsLabel: 'Certifications',
    noCerts: 'No certifications added',
    addCertPlaceholder: 'e.g., GAF Master Elite Contractor',
    addCertBtn: 'Add Certification',
    removeBtn: 'Remove',
    addCertError: 'Failed to add certification. Please try again.',
    removeCertError: 'Failed to remove certification. Please try again.',
  },

  reviews: {
    title: 'Reviews & Ratings',
    edit: 'Edit Review Links',
    save: 'Save Links',
    cancel: 'Cancel',
    notProvided: 'Not provided',
    fields: [
      { id: 'google_reviews_url', label: 'Google Reviews', text: 'View on Google', placeholder: 'https://google.com/...' },
      { id: 'bbb_url', label: 'Better Business Bureau (BBB)', text: 'View on BBB', placeholder: 'https://bbb.org/...' },
      { id: 'angi_url', label: "Angi (Formerly Angie's List)", text: 'View on Angi', placeholder: 'https://angi.com/...' },
      { id: 'yelp_url', label: 'Yelp', text: 'View on Yelp', placeholder: 'https://yelp.com/...' },
    ] as { id: string; label: string; text: string; placeholder: string }[],
  },

  serviceArea: {
    title: 'Service Area & Trades',
    edit: 'Edit Service Area',
    save: 'Save Changes',
    cancel: 'Cancel',
    saved: 'Service area saved.',
    saveError: 'Failed to save changes. Please try again.',
    tradesLabel: 'Primary Trades',
    brandsLabel: 'Preferred Shingle Brands',
    areaLabel: 'Service Area',
    intro: 'Select the states you serve. For each state, choose full state coverage or specific counties.',
    entireState: 'Entire State',
    specificCounties: 'Specific Counties',
    loadingCounties: 'Loading counties…',
    countiesError: 'Could not load counties. Check your connection and try again.',
    selectAll: 'Select All',
    clearAll: 'Clear All',
  },

  certVerifications: {
    title: 'Manufacturer Certifications',
    intro:
      "Upload your manufacturer certification letters here. Each verified cert unlocks the matching warranty tier in your bids per D-202. Otter Quotes verifies each cert against the manufacturer's public lookup or by admin review of your uploaded letter (D-204).",
    add: 'Add a Manufacturer Certification',
    cancel: 'Cancel',
    empty:
      'No manufacturer certifications on file. Add one below to unlock matching warranty tiers in your bids.',
    manufacturerLabel: 'Manufacturer',
    manufacturerPlaceholder: '— Select manufacturer —',
    tierLabel: 'Certification Tier',
    tierPlaceholderFirst: '— Select manufacturer first —',
    tierPlaceholder: '— Select tier —',
    tierHelp:
      'Only tiers that require certification appear here. "Standard" tiers (no cert required) are always available in your bids.',
    fileLabel: 'Cert Letter (PDF or image, max 10MB)',
    fileHelp: 'Upload the certification letter you received from the manufacturer. Admin reviews and approves within 1–2 business days.',
    submit: 'Submit for Review',
    selectFirst: 'Select a manufacturer and tier first.',
    attachFile: 'Attach your cert letter (PDF or image).',
    notConnected: 'Not connected.',
    submitting: 'Submitting for review…',
    uploading: 'Uploading…',
    submitted: 'Submitted ✓ Admin will review within 1–2 business days.',
    verifiedTag: 'VERIFIED',
  },

  contractTemplates: {
    title: 'Contract Templates',
    intro:
      'Upload your contract template for each type of work. Otter Quotes will auto-populate your company details and get it signed by the homeowner. The contract is sent for e-signature.',
    autofillHeading: 'Auto-Fill Fields Detected',
    autofillIntro: 'Otter Quotes scans your contract for these labels and auto-fills the corresponding data:',
    autofillTip:
      'Tip: Include these exact labels in your contract to enable auto-fill. Fields not found will be left blank for manual entry. After uploading a template, click Review Mapping to customize which labels Otter Quotes looks for.',
    loading: 'Loading templates...',
    noTemplate: 'No template uploaded',
    uploadTemplate: 'Upload Template',
    uploadHint: 'PDF format, max 10MB',
    view: 'View',
    reviewMapping: 'Review Mapping',
    replace: 'Replace',
    uploadedPrefix: 'Uploaded: ',
    uploadFailed: 'Failed to upload template. Please try again.',
    viewError: 'Unable to open template. Please try uploading again or contact support.',
    // gh-590: two-dropdown upload control + grouped list + multi-slot assignment.
    contractTypeLabel: 'Contract Type',
    contractTypeRetail: 'Retail',
    contractTypeInsurance: 'Insurance',
    tradeLabel: 'Trade',
    tradePlaceholder: 'Select trade…',
    contractTypePlaceholder: 'Select type…',
    uploadNewHeading: 'Upload a new contract',
    chooseFile: 'Choose File',
    assign: 'Assign to another slot',
    assignAction: 'Assign',
    assignTargetLabel: 'Assign this file to',
    assignNoSlots: 'All other slots already have a template. Remove one first, or use Replace on this slot.',
    assignFailed: 'Failed to assign template to that slot. Please try again.',
    removeAssignment: 'Remove assignment',
    removeConfirm: 'Remove this assignment? The uploaded file stays available on any other slot it is assigned to.',
    removeFailed: 'Failed to remove assignment. Please try again.',
    cancel: 'Cancel',
  },

  pcTemplates: {
    title: 'Project Confirmation Templates',
    intro:
      'Upload a project confirmation PDF template for each trade and funding type. After a homeowner signs the main contract, Otter Quotes selects the matching template and sends it to capture full scope details — structures, colors, materials, skylights, and work authorizations. Otter Quotes auto-fills homeowner name and property address before sending for e-signature.',
    warning:
      '⚠️ Templates are per-trade and per-funding type — your confirmation docs differ by trade and by insurance vs. retail, just like your contracts. Upload the right template into each slot you use.',
    loading: 'Loading templates…',
    noTemplate: 'No template uploaded',
    uploadTemplate: 'Upload Template',
    uploadHint: 'PDF format, max 10MB',
    view: 'View',
    replace: 'Replace',
    uploadedPrefix: 'Uploaded: ',
    uploadFailed: 'Failed to upload template. Please try again.',
    viewError: 'Unable to open template. Please try again.',
  },

  fieldMapping: {
    title: 'Review Field Mapping',
    intro:
      'Otter Quotes searches your PDF for the label text in the left column and replaces it with the Otter Quotes data shown on the right. If your contract uses different label text, update the left column to match exactly.',
    leftHeading: 'Label in Your Contract',
    rightHeading: 'Otter Quotes Data',
    reset: 'Reset to Defaults',
    save: 'Save Mapping',
    saved: '✅ Field mapping saved.',
    saveError: 'Error saving. Please try again.',
    notConnected: 'Not connected to database.',
  },

  stats: {
    title: 'Platform Statistics',
    jobsLabel: 'Otter Quotes Jobs',
  },
} as const;

/** Auto-fill field catalog (label → data description). Ported from the Contract Templates card. */
export const AUTOFILL_FIELDS: { label: string; maps: string }[] = [
  { label: 'Name', maps: 'Homeowner name' },
  { label: 'Address:', maps: 'Property address' },
  { label: 'Phone', maps: 'Homeowner phone' },
  { label: 'Email:', maps: 'Homeowner email' },
  { label: 'Insurance Co', maps: 'Insurance carrier' },
  { label: 'Claim #', maps: 'Claim number' },
  { label: 'Deductible:', maps: 'Deductible amount' },
  { label: 'Contract Price:', maps: 'Bid amount' },
  { label: 'Material:', maps: 'Shingle brand/type' },
  { label: 'Warranty:', maps: 'Warranty years' },
  { label: 'Statement of Work:', maps: 'Scope of work / SOW' },
];

/** Field-mapping defaults (key → {label, description}). Ported from DEFAULT_FIELD_MAPPINGS. */
export const DEFAULT_FIELD_MAPPINGS: Record<string, { label: string; description: string }> = {
  homeowner_name: { label: 'Name', description: 'Homeowner name' },
  property_address: { label: 'Address:', description: 'Property address' },
  homeowner_phone: { label: 'Phone', description: 'Homeowner phone' },
  homeowner_email: { label: 'Email:', description: 'Homeowner email' },
  insurance_carrier: { label: 'Insurance Co', description: 'Insurance carrier' },
  claim_number: { label: 'Claim #', description: 'Claim number' },
  deductible: { label: 'Deductible:', description: 'Deductible amount' },
  contract_price: { label: 'Contract Price:', description: 'Bid amount' },
  material: { label: 'Material:', description: 'Shingle brand/type' },
  warranty: { label: 'Warranty:', description: 'Warranty years' },
  statement_of_work: { label: 'Statement of Work:', description: 'Scope of work / SOW' },
};

/** D-199 validation status presentation. Ported from STATUS_LABELS in contract-template-validation.js. */
export interface D199StatusLabel {
  cls: string;
  label: string;
  icon: string;
}
export const D199_STATUS_LABELS: Record<string, D199StatusLabel> = {
  pending_validation: { cls: 'val-pending', label: 'Pending validation', icon: '⏳' },
  auto_validated: { cls: 'val-ok', label: 'Auto-validated', icon: '✓' },
  manual_mapping_pending: { cls: 'val-needs', label: 'Needs your action', icon: '⚠️' },
  manual_validated: { cls: 'val-ok', label: 'Manually validated', icon: '✓' },
  submitted_for_admin_review: { cls: 'val-review', label: 'In admin review', icon: '👤' },
  admin_validated: { cls: 'val-ok', label: 'Admin-approved', icon: '✓' },
  rejected: { cls: 'val-rejected', label: 'Rejected — re-upload', icon: '✗' },
};

export function d199StatusLabel(status: string): D199StatusLabel {
  return D199_STATUS_LABELS[status] || { cls: 'val-pending', label: status, icon: '?' };
}
