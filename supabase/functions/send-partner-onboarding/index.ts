/**
 * OtterQuote Edge Function: send-partner-onboarding
 *
 * gh-2154 P-4 — partner onboarding email sequence at day 0/1/3/7 after
 * referral_agents.created_at, per agent_type. Parent: #2154 (D-333 shared
 * partner foundation), Marty's build-sequence comment 5816579743, item P-4.
 * Stacked on P-1 (short signup), P-2 (attribution + activation columns,
 * merged/applied on prod), and P-3 (new-partner admin alert).
 *
 * ENGINE ONLY. Copy is Tier C (Sloane) and ships as an OBVIOUS placeholder
 * (see ./copy.ts) — this function refuses to send anything until BOTH:
 *   (a) platform_settings.partner_onboarding_enabled is the literal `true`
 *       (see ./kill-switch.ts — missing row, null, or an unreadable read all
 *       mean disabled, and the function returns 200 {skipped:'disabled'}); and
 *   (b) the copy for that partner's (agent_type, stage) no longer contains
 *       the `[[` placeholder marker (checked per-partner, per-send — see
 *       ./copy.ts's hasPlaceholderCopy; a partner whose copy is still a
 *       placeholder is reported {skipped:'placeholder_copy'} for that run,
 *       and is retried on a later run once real copy lands, since a
 *       placeholder-blocked stage is never stamped as resolved).
 *
 * CTO RUN 22 defect 2 (Marty's own quote on #2154: "an early version fired
 * two stages back-to-back on a backlog") applies here across FOUR stages
 * instead of homeowner's two — see ./onboarding-stage.ts's selectStage for
 * the fix: at most one stage sends per run, and every earlier due-but-
 * unresolved stage is marked 'skipped' in the ledger so it is never
 * reconsidered.
 *
 * Stop condition: once referral_agents.app_first_signed_in_launch_at (P-2)
 * IS NOT NULL, nothing further ever sends for that partner — checked first,
 * before any stage math (see selectStage).
 *
 * Idempotency (KEVIN CORRECTION Q3 — overrules this file's original
 * stamp-before-send design, which was the exact defect gh-2069 fixed in
 * send-homeowner-next-steps): a dedicated ledger table,
 * public.partner_onboarding_sends, unique on (partner_id, stage), with an
 * atomic claim (public.claim_partner_onboarding_stage(), a conditional
 * upsert) called BEFORE Mailgun, and a mark ('sent' with the Mailgun id, or
 * 'failed' with the error) called AFTER. A 'failed' row is retried by a
 * later run, never silently dropped. See ./run-sweep.ts's file header and
 * supabase/migrations/*_gh2154_p4_partner_onboarding_ledger.sql. A separate
 * table rather than overloading activity_log: referral_agents partners are
 * not claims/homeowners, and reusing activity_log's user_id-keyed shape
 * would require a user_id every partner row may not have at recruit-code-
 * linked signup time.
 *
 * Opt-out (KEVIN CORRECTION Q1): every onboarding email carries a signed,
 * per-partner unsubscribe link, mirroring D-320's homeowner mechanism
 * exactly (see ./optout.ts and supabase/functions/partner-email-optout/).
 * No configured signing secret (PARTNER_ONBOARDING_OPTOUT_SECRET unset) ->
 * this function sends NOTHING, same CAN-SPAM posture as D-320's own
 * canSendWithOptOut gate. Clicking the link sets
 * referral_agents.onboarding_opted_out_at, a permanent stop condition
 * selectStage checks first, same shape as P-2's activation gate. THIS
 * MECHANISM IS FLAGGED FOR LEGAL-READ AT REVIEW.
 *
 * Email only. SMS is explicitly OUT OF SCOPE for this build: `git grep -n
 * "D-328" -- supabase js '*.html'` returns zero hits in this repo (no D-328
 * SMS-consent pattern exists to copy), and there is no partner SMS opt-in
 * column/table anywhere in referral_agents or its migrations — sending SMS
 * without a consent record would violate the same opt-in requirement the
 * task itself names. No SMS code path exists in this function, at all.
 *
 * is_test / bot-pattern handling: identical convention to P-3's
 * notify-admin-new-partner (see ./bot-pattern.ts's file comment for why
 * it's a verbatim copy, not a shared import) — is_test=true always sends,
 * with a "[TEST] " subject prefix, and wins over a bot-pattern email match;
 * a bot-pattern email WITHOUT is_test=true is skipped entirely (no send).
 *
 * Auth: same three-way CRON_SECRET gate as send-homeowner-next-steps /
 * send-home-profile-prompt — X-Cron-Secret header, or a service-role
 * Bearer, or permissive when CRON_SECRET is unset (dev/staging).
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MAILGUN_API_KEY, CRON_SECRET,
 *   PARTNER_ONBOARDING_OPTOUT_SECRET, PARTNER_ONBOARDING_OPTOUT_SECRET_PREVIOUS (optional)
 *
 * All actual guard logic (kill switch, opt-out gate, stage selection,
 * placeholder-copy check, agent_type routing, bot-pattern/is_test, the
 * claim/send/mark idempotency sequence) lives in ./run-sweep.ts's
 * runOnboardingSweep, which is exercised entirely by run-sweep.test.ts with
 * fake dependencies — this file only wires those dependencies to real
 * Supabase/Mailgun and shapes the HTTP response.
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { runOnboardingSweep, type RunDeps } from "./run-sweep.ts";
import { PARTNER_ONBOARDING_SETTING_KEY } from "./kill-switch.ts";
import type { PartnerRow } from "./onboarding-stage.ts";
import { STALE_PENDING_MINUTES } from "./onboarding-stage.ts";
import {
  buildPartnerOptOutUrl,
  canSendWithOptOut,
  PARTNER_OPTOUT_SECRET_ENV,
  signPartnerOptOutToken,
} from "./optout.ts";

const FUNCTION_NAME = "send-partner-onboarding";
const BATCH_LIMIT = 500;

const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
    "Vary": "Origin",
  };
}

function jsonResponse(data: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sendMailgunEmail(
  apiKey: string,
  to: string,
  subject: string,
  textBody: string,
  htmlBody: string,
): Promise<{ ok: boolean; mailgunId?: string; error?: string }> {
  const formData = new URLSearchParams();
  formData.append("from", "Otter Quotes <notifications@mail.otterquote.com>");
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", textBody);
  formData.append("html", htmlBody);
  try {
    const res = await fetch("https://api.mailgun.net/v3/mail.otterquote.com/messages", {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`api:${apiKey}`)}` },
      body: formData,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "(unreadable)");
      return { ok: false, error: `Mailgun ${res.status}: ${errText}` };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, mailgunId: (data as { id?: string })?.id };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405, corsHeaders);
  }

  // Health-check bypass — matches send-homeowner-next-steps' own pattern —
  // runs BEFORE the CRON_SECRET gate so a bare {status:"ok"} probe never 401s.
  try {
    const bodyPeek = await req.clone().json().catch(() => ({}));
    if (bodyPeek?.health_check === true) {
      return jsonResponse({ status: "ok" }, 200, corsHeaders);
    }
  } catch (_) {
    // fall through to normal handling
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const mailgunApiKey = Deno.env.get("MAILGUN_API_KEY");
  const cronSecret = Deno.env.get("CRON_SECRET");
  // Kevin correction Q1 — the CURRENT signing secret only is ever used to
  // SIGN a new link (rotation-safe verification, on the reader side, lives
  // entirely in partner-email-optout; this function never verifies).
  const optOutSecret = Deno.env.get(PARTNER_OPTOUT_SECRET_ENV);
  const functionsBaseUrl = `${(supabaseUrl || "").replace(/\/$/, "")}/functions/v1`;

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: "Server configuration error" }, 500, corsHeaders);
  }

  // ── Authorization (same three-way gate as send-homeowner-next-steps) ─────
  const incomingCronSecret = req.headers.get("X-Cron-Secret");
  const authHeader = req.headers.get("Authorization") || "";
  let authorized = false;
  if (!cronSecret) {
    authorized = true;
  } else if (incomingCronSecret && incomingCronSecret === cronSecret) {
    authorized = true;
  } else if (authHeader.startsWith("Bearer ")) {
    authorized = authHeader.slice(7) === serviceRoleKey;
  }
  if (!authorized) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401, corsHeaders);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const deps: RunDeps = {
    readSetting: async () => {
      const { data, error } = await supabase
        .from("platform_settings")
        .select("value")
        .eq("key", PARTNER_ONBOARDING_SETTING_KEY)
        .maybeSingle();
      if (error) {
        console.error(`[${FUNCTION_NAME}] ${PARTNER_ONBOARDING_SETTING_KEY} read failed — treating as disabled:`, error.message);
        return null;
      }
      return data ? { value: data.value } : null;
    },
    // Kevin correction Q1 — computed ONCE, ahead of any candidate scan, same
    // CAN-SPAM posture and position as D-320's canSendWithOptOut.
    optOutSecretConfigured: canSendWithOptOut(optOutSecret),
    fetchCandidatePartners: async () => {
      const { data, error } = await supabase
        .from("referral_agents")
        .select("id, created_at, agent_type, is_test, email, app_first_signed_in_launch_at, onboarding_opted_out_at")
        .is("app_first_signed_in_launch_at", null)
        // Kevin correction Q1: an opted-out partner is excluded from the scan
        // entirely, same load-reduction reasoning as the activation filter —
        // selectStage's own opt-out gate is the source of truth either way.
        .is("onboarding_opted_out_at", null)
        .order("created_at", { ascending: true })
        .limit(BATCH_LIMIT);
      if (error) {
        console.error(`[${FUNCTION_NAME}] candidate scan failed:`, error.message);
        return [];
      }
      return (data || []) as PartnerRow[];
    },
    fetchLedgerForPartners: async (partnerIds) => {
      if (partnerIds.length === 0) return [];
      const { data, error } = await supabase
        .from("partner_onboarding_sends")
        .select("partner_id, stage, status, created_at")
        .in("partner_id", partnerIds);
      if (error) {
        console.error(`[${FUNCTION_NAME}] ledger read failed:`, error.message);
        return [];
      }
      // deno-lint-ignore no-explicit-any
      return (data || []) as any;
    },
    // Kevin correction Q3 — the atomic claim, via the DB-level conditional
    // upsert (see claim_partner_onboarding_stage() in the ledger migration).
    // Called BEFORE Mailgun, never after.
    claimStage: async (partnerId, stage) => {
      const { data, error } = await supabase.rpc("claim_partner_onboarding_stage", {
        p_partner_id: partnerId,
        p_stage: stage,
        p_stale_minutes: STALE_PENDING_MINUTES,
      });
      if (error) {
        console.error(`[${FUNCTION_NAME}] claim RPC failed for partner ${partnerId} stage ${stage} — treating as NOT claimed (fail closed):`, error.message);
        return { claimed: false };
      }
      return { claimed: data === true };
    },
    markSent: async (partnerId, stage, mailgunId) => {
      const { error } = await supabase
        .from("partner_onboarding_sends")
        .update({ status: "sent", mailgun_id: mailgunId, error: null })
        .eq("partner_id", partnerId)
        .eq("stage", stage);
      return { error: error ? { code: error.code, message: error.message } : null };
    },
    markFailed: async (partnerId, stage, errMessage) => {
      const { error } = await supabase
        .from("partner_onboarding_sends")
        .update({ status: "failed", error: errMessage })
        .eq("partner_id", partnerId)
        .eq("stage", stage);
      return { error: error ? { code: error.code, message: error.message } : null };
    },
    markSkipped: async (partnerId, stage, reason) => {
      // Fresh INSERT (backlog-superseded stages are never claimed first —
      // see run-sweep.ts) — a concurrent duplicate insert hits the unique
      // index and is a harmless 23505, tolerated by the caller.
      const { error } = await supabase.from("partner_onboarding_sends").insert({
        partner_id: partnerId,
        stage,
        status: "skipped",
        skipped_reason: reason,
      });
      return { error: error ? { code: error.code, message: error.message } : null };
    },
    buildOptOutUrl: async (partnerId) => {
      const token = await signPartnerOptOutToken(partnerId, optOutSecret as string);
      return buildPartnerOptOutUrl(functionsBaseUrl, token);
    },
    sendEmail: (to, subject, textBody, htmlBody) => {
      if (!mailgunApiKey) {
        console.warn(`[${FUNCTION_NAME}] MAILGUN_API_KEY not set — no email sent (dev/staging)`);
        return Promise.resolve({ ok: true });
      }
      return sendMailgunEmail(mailgunApiKey, to, subject, textBody, htmlBody);
    },
    log: (level, message) => console[level](`[${FUNCTION_NAME}] ${message}`),
    now: Date.now(),
  };

  const outcome = await runOnboardingSweep(deps);

  if ("skipped" in outcome) {
    return jsonResponse({ ok: true, skipped: outcome.skipped }, 200, corsHeaders);
  }

  const sent = outcome.results.filter((r) => r.sent).length;
  return jsonResponse(
    {
      ok: true,
      processed: sent,
      results: outcome.results,
    },
    200,
    corsHeaders,
  );
});
