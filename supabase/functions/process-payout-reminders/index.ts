/**
 * OtterQuote Edge Function: process-payout-reminders
 *
 * D-180 — Daily Payout Reminder Cron (auto-approve removed per D-293,
 * 2026-08-18, gh-1021 AC1 — no outbound payment rail exists, so nothing may
 * silently self-approve; every commission now waits for Dustin to approve
 * it manually via admin-payouts.html)
 *
 * Schedule: "0 9 * * *" (9:00 AM daily — matches process-coi-reminders cadence)
 * Can also be POST-ed manually for testing.
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 *
 * JOB 1 — Day-2 Reminders:
 *   Find payout_approvals where:
 *     status = 'pending_approval'
 *     AND reminder_sent_at IS NULL
 *     AND created_at < NOW() - INTERVAL '2 days'
 *   Send Dustin a single digest email listing all pending approvals
 *   with amounts and partner names. Set reminder_sent_at = NOW().
 *
 * JOB 2 — Catch-up notifications:
 *   Find payout_approvals where:
 *     status = 'pending_approval'
 *     AND notification_sent_at IS NULL
 *   Call notify-payout-pending for each (in case pg_net failed on creation).
 *
 * JOB 3 — W-9 requests (#596):
 *   Find partners who have a pending_approval accrual AND payments_blocked
 *   AND w9_notification_sent_at IS NULL. Call notify-partner-w9 for each and
 *   stamp w9_notification_sent_at only on a confirmed send.
 *   Restores the notification v49 designed into apply_referral_commission()
 *   and a later rewrite dropped, without touching the payment trigger. Also
 *   catches accruals that predate the fix.
 *
 * ── Auth ─────────────────────────────────────────────────────────────────────
 *   verify_jwt = false (see supabase/config.toml). Access is gated by CRON_SECRET
 *   instead — callers must pass "Authorization: Bearer <CRON_SECRET>". The pg_cron
 *   job must include this header. This is the standard Supabase cron-exception pattern.
 *
 * ── Rate limiting ─────────────────────────────────────────────────────────────
 *   Checked at function level (caller_id = null). Cap: 10/day.
 *
 * ── Returns ──────────────────────────────────────────────────────────────────
 *   {
 *     remindersDigestSent: boolean,
 *     pendingReminderCount: number,
 *     catchupNotified: number,
 *     w9RequestsSent: number,
 *     errors: string[],
 *     ranAt: string
 *   }
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY, MAILGUN_DOMAIN
 *   CRON_SECRET          — shared secret; set via `supabase secrets set CRON_SECRET=<value>`
 *
 * ClickUp: 86e11617y
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { readW9GateFlag, shouldSkipW9ReminderJob } from "./w9-gate.ts";
import { buildEmail, reminderDigestBodyHtml, reminderDigestBodyText } from "./templates.ts"; // gh-1824: email body moved to templates.ts (testable, no serve() import)

const FUNCTION_NAME     = "process-payout-reminders";
const ADMIN_EMAIL       = "dustinstohler1@gmail.com";
const ADMIN_PAYOUTS_URL = "https://otterquote.com/admin-payouts.html";

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
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

// =============================================================================
// EMAIL HELPERS
// =============================================================================
// gh-1824: buildEmail/emailButton/formatCurrency/formatPayoutType and the
// digest body builders moved to ./templates.ts (testable without importing
// this file's top-level serve() call). See templates.ts / templates.test.ts.

async function sendMailgunEmail(
  apiKey: string, domain: string, to: string, from: string,
  subject: string, text: string, html?: string
): Promise<boolean> {
  const basicAuth = btoa(`api:${apiKey}`);
  const formData = new URLSearchParams();
  formData.append("from", from); formData.append("to", to);
  formData.append("subject", subject); formData.append("text", text);
  if (html) formData.append("html", html);
  try {
    const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: "POST", headers: { Authorization: `Basic ${basicAuth}` }, body: formData,
    });
    if (!response.ok) {
      const err = await response.text();
      console.error(`[${FUNCTION_NAME}] Mailgun error (${response.status}):`, err);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] Mailgun fetch threw:`, err);
    return false;
  }
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  const startTime = Date.now();

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Cron-secret gate — required on all non-OPTIONS requests (verify_jwt = false for this function)
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl    = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const mailgunApiKey  = Deno.env.get("MAILGUN_API_KEY")!;
  const mailgunDomain  = Deno.env.get("MAILGUN_DOMAIN")!;

  if (!supabaseUrl || !serviceRoleKey || !mailgunApiKey || !mailgunDomain) {
    console.error(`[${FUNCTION_NAME}] Missing required env vars.`);
    return new Response(JSON.stringify({ ok: false, error: "Server configuration error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const fromAddress = `Otter Quotes Admin <notifications@${mailgunDomain}>`;

  const results = {
    remindersDigestSent:  false,
    pendingReminderCount: 0,
    catchupNotified:      0,
    w9RequestsSent:       0,    // #596
    errors:               [] as string[],
    ranAt:                new Date().toISOString(),
    elapsedMs:            0,
  };

  try {
    // ── Rate limiting ────────────────────────────────────────────────────────
    const { data: rlData, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_function_name: FUNCTION_NAME, p_user_id: null,
    });
    if (rlError) {
      console.error(`[${FUNCTION_NAME}] Rate limit RPC error:`, rlError.message);
    } else if (rlData?.allowed === false) {
      console.warn(`[${FUNCTION_NAME}] Rate limit exceeded — skipping run.`);
      return new Response(JSON.stringify({ ok: false, error: "Rate limit exceeded" }), {
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // JOB 1 — Day-2 reminder digest to Dustin
    // ════════════════════════════════════════════════════════════════════════
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const { data: pendingReminder, error: prError } = await supabase
      .from("payout_approvals")
      .select("id, partner_name, amount, payout_type, trigger_event, created_at")
      .eq("status", "pending_approval")
      .is("reminder_sent_at", null)
      .lt("created_at", twoDaysAgo)
      .order("created_at", { ascending: true });

    if (prError) {
      results.errors.push(`Day-2 query error: ${prError.message}`);
      console.error(`[${FUNCTION_NAME}] Day-2 query error:`, prError.message);
    } else if (pendingReminder && pendingReminder.length > 0) {
      results.pendingReminderCount = pendingReminder.length;

      // Build digest email
      const totalAmount = pendingReminder.reduce((sum, p) => sum + Number(p.amount), 0);

      const reminderBodyHtml = reminderDigestBodyHtml(pendingReminder, totalAmount, ADMIN_PAYOUTS_URL);
      const reminderBodyText = reminderDigestBodyText(pendingReminder, totalAmount, ADMIN_PAYOUTS_URL);

      const reminderSent = await sendMailgunEmail(
        mailgunApiKey, mailgunDomain, ADMIN_EMAIL, fromAddress,
        `⏰ ${pendingReminder.length} commission${pendingReminder.length === 1 ? "" : "s"} awaiting your approval`,
        reminderBodyText, buildEmail(reminderBodyHtml)
      );

      if (reminderSent) {
        results.remindersDigestSent = true;

        // Mark reminder_sent_at on all rows in this batch
        const ids = pendingReminder.map(p => p.id);
        const { error: markError } = await supabase
          .from("payout_approvals")
          .update({ reminder_sent_at: new Date().toISOString() })
          .in("id", ids);

        if (markError) {
          results.errors.push(`Failed to set reminder_sent_at: ${markError.message}`);
        }
      } else {
        results.errors.push("Day-2 reminder digest email failed to send via Mailgun.");
      }
    } else {
      console.log(`[${FUNCTION_NAME}] No day-2 reminders needed.`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // JOB 2 — Catch-up: notify for rows where notification_sent_at IS NULL
    // ════════════════════════════════════════════════════════════════════════
    //
    // (Renumbered from JOB 3.) The auto-approve sweep that used to run here
    // was deleted per D-293 (Dustin-locked 2026-08-18, gh-1021 AC1): there is
    // no outbound payment rail, ever, so nothing should ever silently
    // transition to "approved" or tell a partner their commission is "queued
    // for payment" when no payment mechanism exists. Every commission now
    // waits in pending_approval for a human (Dustin, via admin-payouts.html)
    // to approve it. auto_approve_at is left in the schema as a historical/
    // display-only column (still rendered on existing rows) but nothing
    // reads it to drive a state transition anymore.
    // The remaining AC2–AC6 of gh-1021 (paid/paid_at state, dashboard
    // cleanup, W-9+payment-info collection) are separate follow-on work.
    // ════════════════════════════════════════════════════════════════════════
    const { data: unnotified, error: unErr } = await supabase
      .from("payout_approvals")
      .select("id")
      .eq("status", "pending_approval")
      .is("notification_sent_at", null)
      .order("created_at", { ascending: true })
      .limit(20); // cap per run to avoid thundering herd

    if (unErr) {
      results.errors.push(`Catch-up query error: ${unErr.message}`);
    } else if (unnotified && unnotified.length > 0) {
      for (const row of unnotified) {
        try {
          // Call notify-payout-pending via HTTP (service role)
          const notifyRes = await fetch(
            `${supabaseUrl}/functions/v1/notify-payout-pending`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${serviceRoleKey}`,
              },
              body: JSON.stringify({ payout_approval_id: row.id }),
            }
          );
          if (notifyRes.ok) results.catchupNotified++;
          else {
            const errText = await notifyRes.text();
            results.errors.push(`Catch-up notify failed for ${row.id}: ${errText}`);
          }
        } catch (err) {
          results.errors.push(`Catch-up notify threw for ${row.id}: ${String(err)}`);
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // JOB 3 — W-9 request for partners with a held accrual (#596)
    // ════════════════════════════════════════════════════════════════════════
    //
    // v49 designed apply_referral_commission() to check payments_blocked and,
    // when true, fire the one-time W-9 request email via notify-partner-w9
    // (pg_net). A later rewrite (the #567 / D-139 audit pass) dropped BOTH the
    // check and the pg_net call. notify-partner-w9 has had no live caller
    // since — grep the repo and the only hits are the superseded v49 SQL and
    // the function's own source.
    //
    // The money gate survived (JOB 2 holds anything without a verified W-9), so
    // nothing was ever paid out incorrectly. What broke is the communication:
    // a partner earns a commission, it accrues, it is held forever, and they
    // are never told why. This job restores the notification without touching
    // the payment trigger — deliberately the lower-risk of the two options, and
    // it also catches accruals that predate the fix.
    //
    // Idempotency: referral_agents.w9_notification_sent_at (added in v49,
    // unused until now). One request per partner, ever.
    //
    // D-319 (gh-1509 half A): platform_settings.w9_gate_retired — flag OFF
    // (default; no row yet, this PR ships no seed/migration) runs JOB 3
    // exactly as before. Flag ON skips the whole job — no query, no
    // notify-partner-w9 calls, no stamps. See
    // process-payout-reminders/w9-gate.ts for the flag-read.
    const w9GateRetired = await readW9GateFlag(
      async () => await supabase.from("platform_settings").select("value").eq("key", "w9_gate_retired").maybeSingle(),
      (msg) => console.error(`[${FUNCTION_NAME}] ${msg}`)
    );

    if (shouldSkipW9ReminderJob(w9GateRetired)) {
      console.log(`[${FUNCTION_NAME}] JOB 3 SKIPPED — w9_gate_retired flag is ON`);
    } else {
    const { data: heldAccruals, error: heldErr } = await supabase
      .from("payout_approvals")
      .select("partner_id")
      .eq("status", "pending_approval")
      .not("partner_id", "is", null);

    if (heldErr) {
      results.errors.push(`W-9 request query error: ${heldErr.message}`);
    } else if (heldAccruals && heldAccruals.length > 0) {
      const partnerIds = [...new Set(heldAccruals.map((r) => r.partner_id))];

      const { data: needW9, error: needErr } = await supabase
        .from("referral_agents")
        .select("id")
        .in("id", partnerIds)
        .eq("payments_blocked", true)
        .is("w9_notification_sent_at", null)
        .limit(20); // cap per run, same rationale as JOB 3

      if (needErr) {
        results.errors.push(`W-9 request agent query error: ${needErr.message}`);
      } else if (needW9 && needW9.length > 0) {
        for (const agent of needW9) {
          try {
            const res = await fetch(
              `${supabaseUrl}/functions/v1/notify-partner-w9`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${serviceRoleKey}`,
                },
                body: JSON.stringify({ agent_id: agent.id }),
              }
            );

            if (!res.ok) {
              const errText = await res.text();
              results.errors.push(`W-9 request failed for agent ${agent.id}: ${errText}`);
              continue;
            }

            // Stamp only after a confirmed send, so a transient failure retries
            // tomorrow rather than silently burning the one-time notification.
            const { error: stampErr } = await supabase
              .from("referral_agents")
              .update({ w9_notification_sent_at: new Date().toISOString() })
              .eq("id", agent.id)
              .is("w9_notification_sent_at", null);

            if (stampErr) {
              results.errors.push(`W-9 request stamp failed for agent ${agent.id}: ${stampErr.message}`);
            }
            results.w9RequestsSent++;
          } catch (err) {
            results.errors.push(`W-9 request threw for agent ${agent.id}: ${String(err)}`);
          }
        }
      }
    }
    }

    results.elapsedMs = Date.now() - startTime;
    console.log(`[${FUNCTION_NAME}] Run complete:`, JSON.stringify(results));

    // Record cron health — success path
    const { error: healthError } = await supabase.rpc("record_cron_health", {
      p_job_name: FUNCTION_NAME,
      p_status: "success",
      p_error: null,
    });
    if (healthError) {
      console.error(`[${FUNCTION_NAME}] Failed to record cron health:`, healthError.message);
    } else {
      console.log(`[${FUNCTION_NAME}] Cron health recorded — success`);
    }

    return new Response(JSON.stringify({ ok: true, ...results }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error(`[${FUNCTION_NAME}] Unhandled error:`, err);
    results.errors.push(String(err));
    results.elapsedMs = Date.now() - startTime;

    await supabase.rpc("record_cron_health", {
      p_job_name: FUNCTION_NAME,
      p_status: "error",
      p_error: String(err).substring(0, 500),
    }).catch((e: unknown) => {
      console.error(`[${FUNCTION_NAME}] Failed to record cron_health on error:`, e);
    });

    return new Response(JSON.stringify({ ok: false, ...results }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
