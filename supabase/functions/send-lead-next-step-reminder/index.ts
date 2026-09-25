/**
 * OtterQuote Edge Function: send-lead-next-step-reminder
 *
 * gh-2121 (LRS HO-1 S21) — ONE next-step reminder email, sent the day after
 * a router lead is captured, only if no goal event has been recorded for it
 * (a $15 measurement purchase or a loss-sheet upload — the PR #2163
 * write-back), only to leads with an email. Sits on top of the human
 * callback; never duplicates it. Scope and copy source are the module
 * header comments in ./select-candidates.ts and ./email-content.ts.
 *
 * A NEW Edge Function rather than a branch inside send-homeowner-next-steps
 * (Sloane's own build recommendation, #2121 comment 5821796976, question 1):
 * that function is keyed to post-signup `claims` rows with its own cron
 * predicate and idempotency stamp; this one is pre-signup `leads`, a
 * different table, a different one-day timer, and a different stop
 * condition.
 *
 * ─── KILL SWITCH (defaults OFF — see the migration file's header) ─────────
 * rate_limit_config.enabled for function_name='send-lead-next-step-reminder'
 * (this repo's existing per-function kill switch — same table
 * resend-hover-link/index.ts already reads for its own "Global kill switch
 * check"). Read FIRST, unconditionally: while it is false or the row is
 * missing, this function sends nothing and returns { sent: 0,
 * skipped_disabled: true } without running any other query. Turning it on
 * is a separate decision, deliberately not made by this PR (see the
 * migration file's header for the stop-condition gap that keeps it OFF).
 *
 * ─── STOP CONDITION ─────────────────────────────────────────────────────
 * "No goal event has been recorded" is read as: `leads.converted_user_id IS
 * NULL` (no account linked at all — certainly no goal), OR the account IS
 * linked but `public.lead_goal_events` (PR #2163, service_role-only) has no
 * row for this lead with `goal_at IS NOT NULL`. Per Sloane's own
 * recommendation (#2121 comment 5821796976, question 2), this reads
 * `leads.converted_user_id` as the primary signal and the view only when an
 * account IS linked, rather than joining the view unconditionally — fewer
 * moving parts for a send-gate, and the view is over the same underlying
 * write in either case.
 *
 * ─── IDEMPOTENCY ────────────────────────────────────────────────────────
 * The candidate UPDATE stamps `next_step_reminder_sent_at` in the same
 * statement that selects the row (`UPDATE ... WHERE next_step_reminder_
 * sent_at IS NULL ... RETURNING`), the same atomic check-and-stamp pattern
 * `get_lead_prefill()` already uses on this table for `prefill_used_at` — a
 * lead can be claimed by exactly one run, never double-sent by a concurrent
 * or retried invocation.
 *
 * Environment variables (expected already set in Supabase secrets — the
 * first three because send-homeowner-next-steps and every other Edge
 * Function in this repo already require them; the opt-out secret because
 * lead-next-step-optout, this same PR, reads it too):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   MAILGUN_API_KEY,
 *   HOMEOWNER_OPTOUT_SECRET, HOMEOWNER_OPTOUT_SECRET_PREVIOUS (optional)
 *
 * Invoked on a schedule (Supabase cron / pg_cron -> HTTP, matching this
 * repo's existing scheduled Edge Functions such as process-payout-reminders
 * and send-homeowner-next-steps) — NOT wired up by this PR (no cron
 * schedule config is added here; see the PR body's "not applied" note,
 * matching the migration itself).
 *
 * Refs #2121
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { buildLeadReminderEmail } from "./email-content.ts";
import {
  LEAD_OPTOUT_SECRET_ENV,
  LEAD_OPTOUT_SECRET_PREVIOUS_ENV,
  buildLeadOptOutUrl,
  signLeadOptOutToken,
} from "./lead-optout-token.ts";
import {
  type CandidateLead,
  REMINDER_MAX_AGE_MS,
  REMINDER_MIN_AGE_MS,
  selectLeadForReminder,
} from "./select-candidates.ts";

const FUNCTION_NAME = "send-lead-next-step-reminder";
const BATCH_LIMIT = 200;
const FUNCTIONS_BASE_URL = "https://yeszghaspzwwstvsrioa.supabase.co/functions/v1";

async function sendMailgunEmail(
  apiKey: string,
  to: string,
  subject: string,
  textBody: string,
  htmlBody: string,
  optOutUrl: string,
): Promise<{ ok: boolean; mailgunId?: string; error?: string }> {
  const formData = new URLSearchParams();
  formData.append("from", "Otter Quotes <notifications@mail.otterquote.com>");
  formData.append("to", to);
  formData.append("subject", subject);
  formData.append("text", textBody);
  formData.append("html", htmlBody);
  // RFC 8058 one-click unsubscribe, same as send-homeowner-next-steps.
  formData.append("h:List-Unsubscribe", `<${optOutUrl}>`);
  formData.append("h:List-Unsubscribe-Post", "List-Unsubscribe=One-Click");

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

interface LeadRow {
  id: string;
  email: string | null;
  name: string | null;
  created_at: string;
  is_synthetic: boolean | null;
  converted_user_id: string | null;
  next_step_reminder_sent_at: string | null;
  next_step_reminder_opted_out_at: string | null;
}

// deno-lint-ignore no-explicit-any
async function hasGoalEvent(
  supabase: any,
  leadIdsWithAccount: readonly string[],
): Promise<Set<string>> {
  if (leadIdsWithAccount.length === 0) return new Set();
  const { data, error } = await supabase
    .from("lead_goal_events")
    .select("lead_id, goal_at")
    .in("lead_id", leadIdsWithAccount);
  if (error) {
    console.error(`[${FUNCTION_NAME}] lead_goal_events read failed: ${error.message} — failing closed (no send)`);
    // Fail closed: treat every candidate with a linked account as "has a
    // goal" so a read error suppresses sends rather than risking one to a
    // lead that actually did convert.
    return new Set(leadIdsWithAccount);
  }
  const withGoal = new Set<string>();
  for (const row of (data || []) as { lead_id: string; goal_at: string | null }[]) {
    if (row.goal_at) withGoal.add(row.lead_id);
  }
  return withGoal;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const mailgunApiKey = Deno.env.get("MAILGUN_API_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(
        JSON.stringify({ error: "server configuration error: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // ── Kill switch — checked first, unconditionally ───────────────────────
    const { data: configRow } = await supabase
      .from("rate_limit_config")
      .select("enabled")
      .eq("function_name", FUNCTION_NAME)
      .maybeSingle();
    const enabled = configRow?.enabled === true;
    if (!enabled) {
      console.log(`[${FUNCTION_NAME}] disabled (rate_limit_config.enabled=false or missing) — sent nothing`);
      return new Response(JSON.stringify({ sent: 0, skipped_disabled: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const now = Date.now();
    const minCreatedAt = new Date(now - REMINDER_MAX_AGE_MS).toISOString();
    const maxCreatedAt = new Date(now - REMINDER_MIN_AGE_MS).toISOString();

    const { data: candidates, error: candErr } = await supabase
      .from("leads")
      .select(
        "id, email, name, created_at, is_synthetic, converted_user_id, next_step_reminder_sent_at, next_step_reminder_opted_out_at",
      )
      .gte("created_at", minCreatedAt)
      .lte("created_at", maxCreatedAt)
      .is("next_step_reminder_sent_at", null)
      .is("next_step_reminder_opted_out_at", null)
      .not("email", "is", null)
      .order("created_at", { ascending: true })
      .limit(BATCH_LIMIT);

    if (candErr) {
      console.error(`[${FUNCTION_NAME}] candidate query failed: ${candErr.message}`);
      return new Response(JSON.stringify({ error: candErr.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const rows = (candidates || []) as LeadRow[];
    const leadIdsWithAccount = rows
      .filter((r) => r.converted_user_id)
      .map((r) => r.id);
    const goalRecordedLeadIds = await hasGoalEvent(supabase, leadIdsWithAccount);

    if (!mailgunApiKey) {
      console.error(`[${FUNCTION_NAME}] MAILGUN_API_KEY not set — cannot send, no leads stamped`);
      return new Response(JSON.stringify({ error: "MAILGUN_API_KEY not set" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    const optOutSecrets = [
      Deno.env.get(LEAD_OPTOUT_SECRET_ENV) || "",
      Deno.env.get(LEAD_OPTOUT_SECRET_PREVIOUS_ENV) || "",
    ].filter((s) => s.length > 0);
    if (optOutSecrets.length === 0) {
      // D-320 requires a working opt-out mechanism in every commercial send —
      // fail closed rather than send with no verifiable unsubscribe link.
      console.error(`[${FUNCTION_NAME}] ${LEAD_OPTOUT_SECRET_ENV} not set — sending nothing this run`);
      return new Response(JSON.stringify({ sent: 0, error: "opt-out secret not configured" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    let sent = 0;
    const skipped: Record<string, number> = {};

    for (const row of rows) {
      const candidate: CandidateLead = {
        id: row.id,
        email: row.email,
        created_at: row.created_at,
        is_synthetic: row.is_synthetic,
        next_step_reminder_sent_at: row.next_step_reminder_sent_at,
        next_step_reminder_opted_out_at: row.next_step_reminder_opted_out_at,
        has_goal_event: row.converted_user_id ? goalRecordedLeadIds.has(row.id) : false,
      };
      const decision = selectLeadForReminder(candidate, enabled, now);
      if (!decision.send) {
        const reason = decision.skip_reason || "unknown";
        skipped[reason] = (skipped[reason] || 0) + 1;
        continue;
      }

      // Atomic check-and-stamp — same UPDATE...RETURNING shape as
      // get_lead_prefill(): if another run already claimed this row between
      // the SELECT above and here, this UPDATE touches zero rows and we skip
      // sending rather than double-send.
      const { data: stamped, error: stampErr } = await supabase
        .from("leads")
        .update({ next_step_reminder_sent_at: new Date().toISOString() })
        .eq("id", row.id)
        .is("next_step_reminder_sent_at", null)
        .select("id")
        .maybeSingle();
      if (stampErr || !stamped) {
        skipped["already_sent"] = (skipped["already_sent"] || 0) + 1;
        continue;
      }

      const token = await signLeadOptOutToken(row.id, optOutSecrets[0]);
      const optOutUrl = buildLeadOptOutUrl(FUNCTIONS_BASE_URL, token);
      const { subject, textBody, htmlBody } = buildLeadReminderEmail(row.id, row.name, optOutUrl);
      const result = await sendMailgunEmail(mailgunApiKey, row.email as string, subject, textBody, htmlBody, optOutUrl);
      if (!result.ok) {
        console.error(`[${FUNCTION_NAME}] Mailgun send failed for lead ${row.id}: ${result.error}`);
        // Row stays stamped (sent_at already set) — "at most once" holds even
        // on a Mailgun failure; a retry storm on a bad address is worse than
        // one missed reminder.
        continue;
      }
      sent += 1;
    }

    return new Response(JSON.stringify({ sent, candidates: rows.length, skipped }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] unexpected failure: ${String(err)}`);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
