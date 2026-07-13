/**
 * #534 credential-education copy — GC-LOCKED VERBATIM (Dustin, 2026-07-13,
 * legal-copy session recorded on GitHub issue #534). Deploy exactly these
 * strings; any deviation requires new GC sign-off (D-219). Punctuation is
 * part of the lock: straight apostrophes/quotes, em dashes (U+2014).
 *
 * Framing: D-217 neutral display, D-210 documents-on-file facts, D-218
 * multi-license drill-down. D-104-audited: no vetted/approved/endorsed/
 * verified claims. D-175: all display copy reads "Otter Quotes".
 */

export const CREDENTIAL_EDUCATION_TITLE = 'About contractor credentials';

export const CREDENTIAL_EDUCATION_SECTIONS = [
  {
    lead: "What's on file.",
    body:
      'Before a contractor can bid on Otter Quotes, they provide a Certificate of Insurance for ' +
      "Commercial General Liability coverage, plus either a workers' compensation certificate of " +
      "insurance or a state-issued workers' comp exemption certificate. These documents are on file " +
      'with Otter Quotes.',
  },
  {
    lead: 'Licensing.',
    body:
      "Requirements vary by state, county, and city — and some work doesn't require a license at " +
      'all. Otter Quotes displays exactly what each contractor has provided: license details where ' +
      'uploaded, or "License: Not provided by contractor" where not. Otter Quotes does not determine ' +
      'whether a license is required for your project.',
  },
  {
    lead: 'Permits and bonds.',
    body:
      'Permits are approvals from your local building department that certain projects require — ' +
      'your contractor typically obtains them, but confirming what your project needs is part of ' +
      'hiring. Surety bonds are a financial guarantee some jurisdictions require contractors to ' +
      'carry as part of local licensing.',
  },
  {
    lead: 'Your role.',
    body:
      'Otter Quotes shows you what contractors have uploaded. Verifying whether those documents ' +
      'meet your local requirements is your responsibility. To check what your area requires, ' +
      'contact your state licensing board and your county or city building department.',
  },
] as const;

export const CREDENTIAL_EDUCATION_CLOSING =
  'Otter Quotes does not independently verify these documents with issuing agencies, and listing ' +
  'on Otter Quotes is not an endorsement of any contractor. The choice of contractor is always yours.';

// ── GC-approved badge wording (#534 comment; the word "verification" is
//    dropped everywhere; "not provided" is a lawful state — neutral, no ⚠) ────

export const BADGE_LICENSE_ON_FILE = '✓ License on file';
export const badgeLicensesOnFile = (n: number): string => `✓ ${n} licenses on file`;
export const BADGE_LICENSE_NOT_PROVIDED = 'License not provided';
export const BADGE_DOCUMENTS_ON_FILE = '✓ Documents on file';
export const BADGE_APPLICATION_UNDER_REVIEW = 'Application under review';

/** D-217 profile display line for the no-license state. */
export const LICENSE_NOT_PROVIDED_LINE = 'License: Not provided by contractor.';
