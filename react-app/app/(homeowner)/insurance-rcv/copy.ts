/**
 * D-407 2/8 (gh-3283) RCV page: user-facing strings and where each came from.
 * Nothing here is legal or money wording. The PR body lists the same table.
 */

/** project-info-rcv.html banner (main). Shown ONLY when the stored policy_type is 'rcv'. */
export const RCV_BANNER = 'This job is being paid for via Insurance Claim (Replacement Cost Value).';
export const RCV_BANNER_CHANGE = 'Change';
export const RCV_CHANGE_HREF = 'https://otterquote.com/trade-selector.html';

/**
 * PLACEHOLDER, WORDING PENDING BEN'S RULING (Q on #3282). When the stored policy
 * answer is "not sure" or missing, the page must assert no policy type. null = render
 * nothing. Do not put text here without a ruling.
 */
export const POLICY_UNKNOWN_WORDING_PENDING_RULING: string | null = null;

/** #3273 (Dustin, verbatim): "project information at the top ... the insurance estimate ... material selection". */
export const RCV_TITLE = 'Insurance Claim Details';
export const RCV_ESTIMATE_HEADING = 'Insurance estimate';
export const RCV_MATERIAL_HEADING = 'Material selection';

/** Functional labels authored in this PR (no legal or money claim). */
export const RCV_ESTIMATE_PROMPT = 'Upload your insurance estimate.';
export const RCV_ESTIMATE_BUTTON = 'Upload estimate';
export const RCV_ESTIMATE_UPLOADING = 'Uploading…';
export const RCV_ESTIMATE_DONE = 'Estimate uploaded';
export const RCV_ESTIMATE_FAILED = 'We could not upload that file. Please try again.';

/** project-info-rcv.html submit button text, and its failure line. */
export const RCV_SUBMIT = 'Save & Continue';
export const RCV_SUBMITTING = 'Saving…';
export const RCV_SAVE_FAILED = 'Something went wrong. Please try again.';

/** project-info-rcv.html failure line. */
export const NO_CLAIM_MESSAGE =
  'No project found for your account. Please start from the beginning.';

/** Functional text for the required-field list shown when Continue is pressed early. */
export const RCV_MISSING_LEAD = 'Please finish these before continuing:';
export const MISSING_LABELS = {
  name: 'Full name',
  phone: 'Phone',
  address: 'Property address',
  estimate: 'Insurance estimate upload',
  measurement: 'Measurement report',
  materials: 'Material selection',
} as const;
