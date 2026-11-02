/**
 * D-407 3/8 (gh-3284) ACV explainer: LEGAL wording, customer-facing insurance text.
 *
 * ACV_EXPLAINER_TEXT is the Dustin-approved wording, copied verbatim from the D-407
 * rulings in #3273 ("ACV page wording approved", 2026-10-30T19:25:06Z, choice
 * "Approve this wording (Recommended)"). Do not edit it, reflow it, or "improve"
 * it: the test compares it byte-for-byte (and by SHA-256) to the approved text.
 * Any change needs a new ruling plus LEGAL-READ.
 */
export const ACV_EXPLAINER_TEXT =
  "With an ACV policy, your insurer pays the actual cash value of the damage: the replacement cost minus depreciation and your deductible. That depreciation typically isn't paid back when the work is finished. So the simplest way to handle your project is like a cash job: use your insurance payment as your budget, compare bids, and pay any difference yourself. You can use your insurance estimate, or buy a roof measurement, to get bids. Questions about what your policy covers go to your insurer.";

/** The ACV explainer's Continue goes to the Out-of-pocket route (#3285), claim_id carried. */
export const OOP_ROUTE_PATH = '/out-of-pocket';

/** Functional button label (the issue says only "Continue"). */
export const ACV_CONTINUE = 'Continue';
