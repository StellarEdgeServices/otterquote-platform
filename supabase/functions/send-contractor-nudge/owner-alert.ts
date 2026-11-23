// gh-3849 (item 3 of #3773): owner-alert SMS with an internal e-mail fallback.
//
// The nudge alerts the owner by SMS through send-sms. If that SMS comes back non-2xx or throws, the owner would
// not learn the homeowner is waiting, so ONE plain-text e-mail goes to the existing owner-alert address (the same
// ADMIN_EMAIL address and Mailgun path notify-admin-new-contractor already uses; MAILGUN_API_KEY / MAILGUN_DOMAIN
// are the existing secrets). Internal alert only: ids and the SMS status, no personal data, no customer-facing text.
// A failure of the fallback e-mail is caught and logged and never changes what the caller sees. This file does not
// import serve(), so it is unit-testable (same pattern as consent-gate.ts).

// Existing owner-alert address (same literal as notify-admin-new-contractor/index.ts ADMIN_EMAIL).
export const OWNER_ALERT_EMAIL = "dustinstohler1@gmail.com";

export interface OwnerAlertEnv {
  supabaseUrl: string;
  serviceRoleKey: string;
  mailgunKey: string;
  mailgunDomain: string;
}

export interface OwnerAlertResult {
  smsOk: boolean;
  emailAttempted: boolean;
  emailOk: boolean;
}

/** Send the owner-alert SMS; on non-2xx or throw, send exactly one fallback e-mail. Never throws. */
export async function sendOwnerAlertSms(
  fetchImpl: typeof fetch,
  env: OwnerAlertEnv,
  ownerPhone: string,
  message: string,
  ids: { claimId: string; contractorId: string },
): Promise<OwnerAlertResult> {
  let failure: string | null = null;
  try {
    const resp = await fetchImpl(`${env.supabaseUrl}/functions/v1/send-sms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.serviceRoleKey}`,
      },
      body: JSON.stringify({ to: ownerPhone, message }),
    });
    if (resp.ok) return { smsOk: true, emailAttempted: false, emailOk: false };
    let errText = "";
    try {
      errText = await resp.text();
    } catch {
      // best-effort only
    }
    console.error("[send-contractor-nudge] Dustin alert send-sms failed:", resp.status, errText);
    failure = `send-sms returned HTTP ${resp.status}`;
  } catch (err) {
    console.error("[send-contractor-nudge] Dustin alert threw:", err);
    failure = "send-sms call threw (network or runtime error)";
  }

  const emailOk = await emailOwnerSmsFailure(fetchImpl, env, failure, ids);
  return { smsOk: false, emailAttempted: true, emailOk };
}

async function emailOwnerSmsFailure(
  fetchImpl: typeof fetch,
  env: OwnerAlertEnv,
  failure: string,
  ids: { claimId: string; contractorId: string },
): Promise<boolean> {
  try {
    if (!env.mailgunKey || !env.mailgunDomain) {
      console.error("[send-contractor-nudge] owner-alert e-mail fallback skipped: Mailgun env not set");
      return false;
    }
    const text = [
      "Internal alert (send-contractor-nudge): the owner-alert SMS failed.",
      `Failure: ${failure}`,
      `claim_id: ${ids.claimId}`,
      `contractor_id: ${ids.contractorId}`,
      "A homeowner reported not hearing from their contractor after signing; the SMS alert to the owner did not go out.",
    ].join("\n");
    const form = new FormData();
    form.append("from", `Otter Quotes <notifications@${env.mailgunDomain}>`);
    form.append("to", OWNER_ALERT_EMAIL);
    form.append("subject", "Owner-alert SMS failed: contractor nudge (internal)");
    form.append("text", text);
    const resp = await fetchImpl(`https://api.mailgun.net/v3/${env.mailgunDomain}/messages`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`api:${env.mailgunKey}`)}` },
      body: form,
    });
    if (!resp.ok) {
      console.error("[send-contractor-nudge] owner-alert e-mail fallback failed:", resp.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[send-contractor-nudge] owner-alert e-mail fallback threw:", err);
    return false;
  }
}
