/**
 * gh-1843 residual: pure sender-selection + auth-decision logic for send-sms,
 * split out of index.ts so it is unit-testable without a live Supabase
 * client, a live Twilio account, or a real SMS send (same source-split
 * pattern as approve-payout/w9-gate.ts).
 *
 * Also hardens the exact "secret exists but is blank" bug this issue's body
 * called out (§ "Also, separately measurable and probably a bug"): an empty
 * TWILIO_MESSAGING_SERVICE_SID was already falsy in the pre-existing code,
 * but a WHITESPACE-ONLY value (" ") was not — it would have been truthy and
 * silently taken the MessagingServiceSid branch with a garbage SID. Both
 * inputs are now trimmed before the truthiness check.
 */

export interface TwilioSenderConfig {
  messagingServiceSid?: string | null;
  phoneNumber?: string | null;
}

export type TwilioSenderField =
  | { field: "MessagingServiceSid"; value: string }
  | { field: "From"; value: string };

/**
 * Chooses which Twilio sender field to populate on the outbound Messages.json
 * POST. MessagingServiceSid (A2P/TCR-compliant) is preferred; a direct phone
 * number is used only when no messaging service SID is configured. Throws
 * when neither is usably configured, matching index.ts's pre-existing
 * fail-closed behavior (no send is attempted without a sender).
 */
export function resolveTwilioSender(config: TwilioSenderConfig): TwilioSenderField {
  const messagingServiceSid = config.messagingServiceSid?.trim();
  const phoneNumber = config.phoneNumber?.trim();

  if (messagingServiceSid) {
    return { field: "MessagingServiceSid", value: messagingServiceSid };
  }
  if (phoneNumber) {
    return { field: "From", value: phoneNumber };
  }
  throw new Error(
    "No Twilio sender configured. Set TWILIO_MESSAGING_SERVICE_SID (preferred) or TWILIO_PHONE_NUMBER."
  );
}

export type AuthDecision =
  | { authorized: true; reason: "service_role" | "user_jwt" }
  | { authorized: false; reason: "missing_token" | "invalid_token" };

/**
 * Decides whether a caller is authorized to invoke send-sms: either the
 * exact service-role key (trusted internal callers, e.g. notify-contractors)
 * or a bearer token that resolves to a real user via the injected getUser
 * lookup (an authenticated end user). `getUser` is injected so this can be
 * unit-tested with a fake resolver — no live Supabase client involved, and
 * no network call.
 */
export async function resolveAuthorization(
  authHeader: string,
  serviceRoleKey: string,
  getUser: (token: string) => Promise<{ user: unknown } | null | undefined>,
): Promise<AuthDecision> {
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return { authorized: false, reason: "missing_token" };
  }
  if (token === serviceRoleKey) {
    return { authorized: true, reason: "service_role" };
  }
  const result = await getUser(token);
  if (result?.user) {
    return { authorized: true, reason: "user_jwt" };
  }
  return { authorized: false, reason: "invalid_token" };
}
