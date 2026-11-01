/**
 * D-407 4/8 (gh-3285) Out-of-pocket route: user-facing strings and their sources.
 *
 * MONEY: this file contains NO price. The measurement purchase is the existing
 * flow on help-measurements.html, which states the price (D-400, being
 * applied to that page by PR #3233). Do not type a price here.
 */

/** project-info-cash.html h2. */
export const OOP_TITLE = 'Project Details';

/** #3273 scope item 4 (Dustin / Marty): "Measurements", "material selection". */
export const OOP_MEASUREMENTS_HEADING = 'Measurements';
export const OOP_MATERIAL_HEADING = 'Material selection';

/** Existing purchase flow (static page on main); claim_id is appended. */
export const MEASUREMENT_PURCHASE_HREF = 'https://otterquote.com/help-measurements.html';

/** Functional labels authored in this PR (no legal or money claim, no price). */
export const OOP_MEASUREMENT_PROMPT = 'Upload a measurement report you already have, or purchase one.';
export const OOP_UPLOAD_BUTTON = 'Upload measurement report';
export const OOP_UPLOADING = 'Uploading…';
export const OOP_PURCHASE_LINK = 'Purchase a roof measurement';
export const OOP_MEASUREMENT_DONE = 'Measurement attached';
export const OOP_UPLOAD_FAILED = 'We could not upload that file. Please try again.';

/** project-info-cash.html submit button text and failure lines. */
export const OOP_SUBMIT = 'Save & Continue';
export const OOP_SUBMITTING = 'Saving…';
export const OOP_SAVE_FAILED = 'Something went wrong. Please try again.';
export const NO_CLAIM_MESSAGE =
  'No project found for your account. Please start from the beginning.';

export const OOP_MISSING_LEAD = 'Please finish these before continuing:';
export const MISSING_LABELS = {
  name: 'Full name',
  phone: 'Phone',
  address: 'Property address',
  estimate: 'Insurance estimate upload',
  measurement: 'Measurement report',
  materials: 'Material selection',
} as const;
