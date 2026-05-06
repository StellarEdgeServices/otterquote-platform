/**
 * OtterQuote Edge Function: process-payout-reminders
 *
 * D-180 — Daily Payout Reminder + Auto-Approve Cron
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
 * JOB 2 — Auto-Approve:
 *   Find payout_approvals where:
 *     status = 'pending_approval'
 *     AND auto_approve_at < NOW()
 *   Auto-approve: set status = 'auto_approved', approved_at = NOW().
 *   Set referrals.commission_paid_at = NOW() on associated referrals.
 *   Send Dustin a summary email of what auto-approved.
 *
 * JOB 3 — Catch-up notifications:
 *   Find payout_approvals where:
 *     status = 'pending_approval'
 *     AND notification_sent_at IS NULL
 *   Call notify-payout-pending for each (in case pg_net failed on creation).
 *
 * ── Auth ─────────────────────────────────────────────────────────────────────
 *   No JWT required — invoked by pg_cron using service role bearer token.
 *   Listed in checklist exceptions (cron-invoked functions).
 *
 * ── Rate limiting ─────────────────────────────────────────────────────────────
 *   Checked at function level (caller_id = null). Cap: 10/day.
 *
 * ── Returns ──────────────────────────────────────────────────────────────────
 *   {
 *     remindersDigestSent: boolean,
 *     pendingReminderCount: number,
 *     autoApproved: number,
 *     catchupNotified: number,
 *     errors: string[],
 *     ranAt: string
 *   }
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY, MAILGUN_DOMAIN
 *
 * ClickUp: 86e11617y
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

function emailFooter(): string {
  return `
<table width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
      <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
    </td>
  </tr>
</table>`.trim();
}

function buildEmail(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr>
          <td align="left" style="background:#0B1929;padding:24px 32px;">
            <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                         font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">
              Otter Quotes
            </span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
            ${bodyHtml}
          </td>
        </tr>
        <tr><td>${emailFooter()}</td></tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();
}

function ctaButton(text: string, url: string, color = "#E07B00"): string {
  return `
<table cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
  <tr>
    <td align="center" bgcolor="${color}" style="border-radius:8px;">
      <a href="${url}" style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         font-size:16px;font-weight:700;color:#0B1929;text-decoration:none;padding:14px 28px;">
        ${text}
      </a>
    </td>
  </tr>
</table>`.trim();
}

function formatCurrency(amount: number): string {
  return `$${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPayoutType(type: string): string {
  return type === "commission_referral" ? "Referral" : "Recruit Bonus";
}

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
    autoApproved:         0,
    catchupNotified:      0,
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
    } else if (!rlData) {
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
      .select("id, partner_name, amount, payout_type, trigger_event, created_at, auto_approve_at")
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

      const rowsHtml = pendingReminder.map(p => {
        const autoApproveOn = p.auto_approve_at
          ? new Date(p.auto_approve_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
          : "—";
        return `
<tr>
  <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;color:#0B1929;">${p.partner_name || "Unknown"}</td>
  <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;color:#64748B;">${formatPayoutType(p.payout_type)}</td>
  <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;font-weight:600;color:#0B1929;">${formatCurrency(Number(p.amount))}</td>
  <td style="padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;color:#EF4444;">${autoApproveOn}</td>
</tr>`;
      }).join("");

      const reminderBodyHtml = `
<h2 style="font-size:1.5rem;font-weight:700;color:#0B1929;margin:0 0 8px;">
  ⏰ Reminder: ${pendingReminder.length} Commission${pendingReminder.length === 1 ? "" : "s"} Awaiting Approval
</h2>
<p style="color:#374151;font-size:0.95rem;margin:0 0 24px;">
  The following commissions have been pending for more than 2 days and require your review.
  Total pending: <strong>${formatCurrency(totalAmount)}</strong>
</p>

<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="border-radius:8px;border:1px solid #E2E8F0;overflow:hidden;margin-bottom:24px;">
  <thead>
    <tr style="background:#F8FAFC;">
      <th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Partner</th>
      <th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Type</th>
      <th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Amount</th>
      <th style="padding:10px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Auto-Approves</th>
    </tr>
  </thead>
  <tbody>${rowsHtml}</tbody>
</table>

${ctaButton("Review All Pending Approvals →", ADMIN_PAYOUTS_URL)}
`;

      const reminderBodyText = [
        `Reminder: ${pendingReminder.length} commission(s) awaiting approval (>2 days pending)`,
        `Total: ${formatCurrency(totalAmount)}`,
        ``,
        ...pendingReminder.map(p =>
          `- ${p.partner_name || "Unknown"}: ${formatCurrency(Number(p.amount))} (${formatPayoutType(p.payout_type)})`
        ),
        ``,
        `Review here: ${ADMIN_PAYOUTS_URL}`,
      ].join("\n");

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
    // JOB 2 — Auto-approve overdue rows
    // ════════════════════════════════════════════════════════════════════════
    const now = new Date().toISOString();

    const { data: autoApproveRows, error: aaError } = await supabase
      .from("payout_approvals")
      .select("id, referral_id, partner_name, amount, payout_type")
      .eq("status", "pending_approval")
      .lt("auto_approve_at", now);

    if (aaError) {
      results.errors.push(`Auto-approve query error: ${aaError.message}`);
      console.error(`[${FUNCTION_NAME}] Auto-approve query error:`, aaError.message);
    } else if (autoApproveRows && autoApproveRows.length > 0) {
      const approvedAt = new Date().toISOString();

      for (const row of autoApproveRows) {
        try {
          // Update payout_approvals
          const { error: updateError } = await supabase
            .from("payout_approvals")
            .update({ status: "auto_approved", approved_at: approvedAt })
            .eq("id", row.id)
            .eq("status", "pending_approval"); // double-check status guard

          if (updateError) {
            results.errors.push(`Auto-approve update failed for ${row.id}: ${updateError.message}`);
            continue;
          }

          // Set referrals.commission_paid_at
          if (row.referral_id) {
            const { error: referralError } = await supabase
              .from("referrals")
              .update({ commission_paid_at: approvedAt })
              .eq("id", row.referral_id)
              .is("commission_paid_at", null);

            if (referralError) {
              results.errors.push(`Auto-approve: referral update failed for ${row.referral_id}: ${referralError.message}`);
            }
          }

          results.autoApproved++;
        } catch (err) {
          results.errors.push(`Auto-approve row ${row.id} threw: ${String(err)}`);
        }
      }

      // Send Dustin a summary of what auto-approved
      if (results.autoApproved > 0) {
        const autoTotal = autoApproveRows
          .slice(0, results.autoApproved)
          .reduce((sum, r) => sum + Number(r.amount), 0);

        const autoRowsHtml = autoApproveRows.map(r => `
<tr>
  <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;color:#0B1929;">${r.partner_name || "Unknown"}</td>
  <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;color:#64748B;">${formatPayoutType(r.payout_type)}</td>
  <td style="padding:8px 12px;border-bottom:1px solid #E2E8F0;font-size:0.875rem;font-weight:600;color:#0B1929;">${formatCurrency(Number(r.amount))}</td>
</tr>`).join("");

        const autoBodyHtml = `
<h2 style="font-size:1.5rem;font-weight:700;color:#0B1929;margin:0 0 8px;">
  Auto-Approval Summary
</h2>
<p style="color:#374151;font-size:0.95rem;margin:0 0 24px;">
  ${results.autoApproved} commission${results.autoApproved === 1 ? "" : "s"} were automatically approved after 7 days with no action.
  Total auto-approved: <strong>${formatCurrency(autoTotal)}</strong>
</p>
<table width="100%" cellpadding="0" cellspacing="0" border="0"
       style="border-radius:8px;border:1px solid #E2E8F0;overflow:hidden;margin-bottom:24px;">
  <thead>
    <tr style="background:#F8FAFC;">
      <th style="padding:8px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Partner</th>
      <th style="padding:8px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Type</th>
      <th style="padding:8px 12px;text-align:left;font-size:0.8rem;color:#64748B;font-weight:600;">Amount</th>
    </tr>
  </thead>
  <tbody>${autoRowsHtml}</tbody>
</table>
${ctaButton("View Full History →", ADMIN_PAYOUTS_URL)}
`;

        await sendMailgunEmail(
          mailgunApiKey, mailgunDomain, ADMIN_EMAIL, fromAddress,
          `Auto-approved: ${results.autoApproved} commission${results.autoApproved === 1 ? "" : "s"} (${formatCurrency(autoTotal)})`,
          `${results.autoApproved} commissions auto-approved after 7 days. Total: ${formatCurrency(autoTotal)}\n\nView: ${ADMIN_PAYOUTS_URL}`,
          buildEmail(autoBodyHtml)
        );
      }
    } else {
      console.log(`[${FUNCTION_NAME}] No auto-approvals needed.`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // JOB 3 — Catch-up: notify for rows where notification_sent_at IS NULL
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
    return new Response(JSON.stringify({ ok: false, ...results }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
    // Record cron health — unhandled error
    const supabaseUrlErr = Deno.env.get("SUPABASE_URL");
    const serviceKeyErr = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (supabaseUrlErr && serviceKeyErr) {
      const supabaseErr = createClient(supabaseUrlErr, serviceKeyErr);
      const errorMsg = err?.message || String(err);
      await supabaseErr.rpc("record_cron_health", {
        p_job_name: FUNCTION_NAME,
        p_status: "error",
        p_error: errorMsg.length > 500 ? errorMsg.substring(0, 500) : errorMsg,
      }).catch((e) => {
        console.error(`[${FUNCTION_NAME}] Failed to record unhandled error in cron_health:`, e);
      });
    }
  }
});
  