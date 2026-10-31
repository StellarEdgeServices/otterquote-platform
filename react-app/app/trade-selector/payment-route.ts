/**
 * D-407 1/8 (gh-3282): the homeowner payment-routing question.
 *
 *   Q1  "How is this being paid for?"   Insurance | Out-of-pocket
 *   Q2  (Insurance only)                RCV | ACV
 *
 * Four answers, four destinations (see PAYMENT_DESTINATIONS). Pure functions
 * only, so the routing table is unit-testable without rendering the wizard.
 *
 * Wording: Q1 is quoted from #3273 (Scope item 1). Q2 keeps the wizard's
 * existing policy-step copy; D-407 gives only "RCV or ACV?" for it.
 * The ACV explainer text is NOT here (gh-3284, LEGAL-READ).
 *
 * Placeholder destinations: the D-407 pages (#3283 RCV page, #3284 ACV
 * explainer, #3285 Out-of-pocket route) do not exist yet. Until each one
 * lands, its row below points at the existing static project-information
 * page for that payment path (the same pages the wizard already used, gh-1276).
 * Each later sub-issue changes exactly one row of PAYMENT_DESTINATIONS.
 *
 * DB values are unchanged: funding_type 'insurance' | 'cash' and the D-073
 * job types (insurance_rcv / insurance_acv / retail) stay as they are.
 */

export type FundingAnswer = 'insurance' | 'cash';
export type PolicyAnswer = 'rcv' | 'acv' | 'idk';
export type PaymentRoute = 'rcv' | 'acv' | 'oop';

/** D-407 / #3273 scope item 1, verbatim. */
export const PAYMENT_QUESTION = 'How is this being paid for?';

/**
 * Where each route lands after intake. Placeholders are marked; replace the
 * row when the owning sub-issue ships.
 */
export const PAYMENT_DESTINATIONS: Record<PaymentRoute, string> = {
  rcv: 'https://otterquote.com/project-info-rcv.html', // placeholder until #3283
  acv: 'https://otterquote.com/project-info-acv.html', // placeholder until #3284
  oop: 'https://otterquote.com/project-info-cash.html', // placeholder until #3285
};

/** Q1 answer -> does the wizard ask Q2? */
export function needsPolicyQuestion(funding: FundingAnswer | null): boolean {
  return funding === 'insurance';
}

/**
 * The route a completed answer set resolves to, or null while unanswered.
 * No answer (or Insurance without Q2) never resolves, so nothing advances.
 * 'idk' resolves to RCV, the wizard's existing behaviour (job type insurance_rcv).
 */
export function resolvePaymentRoute(
  funding: FundingAnswer | null,
  policy: PolicyAnswer | null,
): PaymentRoute | null {
  if (funding === 'cash') return 'oop';
  if (funding === 'insurance') {
    if (policy === 'acv') return 'acv';
    if (policy === 'rcv' || policy === 'idk') return 'rcv';
  }
  return null;
}

/** Destination URL for an answer set, or null while unanswered. */
export function paymentDestination(
  funding: FundingAnswer | null,
  policy: PolicyAnswer | null,
): string | null {
  const route = resolvePaymentRoute(funding, policy);
  return route ? PAYMENT_DESTINATIONS[route] : null;
}
