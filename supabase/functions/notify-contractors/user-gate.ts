// gh-2462 -- caller authorization for notify-contractors.
//
// notify-contractors has two kinds of real caller (caller map in PR for #2462):
//
//   SERVICE (any event, body passed through unchanged) -- `Bearer <service key>`:
//     check-siding-design-completion  new_opportunity (SUPABASE_SERVICE_ROLE_KEY)
//     switch-contractor               new_opportunity (SUPABASE_SERVICE_ROLE_KEY)
//     docusign-webhook                contract_signed (getServiceRoleKey())
//     stripe-webhook                  contract_signed (SUPABASE_SERVICE_ROLE_KEY)
//
//   SIGNED-IN USER (supabase-js functions.invoke attaches the session JWT):
//     homeowner, owns claims.user_id:
//       dashboard.html submitForBids, React dashboard submitForBids -> {claim_id}  (new_opportunity)
//       bids.html, contractor-about.html accept_bid -> {event_type:"bid_accepted", claim_id}
//     contractor, owns contractors.user_id AND has a quote on the claim:
//       contractor-bid-form.html, React bid-form (bid update / renewal) ->
//       {event_type:"bid_update_confirmed"|"bid_renewal_requested", claim_id, contractor_id}
//
// A user may ONLY fire those four events, only on a row they own, and only with the
// fields their real caller sends (the rest of the body is dropped, so a user cannot
// steer trade_types / location / job_type of a fan-out). contract_signed, bid_expired,
// agreement_requested (deprecated) and anything else stay service-only.
// No/invalid credential -> 401. Valid user, wrong event or not their row -> 403.
// The DB lookups are injected (index.ts wires them to the service-role client), so this
// file does no I/O of its own.

import { bearerToken, hasServiceBearer, looksLikeJwt } from "./caller-gate.ts";

export type NotifyBody = Record<string, unknown>;

export type GateDecision =
  | { ok: true; caller: "service"; body: NotifyBody }
  | { ok: true; caller: "user"; userId: string; body: NotifyBody }
  | { ok: false; status: 401 | 403; reason: string };

export interface OwnershipLookups {
  /** auth user id for a session JWT (supabase.auth.getUser), or null when invalid. */
  userIdForToken(token: string): Promise<string | null>;
  /** claims.user_id for the claim, or null when not found. */
  claimOwnerId(claimId: string): Promise<string | null>;
  /** contractors.user_id for the contractor, or null when not found. */
  contractorUserId(contractorId: string): Promise<string | null>;
  /** true when a quotes row exists for (claim_id, contractor_id). */
  contractorHasQuote(claimId: string, contractorId: string): Promise<boolean>;
}

/** Events a signed-in user may fire, with the exact fields their real caller sends. */
export const USER_EVENTS: Readonly<Record<string, readonly string[]>> = {
  new_opportunity: ["claim_id"],
  bid_accepted: ["claim_id"],
  bid_update_confirmed: ["claim_id", "contractor_id"],
  bid_renewal_requested: ["claim_id", "contractor_id"],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export async function authorizeNotifyCaller(
  req: Request,
  body: NotifyBody,
  serviceKeys: readonly (string | undefined | null)[],
  lookups: OwnershipLookups,
): Promise<GateDecision> {
  if (hasServiceBearer(req, serviceKeys)) return { ok: true, caller: "service", body };

  const token = bearerToken(req);
  // Not a JWT (absent, empty, a wrong secret, the sb_publishable_ key) -> 401 with no I/O.
  if (!token || !looksLikeJwt(token)) return { ok: false, status: 401, reason: "no_user_token" };

  const userId = await lookups.userIdForToken(token);
  // The legacy anon JWT and expired/forged tokens fail getUser -> 401.
  if (!userId) return { ok: false, status: 401, reason: "invalid_user_token" };

  const rawEvent = body.event_type;
  const event = rawEvent === undefined || rawEvent === null || rawEvent === "" ? "new_opportunity" : rawEvent;
  if (typeof event !== "string" || !Object.prototype.hasOwnProperty.call(USER_EVENTS, event)) {
    return { ok: false, status: 403, reason: "event_not_allowed_for_user" };
  }

  const claimId = body.claim_id;
  if (!isUuid(claimId)) return { ok: false, status: 403, reason: "bad_claim_id" };

  if (event === "new_opportunity" || event === "bid_accepted") {
    const owner = await lookups.claimOwnerId(claimId);
    if (!owner || owner !== userId) return { ok: false, status: 403, reason: "not_claim_owner" };
  } else {
    const contractorId = body.contractor_id;
    if (!isUuid(contractorId)) return { ok: false, status: 403, reason: "bad_contractor_id" };
    const cUser = await lookups.contractorUserId(contractorId);
    if (!cUser || cUser !== userId) return { ok: false, status: 403, reason: "not_contractor_owner" };
    if (!(await lookups.contractorHasQuote(claimId, contractorId))) {
      return { ok: false, status: 403, reason: "no_quote_on_claim" };
    }
  }

  const sanitized: NotifyBody = {};
  if (rawEvent !== undefined) sanitized.event_type = rawEvent;
  for (const f of USER_EVENTS[event]) sanitized[f] = body[f];
  return { ok: true, caller: "user", userId, body: sanitized };
}
