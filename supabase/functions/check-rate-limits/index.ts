/**
 * OtterQuote Edge Function: check-rate-limits
 *
 * Monitors rate limit usage and sends email alerts when any function
 * reaches 70%+ of its monthly limit. Prevents duplicate alerts with
 * an alert_sent flag in the rate_limit_config table.
 *
 * Can be triggered:
 * - Manually via REST API: POST /functions/v1/check-rate-limits
 * - By scheduled cron job (pg_cron) if set up in Supabase
 *
 * Usage:
 *   POST /functions/v1/check-rate-limits
 *   Body: {} (empty)
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   MAILGUN_API_KEY
 *   MAILGUN_DOMAIN
 *
 * ClickUp: 86e0w4x1v — Session 140, April 13, 2026
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
const MAILGUN_DOMAIN = Deno.env.get("MAILGUN_DOMAIN") || "mail.otterquote.com";
const ALERT_EMAIL = "dustinstohler1@gmail.com";
const THRESHOLD = 0.7; // 70%

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Fetch all rate limit configs
    const { data: configs, error: configError } = await supabase
      .from("rate_limit_config")
      .select("*")
      .eq("enabled", true);

    if (configError) throw configError;
    if (!configs || configs.length === 0) {
      return new Response(
        JSON.stringify({ message: "No rate limit configs found", sent_alerts: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    const alerts: string[] = [];
    const currentDate = new Date();
    const monthStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);

    // Check each function
    for (const config of configs) {
      if (!config.max_per_month || config.max_per_month === 0) continue;

      // Count calls this month
      const { data: rateLimitRecords, error: countError } = await supabase
        .from("rate_limits")
        .select("id", { count: "exact" })
        .eq("function_name", config.function_name)
        .gte("called_at", monthStart.toISOString());

      if (countError) {
        console.error(`Error counting ${config.function_name}:`, countError);
        continue;
      }

      const count = rateLimitRecords?.length || 0;
      const limit = config.max_per_month;
      const usage_percent = (count / limit) * 100;

      // Check if at or above threshold
      if (count / limit >= THRESHOLD) {
        // Check if alert was already sent (to prevent duplicate emails)
        const { data: alertStatus } = await supabase
          .from("rate_limit_config")
          .select("alert_sent_month")
          .eq("function_name", config.function_name)
          .single();

        const lastAlertMonth = alertStatus?.alert_sent_month || null;
        const currentMonth = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, "0")}`;

        // Send alert if not already sent this month
        if (lastAlertMonth !== currentMonth) {
          const alertMessage = await sendMailgunEmail(
            MAILGUN_API_KEY,
            MAILGUN_DOMAIN,
            ALERT_EMAIL,
            `OtterQuote Rate Limit Alert: ${config.function_name} at ${Math.round(usage_percent)}% of monthly limit`,
            `
Function: ${config.function_name}
Current Usage: ${count} calls
Monthly Limit: ${limit} calls
Usage: ${Math.round(usage_percent)}%

Recommendation: Review usage patterns and consider optimization or plan for increased capacity.

This is an automated alert from OtterQuote monitoring.
            `.trim()
          );

          if (alertMessage.success) {
            // Update alert_sent_month flag
            await supabase
              .from("rate_limit_config")
              .update({ alert_sent_month: currentMonth })
              .eq("function_name", config.function_name);

            alerts.push(`${config.function_name}: ${count}/${limit} (${Math.round(usage_percent)}%)`);
          }
        }
      }
    }

    return new Response(
      JSON.stringify({
        message: "Rate limit check completed",
        alerts_sent: alerts.length,
        alerts: alerts,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );
  } catch (error) {
    console.error("Error in check-rate-limits:", error);
    return new Response(
      JSON.stringify({ error: String(error) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});

// Send email via Mailgun API
async function sendMailgunEmail(
  apiKey: string,
  domain: string,
  to: string,
  subject: string,
  text: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const auth = btoa(`api:${apiKey}`);
    const formData = new FormData();
    formData.append("from", `OtterQuote Alerts <alerts@${domain}>`);
    formData.append("to", to);
    formData.append("subject", subject);
    formData.append("text", text);

    const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: errorText };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
