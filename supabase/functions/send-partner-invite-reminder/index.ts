/**
 * OtterQuote Edge Function: send-partner-invite-reminder
 *
 * gh-2154 P-5 go-live (Ben, bus 2026-09-25T22:17:42Z item 2) — the 48h
 * reminder email for a Meta Lead Ads partner invite that has not yet been
 * accepted. Dustin-approved copy verbatim, same draft as the initial
 * invite email (#2154 comment 5837072371) — see
 * meta-leadgen-webhook/invite-email.ts's buildReminderEmail, duplicated
 * into this directory (this repo's Edge Function deploy path does not
 * resolve imports across function directories) as ./invite-email-copy.ts.
 *
 * ENGINE ONLY, same posture as send-partner-onboarding: refuses to send
 * unless ALL of PARTNER_INVITE_EMAIL_ENABLED === "true" (the SAME switch
 * the initial invite email uses, per this task's own brief -- "put it
 * behind the same invite switch"), MAILGUN_API_KEY, and
 * PARTNER_ONBOARDING_OPTOUT_SECRET (the opt-out link's signing secret,
 * reused from P-4 -- see ./optout.ts) are all configured. Any one missing
 * -> every invocation returns 200 {skipped:'disabled'|'no_opt_out_secret'}
 * and touches nothing.
 *
 * Idempotency, retry cap and uncertain-outcome handling: reuses P-4's own
 * partner_onboarding_sends ledger + claim_partner_onboarding_stage() RPC
 * under a fifth stage value, 'invite_reminder' (see the migration
 * 20260925222500_gh2154_p5_invite_reminder_stage.sql, which only widens
 * that function's stage CHECK — the function itself, and every hardening
 * #2191 already gave it, is untouched). All actual guard/claim/send/mark
 * logic lives in ./reminder-sweep.ts's runReminderSweep, exercised entirely
 * by reminder-sweep.test.ts with fake dependencies — this file only wires
 * those dependencies to real Supabase/Mailgun and shapes the HTTP response,
 * same separation of concerns send-partner-onboarding/index.ts uses.
 *
 * Auth: same fail-closed cron-auth gate as send-partner-onboarding (see
 * ./cron-auth.ts, duplicated).
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MAILGUN_API_KEY, CRON_SECRET,
 *   PARTNER_INVITE_EMAIL_ENABLED, PARTNER_ONBOARDING_OPTOUT_SECRET,
 *   PARTNER_ONBOARDING_OPTOUT_SECRET_PREVIOUS (optional),
 *   PARTNER_INVITE_SECRET (the SAME accept-link secret meta-leadgen-webhook
 *   uses, so the reminder's own "Finish My Signup" link works identically)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { runReminderSweep, type ReminderCandidate, type RunDeps } from "./reminder-sweep.ts";
import { buildPartnerOptOutUrl, canSendWithOptOut, PARTNER_OPTOUT_SECRET_ENV, signPartnerOptOutToken } from "./optout.ts";
import { isCronAuthorized } from "./cron-auth.ts";
import { ADMIN_EMAIL, buildUncertainAlertEmail } from "./admin-alert.ts";
import { buildReminderEmail, isInviteEmailEnabled, PARTNER_INVITE_EMAIL_ENABLED_ENV } from "./invite-email-copy.ts";
import { PARTNER_INVITE_SECRET_ENV, signPartnerInviteToken } from "./invite-token.ts";

const FUNCTION_NAME = "send-partner-invite-reminder";
const BATCH_LIMIT = 500;
const SITE_BASE_URL = "https://otterquote.com";
const MAILGUN_TIMEOUT_MS = 10_000;

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function sendMailgunEmail(
  apiKey: string,
  to: string,
  subject: string,
  textBody: string,
  htmlBody: string,
  optOutUrl: string,
): Promise<{ ok: boolean; mailgunId?: string; error?: string; uncertain?: boolean; permanent?: boolean }> {
  const formData = new URLSearchParams();
  formData.append("from", "Otter Quotes <notifications@mail.otterquote.com>");
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", textBody);
  formData.append("html", htmlBody);
  // Same RFC 8058 mailbox-provider one-click surface as send-partner-
  // onboarding/index.ts's own sendMailgunEmail -- this task's brief item
  // (1) requires it here too.
  formData.append("h:List-Unsubscribe", `<${optOutUrl}>`);
  formData.append("h:List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
  try {
    const res = await fetch("https://api.mailgun.net/v3/mail.otterquote.com/messages", {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`api:${apiKey}`)}` },
      body: formData,
      signal: AbortSignal.timeout(MAILGUN_TIMEOUT_MS),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "(unreadable)");
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
      return { ok: false, error: `Mailgun ${res.status}: ${errText}`, permanent };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, mailgunId: (data as { id?: string })?.id };
  } catch (err) {
    return { ok: false, uncertain: true, error: String(err) };
  }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const bodyPeek = await req.clone().json().catch(() => ({}));
    if (bodyPeek?.health_check === true) {
      return jsonResponse({ status: "ok" }, 200);
    }
  } catch (_) {
    // fall through
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const mailgunApiKey = Deno.env.get("MAILGUN_API_KEY");
  const cronSecret = Deno.env.get("CRON_SECRET");
  const optOutSecret = Deno.env.get(PARTNER_OPTOUT_SECRET_ENV);
  const inviteSecret = Deno.env.get(PARTNER_INVITE_SECRET_ENV);
  const functionsBaseUrl = `${(supabaseUrl || "").replace(/\/$/, "")}/functions/v1`;

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: "Server configuration error" }, 500);
  }

  const incomingCronSecret = req.headers.get("X-Cron-Secret");
  const authHeader = req.headers.get("Authorization") || "";
  const authorized = isCronAuthorized({ cronSecret, incomingCronSecret, authHeader, serviceRoleKey });
  if (!authorized) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  // Same "same invite switch" gate this task's brief requires, checked
  // before any DB read — mirrors send-partner-onboarding's kill-switch
  // check position.
  if (!isInviteEmailEnabled(Deno.env.get(PARTNER_INVITE_EMAIL_ENABLED_ENV))) {
    return jsonResponse({ ok: true, skipped: "disabled" }, 200);
  }
  // Same posture as D-320's canSendWithOptOut / P-4's own optOutSecretConfigured:
  // no verifiable unsubscribe link, no send at all.
  if (!canSendWithOptOut(optOutSecret)) {
    return jsonResponse({ ok: true, skipped: "no_opt_out_secret" }, 200);
  }
  if (!inviteSecret) {
    return jsonResponse({ ok: true, skipped: "no_invite_secret" }, 200);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const deps: RunDeps = {
    now: Date.now(),
    fetchCandidates: async () => {
      const { data, error } = await supabase
        .from("referral_agents")
        .select("id, email, first_name, agent_type, created_at, partner_agreement_accepted_at, status, meta_lead_id, onboarding_opted_out_at")
        .eq("status", "pending")
        .not("meta_lead_id", "is", null)
        .is("partner_agreement_accepted_at", null)
        .is("onboarding_opted_out_at", null)
        .order("created_at", { ascending: false })
        .limit(BATCH_LIMIT);
      if (error) {
        console.error(`[${FUNCTION_NAME}] candidate scan failed:`, error.message);
        return [];
      }
      return (data || []) as ReminderCandidate[];
    },
    existingLedgerRow: async (partnerId) => {
      const { data, error } = await supabase
        .from("partner_onboarding_sends")
        .select("status, created_at")
        .eq("partner_id", partnerId)
        .eq("stage", "invite_reminder")
        .maybeSingle();
      if (error || !data) return undefined;
      return { status: data.status as string, created_at: data.created_at as string };
    },
    claim: async (partnerId) => {
      const { data, error } = await supabase.rpc("claim_partner_onboarding_stage", {
        p_partner_id: partnerId,
        p_stage: "invite_reminder",
      });
      if (error) {
        console.error(`[${FUNCTION_NAME}] claim RPC failed for ${partnerId} — treating as NOT claimed (fail closed):`, error.message);
        return false;
      }
      return data === true;
    },
    buildOptOutUrl: async (partnerId) => {
      const token = await signPartnerOptOutToken(partnerId, optOutSecret as string);
      return buildPartnerOptOutUrl(functionsBaseUrl, token);
    },
    sendEmail: async ({ to, firstName, agentType, partnerId, optOutUrl }) => {
      if (!mailgunApiKey) {
        console.warn(`[${FUNCTION_NAME}] MAILGUN_API_KEY not set — refusing to record as sent`);
        return { ok: false, error: "MAILGUN_API_KEY not configured" };
      }
      const inviteToken = await signPartnerInviteToken(partnerId, inviteSecret as string);
      const email = buildReminderEmail(firstName, agentType, SITE_BASE_URL, inviteToken, optOutUrl);
      return sendMailgunEmail(mailgunApiKey, to, email.subject, email.text, email.html, optOutUrl);
    },
    markSent: async (partnerId, mailgunId) => {
      const { error } = await supabase
        .from("partner_onboarding_sends")
        .update({ status: "sent", mailgun_id: mailgunId, error: null })
        .eq("partner_id", partnerId)
        .eq("stage", "invite_reminder");
      return { error: error ? { message: error.message } : undefined };
    },
    markFailed: async (partnerId, errMessage, terminal) => {
      const { error } = await supabase
        .from("partner_onboarding_sends")
        .update({ status: "failed", error: errMessage, terminal_failure: terminal === true })
        .eq("partner_id", partnerId)
        .eq("stage", "invite_reminder");
      return { error: error ? { message: error.message } : undefined };
    },
    alreadyAlertedUncertain: async (partnerId) => {
      const { data, error } = await supabase
        .from("partner_onboarding_sends")
        .select("uncertain_alerted_at")
        .eq("partner_id", partnerId)
        .eq("stage", "invite_reminder")
        .maybeSingle();
      if (error || !data) return false;
      return data.uncertain_alerted_at != null;
    },
    markUncertainAlerted: async (partnerId) => {
      await supabase
        .from("partner_onboarding_sends")
        .update({ uncertain_alerted_at: new Date().toISOString() })
        .eq("partner_id", partnerId)
        .eq("stage", "invite_reminder");
    },
    alertAdminUncertain: async (rows) => {
      if (!mailgunApiKey) return;
      const { subject, textBody, htmlBody } = buildUncertainAlertEmail(rows);
      const formData = new URLSearchParams();
      formData.append("from", "Otter Quotes <notifications@mail.otterquote.com>");
      formData.append("to", ADMIN_EMAIL);
      formData.append("subject", subject);
      formData.append("text", textBody);
      formData.append("html", htmlBody);
      try {
        await fetch("https://api.mailgun.net/v3/mail.otterquote.com/messages", {
          method: "POST",
          headers: { Authorization: `Basic ${btoa(`api:${mailgunApiKey}`)}` },
          body: formData,
          signal: AbortSignal.timeout(MAILGUN_TIMEOUT_MS),
        });
      } catch (_) {
        // Best-effort, same posture as send-partner-onboarding's own
        // alertAdminUncertain failure handling.
      }
    },
  };

  const outcome = await runReminderSweep(deps);
  if (!outcome.ok) {
    return jsonResponse({ ok: false, error: outcome.error }, 500);
  }
  const sent = outcome.results.filter((r) => r.sent).length;
  return jsonResponse(
    {
      ok: true,
      processed: sent,
      results: outcome.results,
      ...(outcome.uncertain.length ? { uncertain: outcome.uncertain } : {}),
    },
    200,
  );
});
