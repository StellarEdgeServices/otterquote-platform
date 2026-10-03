/**
 * gh-2421 (D-344): out-of-state claim alert handler.
 *
 * "Alert Dustin the moment a claim is created with property_state not IN and
 * not blocked: state, trade, claim id." Reached ONLY via the service-role key
 * (index.ts gates event_type=out_of_state_claim on isOutOfStateClaimAuthorized)
 * from trg_notify_admin_out_of_state_claim, which fires on claims INSERT and on
 * UPDATE OF property_state (trade-selector writes property_state on both
 * paths, and it can be NULL at insert).
 *
 * Kept in its own module, with sb and sendMail injected, so `deno test` can
 * drive it without importing index.ts (which calls serve() at load).
 *
 * Trust model (same as gh-1994 handleRouterLead): the request body is
 * untrusted. Only record.id is read from it. State, trades, is_test and the
 * owner come from a DB read; the email is built from the row returned by the
 * atomic stamp query.
 *
 * Exactly once: UPDATE claims SET out_of_state_alerted_at = now()
 * WHERE id = $1 AND out_of_state_alerted_at IS NULL AND property_state = <the
 * value just evaluated> AND is_test is not true RETURNING ... -- only the call
 * that flips the column sends. A Mailgun failure reverts the stamp so a retry
 * can send; if the revert itself fails the claim errs toward at-most-once, and
 * that is logged.
 *
 * Recipient, provider and secrets are unchanged (ADMIN_EMAIL, Mailgun).
 */

import {
  ADMIN_EMAIL,
  BLOCKED_STATES_SETTING_KEY,
  buildOutOfStateClaimEmail,
  isAlertableOutOfState,
  isExcludedEmail,
  normalizeState,
  parseBlockedStates,
  tradesLabel,
} from "./notify-helpers.ts";

export const NOTIF_TYPE_OUT_OF_STATE = "admin_out_of_state_claim";

export interface OutOfStateDeps {
  // deno-lint-ignore no-explicit-any
  sb: any; // supabase-js client (service role)
  sendMail: (
    subject: string,
    textBody: string,
    htmlRows: [string, string][],
    extraHtml: string,
  ) => Promise<{ id: string }>;
}

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

const skipped = (reason: string): HandlerResult => ({ status: 200, body: { success: true, skipped: true, reason } });

export async function handleOutOfStateClaim(
  deps: OutOfStateDeps,
  record: Record<string, unknown>,
): Promise<HandlerResult> {
  const { sb, sendMail } = deps;
  const claimId = record?.id as string | undefined;
  if (!claimId || typeof claimId !== "string") {
    return { status: 400, body: { error: "Missing required field: record.id" } };
  }

  const { data: claim, error: claimErr } = await sb
    .from("claims")
    .select("id, user_id, trades, property_state, is_test, out_of_state_alerted_at")
    .eq("id", claimId)
    .maybeSingle();
  if (claimErr) {
    console.error(`notify-admin-new-homeowner: out_of_state claim read failed for claim_id=${claimId}:`, claimErr);
    return { status: 500, body: { error: "failed to read claim" } };
  }
  if (!claim) return skipped("not_eligible");
  if (claim.out_of_state_alerted_at) return skipped("already_alerted");
  if (claim.is_test === true) return skipped("test_account");

  const state = normalizeState(claim.property_state);
  if (!state) return skipped("no_state");

  // Blocked list: read the platform_settings row directly (service role);
  // missing row, read error or malformed value -> default FL/LA/TX.
  const { data: setting, error: settingErr } = await sb
    .from("platform_settings")
    .select("value")
    .eq("key", BLOCKED_STATES_SETTING_KEY)
    .maybeSingle();
  if (settingErr) {
    console.warn("notify-admin-new-homeowner: blocked-states read failed, using default FL/LA/TX:", settingErr);
  }
  const blocked = parseBlockedStates(setting?.value);
  if (!isAlertableOutOfState(state, blocked)) {
    return skipped(state === "IN" ? "in_state" : "blocked_state");
  }

  // Same exclusion logic as claim_created: profile is_test, or an excluded /
  // missing email.
  let email = "";
  let profileIsTest = false;
  if (claim.user_id) {
    const { data: profile } = await sb
      .from("profiles")
      .select("email, is_test")
      .eq("id", claim.user_id)
      .maybeSingle();
    email = profile?.email || "";
    profileIsTest = profile?.is_test === true;
  }
  if (profileIsTest || isExcludedEmail(email)) {
    console.log(`notify-admin-new-homeowner: skipping test/excluded out-of-state claim ${claimId}`);
    return skipped("test_account");
  }

  // Atomic claim-and-read. property_state is pinned to the value evaluated
  // above so the state we email is the state we decided on.
  const { data: stamped, error: stampErr } = await sb
    .from("claims")
    .update({ out_of_state_alerted_at: new Date().toISOString() })
    .eq("id", claimId)
    .is("out_of_state_alerted_at", null)
    .eq("property_state", claim.property_state)
    .not("is_test", "is", true)
    .select("id, trades, property_state, claim_number");
  if (stampErr) {
    console.error(`notify-admin-new-homeowner: out_of_state stamp failed for claim_id=${claimId}:`, stampErr);
    return { status: 500, body: { error: "failed to claim for alert" } };
  }
  const row = stamped?.[0] as Record<string, unknown> | undefined;
  if (!row) return skipped("not_eligible");

  const { subject, textBody, htmlRows, extraHtml } = buildOutOfStateClaimEmail(row);
  let mg: { id: string };
  try {
    mg = await sendMail(subject, textBody, htmlRows, extraHtml);
  } catch (mailErr) {
    console.error(`notify-admin-new-homeowner: mailgun send failed for out_of_state claim_id=${claimId}, reverting stamp:`, mailErr);
    const { error: revertErr } = await sb.from("claims").update({ out_of_state_alerted_at: null }).eq("id", claimId);
    if (revertErr) {
      console.error(`notify-admin-new-homeowner: failed to revert out_of_state_alerted_at for claim_id=${claimId}:`, revertErr);
    }
    return { status: 500, body: { error: "failed to send out-of-state alert email" } };
  }

  const { error: logErr } = await sb.from("notifications").insert({
    user_id: claim.user_id || null,
    claim_id: claimId,
    channel: "email",
    notification_type: NOTIF_TYPE_OUT_OF_STATE,
    recipient: ADMIN_EMAIL,
    message_preview: `Out-of-state claim: ${state} - ${tradesLabel(row.trades)}`,
    sent_at: new Date().toISOString(),
    delivered: true,
    mailgun_id: mg.id,
  });
  if (logErr) console.warn(`notify-admin-new-homeowner: failed to log out_of_state notification for claim_id=${claimId}:`, logErr);

  return { status: 200, body: { success: true, mailgun_id: mg.id } };
}
