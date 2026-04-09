// ============================================================
// Supabase Edge Function: notify-feature-request
//
// Triggered by a Database Webhook on INSERT to feature_requests.
// Sends an email to Dustin via Mailgun whenever a contractor
// submits a feature request.
//
// Required secrets (already set in Supabase Dashboard):
//   MAILGUN_API_KEY
//   MAILGUN_DOMAIN
// ============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    const MAILGUN_API_KEY = Deno.env.get("MAILGUN_API_KEY");
    const MAILGUN_DOMAIN  = Deno.env.get("MAILGUN_DOMAIN");

    if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) {
      throw new Error("Mailgun credentials not configured. Set MAILGUN_API_KEY and MAILGUN_DOMAIN in Supabase secrets.");
    }

    // Supabase Database Webhook sends the row as { type, table, record, old_record }
    const payload = await req.json();
    const record = payload.record ?? payload; // graceful fallback

    const contractorName  = record.contractor_name  ?? "Unknown Contractor";
    const contractorEmail = record.contractor_email ?? "Unknown Email";
    const requestText     = record.request_text     ?? "(no text)";
    const createdAt       = record.created_at
      ? new Date(record.created_at).toLocaleString("en-US", { timeZone: "America/Chicago" })
      : new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });

    // ── Plain-text body ──────────────────────────────────────
    const textBody = [
      "New feature request submitted on OtterQuote.",
      "",
      `Contractor : ${contractorName}`,
      `Email      : ${contractorEmail}`,
      `Submitted  : ${createdAt} (CT)`,
      "",
      "─────────────────────────────────",
      requestText,
      "─────────────────────────────────",
      "",
      "View all requests in your Supabase dashboard:",
      "https://app.supabase.com → Table Editor → feature_requests",
    ].join("\n");

    // ── HTML body ────────────────────────────────────────────
    const htmlBody = `
      <div style="font-family:sans-serif; max-width:600px; margin:0 auto; color:#0B1929;">
        <div style="background:#0B1929; padding:20px 24px; border-radius:8px 8px 0 0;">
          <h2 style="color:#F59E0B; margin:0; font-size:1.1rem;">🦦 New OtterQuote Feature Request</h2>
        </div>
        <div style="background:#F8FAFC; padding:24px; border:1px solid #E2E8F0; border-top:none; border-radius:0 0 8px 8px;">
          <table style="width:100%; border-collapse:collapse; font-size:0.9rem; margin-bottom:20px;">
            <tr>
              <td style="padding:6px 0; color:#64748B; width:110px;">Contractor</td>
              <td style="padding:6px 0; font-weight:600;">${escapeHtml(contractorName)}</td>
            </tr>
            <tr>
              <td style="padding:6px 0; color:#64748B;">Email</td>
              <td style="padding:6px 0;"><a href="mailto:${escapeHtml(contractorEmail)}" style="color:#0369A1;">${escapeHtml(contractorEmail)}</a></td>
            </tr>
            <tr>
              <td style="padding:6px 0; color:#64748B;">Submitted</td>
              <td style="padding:6px 0;">${escapeHtml(createdAt)} CT</td>
            </tr>
          </table>
          <div style="background:white; border:1px solid #CBD5E1; border-radius:6px; padding:16px; font-size:0.95rem; line-height:1.6; white-space:pre-wrap;">${escapeHtml(requestText)}</div>
          <p style="margin-top:20px; font-size:0.8rem; color:#94A3B8;">
            View all requests in your
            <a href="https://app.supabase.com" style="color:#0369A1;">Supabase dashboard</a>
            → Table Editor → feature_requests
          </p>
        </div>
      </div>
    `;

    // ── Send via Mailgun ──────────────────────────────────────
    const fromAddress = `OtterQuote <notifications@${MAILGUN_DOMAIN}>`;
    const basicAuth   = btoa(`api:${MAILGUN_API_KEY}`);

    const formData = new FormData();
    formData.append("from",    fromAddress);
    formData.append("to",      "dustinstohler1@gmail.com");
    formData.append("subject", `🦦 Feature Request — ${contractorName}`);
    formData.append("text",    textBody);
    formData.append("html",    htmlBody);

    const mgRes = await fetch(
      `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`,
      {
        method:  "POST",
        headers: { Authorization: `Basic ${basicAuth}` },
        body:    formData,
      }
    );

    if (!mgRes.ok) {
      const errText = await mgRes.text();
      throw new Error(`Mailgun error ${mgRes.status}: ${errText}`);
    }

    const mgData = await mgRes.json();
    console.log("notify-feature-request: email sent, Mailgun ID:", mgData.id);

    return new Response(
      JSON.stringify({ success: true, mailgun_id: mgData.id }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("notify-feature-request error:", err);
    return new Response(
      JSON.stringify({ success: false, error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});

// ── Utility ─────────────────────────────────────────────────
function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
