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
 * Auth: verify_jwt = false (see supabase/config.toml). Access is gated by CRON_SECRET
 * instead — callers must pass "Authorization: Bearer <CRON_SECRET>". The pg_cron job
 * must include this header. This is the standard Supabase cron-exception pattern.
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 *   CRON_SECRET          — shared secret; set via `supabase secrets set CRON_SECRET=<value>`
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { buildReminderEmail, buildReminderText } from "./templates.ts"; // gh-1824: footer moved to templates.ts (testable, no serve() import)

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
  formData.append("text",    buildReminderText(contactName));
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

  // Health check ping — gh-1102: runs BEFORE the CRON_SECRET gate below, matching
  // the pattern used by every other probed function (admin-contractor-action,
  // create-payment-intent, notify-contractors, process-dunning, send-support-email).
  // platform-health-check's Phase 1 prober pings every EDGE_FUNCTIONS_TO_PING entry
  // with SUPABASE_SERVICE_ROLE_KEY, never CRON_SECRET, so with the gate first this
  // probe was rejected 401 before ever reaching this bypass — 96 escalated
  // false-positive alerts over ~2 days, zero real outage (the real pg_cron trigger
  // carries the correct CRON_SECRET and was unaffected throughout). This bypass
  // returns a static {status:"ok"} with no data access and no side effects, so
  // moving it first does not reopen the open-relay gap the CRON_SECRET gate (added
  // 2026-05-20, commit d6abdabd) exists to close for every other request shape.
  try {
    const bodyPeek = await req.clone().json().catch(() => ({}));
    if (bodyPeek?.health_check === true) {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }
  } catch { /* no-op */ }

  // Cron-secret gate — required on all non-health-check requests (verify_jwt = false for this function)
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

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

    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
