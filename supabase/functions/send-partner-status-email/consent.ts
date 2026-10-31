// consent.ts — gh-1337 / gh-3241: the homeowner's referrer-updates consent decision, kept pure (no network,
// no DB) so the opt-out rules are testable without Supabase or Mailgun (consent.test.ts), matching the
// templates.ts split in this function.
//
// privacy.html 4.7 lets a homeowner decline progress updates to the person who referred them; the choice is
// stored as claims.referrer_updates_opt_out (fallback: referrals.metadata.referrer_updates_opt_out).
//
// gh-3241: before this change the gate read only the ONE claim the stage logic picked (the newest claim whose
// referral_id is this referral). A referral can be linked to a claim from either side (claims.referral_id or
// referrals.claim_id) and, in principle, to more than one claim, so an opt-out recorded on any other linked claim
// was not seen. The rule is now: an opt-out on ANY linked claim, or in the referral's metadata, withholds the
// whole series. get_my_referrals() applies the same "any linked claim" rule to the partner dashboard's name.
//
// Fail-closed, as before: anything other than an explicitly captured "did not opt out" withholds.

export type ReferrerConsent = "granted" | "withheld";

export interface LinkedClaimOptOut {
  id: string;
  referrer_updates_opt_out: boolean | null | undefined;
}

export interface ConsentInput {
  /** The claim the stage logic uses (newest claim with claims.referral_id = this referral). */
  primaryClaimId: string;
  /** Every claim linked to the referral from either side; null when the lookup failed. */
  linkedClaims: readonly LinkedClaimOptOut[] | null;
  // deno-lint-ignore no-explicit-any
  referralMetadata: Record<string, any> | null;
}

export function decideReferrerConsent(input: ConsentInput): { consent: ReferrerConsent; source: string } {
  const linked = input.linkedClaims ?? [];
  const optedOut = linked.find((c) => c && c.referrer_updates_opt_out === true);
  if (optedOut) {
    return { consent: "withheld", source: `claims.referrer_updates_opt_out (opted out on linked claim ${optedOut.id})` };
  }
  const metaValue = input.referralMetadata?.referrer_updates_opt_out;
  if (metaValue === true) {
    return { consent: "withheld", source: "referrals.metadata.referrer_updates_opt_out (opted out)" };
  }
  const primary = linked.find((c) => c && c.id === input.primaryClaimId);
  if (primary && primary.referrer_updates_opt_out === false) {
    return { consent: "granted", source: "claims.referrer_updates_opt_out" };
  }
  if (metaValue === false) {
    return { consent: "granted", source: "referrals.metadata.referrer_updates_opt_out" };
  }
  return { consent: "withheld", source: input.linkedClaims === null ? "consent lookup failed" : "no captured consent value" };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PostgREST `or=` filter selecting every claim linked to the referral from either side. Only well-formed UUIDs
 * are interpolated (both values come from the referrals row, but the filter string is built by hand, so it is
 * validated rather than trusted). Returns null when the referral id itself is not a UUID.
 */
export function linkedClaimsOrFilter(referralId: string, referralClaimId: string | null | undefined): string | null {
  if (!UUID_RE.test(referralId)) return null;
  const parts = [`referral_id.eq.${referralId}`];
  if (referralClaimId && UUID_RE.test(referralClaimId)) parts.push(`id.eq.${referralClaimId}`);
  return parts.join(",");
}
