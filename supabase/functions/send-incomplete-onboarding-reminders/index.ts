/**
 * Otter Quotes Edge Function: send-incomplete-onboarding-reminders
 *
 * Runs daily via pg_cron. Finds contractors who:
 *   - Clicked their magic link (contractor record exists, onboarding_step = 1)
 *   - Created more than 24 hours ago
 *   - Have NOT yet received a partial-completion reminder email
 *
 * Sends each a branded reminder email with a link back to contractor-pre-approval.html,
 * then stamps partial_completion_email_sent_at = now() to prevent re-sending.
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

function buildReminderEmail(contactName: string): string {
  const previewName = contactName ? `Hi ${contactName.split(' ')[0]},` : 'Hi there,';
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr>
          <td align="left" style="background:#0B1929;padding:24px 32px;">
            <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Otter Quotes</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
            <p style="margin:0 0 16px;font-size:16px;color:#1E293B;">${previewName}</p>
            <p style="margin:0 0 16px;font-size:16px;color:#1E293B;line-height:1.6;">
              You started your application to join the Otter Quotes contractor network but haven't finished yet.
            </p>
            <p style="margin:0 0 24px;font-size:16px;color:#1E293B;line-height:1.6;">
              It only takes a few more minutes to complete. Pick up right where you left off — your progress has been saved.
            </p>
            <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
              <tr>
                <td style="background:#E07B00;border-radius:8px;padding:14px 28px;">
                  <a href="https://otterquote.com/contractor-pre-approval.html"
                     style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;display:block;">
                    Complete Your Application →
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 8px;font-size:14px;color:#64748B;line-height:1.6;">
              Once approved, you'll receive signed contracts directly — no cold calls, no chasing prospects.
            </p>
            <p style="margin:0;font-size:14px;color:#64748B;">
              Questions? Reply to this email or contact
              <a href="mailto:support@otterquote.com" style="color:#E07B00;">support@otterquote.com</a>.
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
            <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
            &nbsp;&nbsp;|&nbsp;&nbsp;
            <a href="tel:+18448753412" style="color:#0EA5E9;text-decoration:none;">(844) 875-3412</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

async function sendMailgunEmail(
  apiKey: string,
  domain: string,
  to: string,
  contactName: string
): Promise<boolean> {
  const formData = new URLSearchParams();
  formData.append("from",    `Otter Quotes <notifications@${domain}>`);
  formData.append("to",      to);
  formData.append("subject", "Don't forget — finish your Otter Quotes application");
  formData.append("text",    `Hi ${contactName || 'there'},\n\nYou started your application to join the Otter Quotes contractor network but haven't finished yet.\n\nPick up where you left off: https://otterquote.com/contractor-pre-approval.html\n\nQuestions? Contact support@otterquote.com`);
  formData.append("html",    buildReminderEmail(contactName));

  const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`api:${apiKey}`)}` },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Mailgun error sending to ${to}: ${res.status} ${errText}`);
    return false;
  }
  return true;
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Health check ping
  try {
    const bodyPeek = await req.clone().json().catch(() => ({}));
    if (bodyPeek?.health_check === true) {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }
  } catch { /* no-op */ }

  const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const MAILGUN_API_KEY       = Deno.env.get("MAILGUN_API_KEY")!;
  const MAILGUN_DOMAIN        = Deno.env.get("MAILGUN_DOMAIN")!;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  let sent = 0;
  let errors = 0;

  try {
    // Find contractors who started onboarding but stalled at step 1 for >24 hours
    const { data: stalled, error: queryErr } = await supabase
      .from("contractors")
      .select("id, email, contact_name, created_at")
      .eq("onboarding_step", 1)
      .lt("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .is("partial_completion_email_sent_at", null)
      .neq("status", "active")   // never email already-active contractors
      .neq("status", "inactive"); // never email rejected contractors

    if (queryErr) throw queryErr;

    console.log(`[incomplete-onboarding] Found ${stalled?.length ?? 0} stalled contractors`);

    for (const contractor of stalled ?? []) {
      const ok = await sendMailgunEmail(
        MAILGUN_API_KEY,
        MAILGUN_DOMAIN,
        contractor.email,
        contractor.contact_name || ""
      );

      if (ok) {
        // Stamp to prevent re-sending
        const { error: updateErr } = await supabase
          .from("contractors")
          .update({ partial_completion_email_sent_at: new Date().toISOString() })
          .eq("id", contractor.id);

        if (updateErr) {
          console.error(`Failed to stamp partial_completion_email_sent_at for ${contractor.id}:`, updateErr);
          errors++;
        } else {
          sent++;
        }
      } else {
        errors++;
      }
    }

    // Log to cron_health
    await supabase.rpc("record_cron_health", {
      p_job_name: "send-incomplete-onboarding-reminders",
      p_status:   errors === 0 ? "success" : "error",
      p_error:    errors > 0 ? `${errors} send failures` : null,
    });

    return new Response(JSON.stringify({ status: "ok", sent, errors }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[incomplete-onboarding] Fatal error:", err);

    await supabase.rpc("record_cron_health", {
      p_job_name: "send-incomplete-onboarding-reminders",
      p_status:   "error",
      p_error:    String(err),
    }).catch(() => {});

    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
