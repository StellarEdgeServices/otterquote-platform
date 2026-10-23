// gh-3051 -- the advertising-sharing opt-out gate for the server-side GA4 Measurement Protocol send.
//
// D-NUMBERS IMPLEMENTED: D-323 (GA4 is linked to Google Ads with Personalized Advertising, so a GA4 event is an ad-linked "share")
// and D-336 (the privacy.html Section 12 opt-out is a stored `ad_sharing_opt_out` flag honouring Global Privacy Control and the
// `Sec-GPC: 1` header, and a server-side send skips any opted-out person). Ruling that applies D-336 to this send: Ben, PR #3054
// comment 6371298079, after the LEGAL-READ: FAIL 6371271800 found the first version of this function bypassed the gate.
//
// The browser already applies this gate to GA4 (js/ga-gate.js; react-app/app/lib/ad-optout.ts): the GA4 library does not load
// for a visitor with the `oq_ad_optout` cookie, Global Privacy Control, or a stored profiles.ad_sharing_opt_out = true, and it does
// not load when a signed-in visitor's stored flag cannot be read. The server send must not send what the browser deliberately did
// not, so it uses the same three signals plus the support-email suppression list (D-336: "a single suppression mechanism"):
//
//   leads.ad_sharing_opt_out / claims.ad_sharing_opt_out  recorded AT INSERT by a BEFORE INSERT trigger from the insert request's
//       `Sec-GPC: 1` header and the page's `X-OQ-Ad-Optout` header (1 = cookie or GPC seen by the page, 0 = neither).
//       TRUE = opted out, FALSE = the page reported no opt-out, NULL = the state was not reported (an old cached page, another
//       insert path, or a row written before the trigger existed).
//   profiles.ad_sharing_opt_out  the stored flag (GPC on another device, the Section 12 button, an admin from a support email).
//   ad_sharing_suppressions      the SHA-256 of an address that opted out by email (same digest as stripe-webhook's CAPI check).
//
// FAIL CLOSED: only a definite "not opted out" on EVERY signal sends. Any read that errors, a missing owner profile, or an
// unreported insert-time state is "unknown", and an unknown opt-out is not sent (D-336 precedent: stripe-webhook's
// shouldSkipForAdSharingOptOut / shouldSkipForSuppression; ga-gate.js's "an unknown opt-out is not shared").
//
// No imports, on purpose (same reason as ga4-mp.ts).

export type AdOptOutState = "opted_out" | "not_opted_out" | "unknown";

/** One signal, as read. `value` is the column value; `failed` = the read errored (or the row it lives on could not be read). */
export interface FlagRead {
  value: boolean | null | undefined;
  failed?: boolean;
}

/** An insert-time column (leads / claims .ad_sharing_opt_out): TRUE opts out; FALSE is "no opt-out reported"; NULL is unknown. */
export function insertTimeState(r: FlagRead): AdOptOutState {
  if (r.failed) return "unknown";
  if (r.value === true) return "opted_out";
  if (r.value === false) return "not_opted_out";
  return "unknown";
}

/**
 * The stored profile flag. TRUE opts out; FALSE or NULL is "no stored opt-out" (NULL = never recorded, the column's documented
 * meaning in 20260924003805_gh2107_ad_sharing_opt_out.sql). A failed read, or (when `required`) a profile row that is missing, is
 * unknown: a claim's owner always has a profile, so a missing one means the read did not find the person.
 */
export function storedProfileState(r: FlagRead & { missing?: boolean }, required: boolean): AdOptOutState {
  if (r.failed) return "unknown";
  if (r.missing) return required ? "unknown" : "not_opted_out";
  return r.value === true ? "opted_out" : "not_opted_out";
}

/** The hashed-email suppression list: found opts out; a failed lookup is unknown. */
export function suppressionState(found: boolean, failed: boolean): AdOptOutState {
  if (failed) return "unknown";
  return found ? "opted_out" : "not_opted_out";
}

/** Combines every signal: any opt-out wins, then any unknown; only all-clear is not_opted_out. An empty list is unknown. */
export function combine(states: AdOptOutState[]): AdOptOutState {
  if (states.length === 0) return "unknown";
  if (states.includes("opted_out")) return "opted_out";
  if (states.includes("unknown")) return "unknown";
  return "not_opted_out";
}

/** The gate. Fixed reason tokens only (no values are ever logged). A row with no state at all is unknown and is not sent. */
export function adSharingGate(state: AdOptOutState | null | undefined): { skip: boolean; reason: "ad_sharing_opt_out" | "ad_sharing_opt_out_unknown" | null } {
  if (state === "not_opted_out") return { skip: false, reason: null };
  if (state === "opted_out") return { skip: true, reason: "ad_sharing_opt_out" };
  return { skip: true, reason: "ad_sharing_opt_out_unknown" };
}
