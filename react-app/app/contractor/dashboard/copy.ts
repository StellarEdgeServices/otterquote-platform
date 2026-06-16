/**
 * Contractor dashboard copy — D-211 Phase 2 (port of contractor-dashboard.html).
 *
 * SINGLE SOURCE OF TRUTH for the dashboard's user-facing strings. page.tsx renders
 * only from this object; the co-located parity test asserts the legal blocks
 * byte-for-byte against contractor-dashboard.html @ main.
 *
 * ⚠️⚠️ TIER-3 VERBATIM-LOCKED LEGAL COPY ⚠️⚠️
 * `agreementModal` and `cpaReacceptModal` are the Contractor Partner Agreement
 * (CPA) acceptance / D-230 re-attestation copy. They were ported BYTE-FOR-BYTE
 * from contractor-dashboard.html and MUST NOT be edited without Dustin sign-off
 * (D-230 / D-220 Tier-3). Any change trips the parity test in
 * __tests__/dashboard.test.tsx.
 */

export const DASHBOARD_COPY = {
  // ── Hero ──
  welcomePrefix: 'Welcome back', // + ", {company_name}"
  serviceAreaLoading: 'Loading your service area...',
  serviceAreaPrefix: 'Service area: ',
  serviceAreaNone: 'Service area: Not configured — update your profile',

  // ── Dunning (folded: read-only alert + Update Card; the dead client-side
  //    "Retry Payment Now" self-write was removed — see page.tsx notes) ──
  dunningTitle: 'Payment Failed — Action Required',
  dunningDefault:
    'Your payment method was declined. Please update your card to avoid losing this project.',
  // composed: `You have an overdue payment of ${fee}. Please update your payment method to continue bidding on new projects.`
  dunningOverduePrefix: 'You have an overdue payment of ',
  dunningOverdueSuffix: '. Please update your payment method to continue bidding on new projects.',
  dunningUpdateCard: 'Update Card',

  // ── Pending-approval banner ──
  pendingBanner:
    "🔄 Your account is under review. While you wait (usually 1–2 business days), here's what you can do to get ready:",
  pendingCompleteProfile: 'Complete Your Profile →',
  pendingAddPayment: 'Add Payment Method →',

  // ── First-time Contractor Partner Agreement modal — ⚠️ TIER-3 VERBATIM ⚠️ ──
  agreementModal: {
    title: 'Contractor Partner Agreement',
    intro: 'Before using Otter Quotes, please review and accept our Contractor Partner Agreement.',
    readLink: '📄 Read Full Agreement',
    checkboxLabel: 'I have read and agree to the Otter Quotes Contractor Partner Agreement',
    accept: 'Accept and Continue',
  },

  // ── D-230 CPA re-acceptance modal — ⚠️ TIER-3 VERBATIM ⚠️ ──
  cpaReacceptModal: {
    title: 'Updated Contractor Agreement',
    intro:
      "We've updated our Contractor Partner Agreement. Please review the changes and re-accept to continue using Otter Quotes.",
    readLink: 'View the updated agreement →',
    // NOTE: the version literal "(version v1-2026-04)" is part of the locked copy;
    // it equals CURRENT_CPA_VERSION (asserted in the parity test).
    checkboxLabel:
      'I have read and accept the updated Contractor Partner Agreement (version v1-2026-04)',
    accept: 'Accept and Continue',
    saving: 'Saving…',
    errorSave: 'Error saving agreement acceptance. Please try again.',
    errorGeneric: 'An error occurred. Please try again.',
  },

  // ── Getting Started checklist ──
  gettingStartedHeading: 'Getting Started',
  checklistComplete: '→ Complete this step',
  checklistLabels: {
    business: 'Business information',
    insurance: 'Insurance certificates on file',
    serviceArea: 'Service area selected',
    contractTemplate: 'Contract template uploaded',
    paymentMethod: 'Payment method on file',
    preferredBrand: 'Preferred shingle brand selected',
    agreement: 'Agreement accepted',
  },

  // ── Quick stats ──
  statAvailable: 'Available Opportunities',
  statActiveBids: 'Active Bids',
  statWonJobs: 'Won Jobs',
  statEarnings: 'Month Earnings',
  statViewAll: 'View All →',
  statManage: 'Manage →',

  // ── Tables ──
  submittedBidsHeading: 'Your Submitted Bids',
  projectsHeading: 'Active & Won Projects',
  activityHeading: 'Recent Activity',
  quickLinksHeading: 'Quick Links',
  emptyBids: 'No submitted bids yet.',
  emptyProjects: 'No active or won projects yet.',
  emptyActivity: 'No recent activity.',

  // ── Mark Job Complete modal ──
  markComplete: {
    title: 'Mark Job Complete?',
    bodyPrefix: 'This unlocks downstream warranty and rebate steps and ',
    bodyStrong: 'cannot be reversed by you',
    bodySuffix: ' — only an admin can undo a job completion.',
    cancel: 'Cancel',
    confirm: 'Confirm Completion',
    confirming: 'Marking complete…',
    error: 'Could not mark job complete. Please try again or contact support.',
  },

  // ── Warranty Upload modal ──
  warranty: {
    title: 'Upload Your Warranty Document',
    body:
      "This goes to the homeowner's permanent record so they can find it years from now. You can skip this now and upload later from your completed jobs list.",
    constraints: 'PDF only · 25 MB max',
    skip: 'Skip for now',
    upload: 'Upload Warranty',
    uploading: 'Uploading…',
    errSelect: 'Please select a PDF file to upload.',
    errType: 'Only PDF files are accepted.',
    errSize: 'File must be under 25 MB.',
    errQuote: 'Quote ID missing — please refresh and try again.',
    errSession: 'Session expired — please refresh the page.',
    errUpload: 'Upload failed. Please try again or contact support.',
  },

  // ── Messages ──
  messagesHeading: 'Messages',
  messagesSelectLabel: 'Select a project:',
  messagesNoProjects: '-- No projects available --',
  messagesSelectPrompt: '-- Select a project --',
  messagesEmpty: 'No messages yet.',
  messagesPlaceholder: 'Type your message...',
  messagesSend: 'Send',
  messagesSending: 'Sending...',
  messagesError: 'Error sending message. Please try again.',
} as const;

// Quick-links grid (label + icon + href; static-stack targets until migrated).
export const QUICK_LINKS = [
  { icon: '📋', title: 'Available Opportunities', href: 'https://otterquote.com/contractor-opportunities.html' },
  { icon: '👤', title: 'My Profile', href: 'https://otterquote.com/contractor-profile.html' },
  { icon: '⚙️', title: 'Settings', href: 'https://otterquote.com/contractor-settings.html' },
  { icon: '📄', title: 'Partner Agreement', href: 'https://otterquote.com/contractor-agreement.html' },
] as const;
