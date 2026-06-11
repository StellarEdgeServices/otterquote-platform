import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.104.0";

// ── 86e1tz17j: best-effort Sentry reporter for swallowed audit-write failures ──
// Inlined (not imported from _shared) because the EF body-deploy path does not
// resolve _shared imports — same precedent as create-docusign-envelope's inlined
// getHomeownerName. No-ops to console.error until SENTRY_DSN is set, so it is safe
// to deploy before the secret exists. Never throws; callers stay non-fatal.
async function reportToSentry(
  error: unknown,
  ctx: { fn: string; op?: string; extra?: Record<string, unknown> },
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[sentry:${ctx.fn}${ctx.op ? ":" + ctx.op : ""}]`, message, ctx.extra ?? "");
  const dsn = Deno.env.get("SENTRY_DSN");
  if (!dsn) return; // graceful no-op until the secret is configured
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\//, "");
    if (!projectId) return;
    const eventId = crypto.randomUUID().replace(/-/g, "");
    const sentAt = new Date().toISOString();
    const event = {
      event_id: eventId, timestamp: sentAt, platform: "javascript", level: "error",
      logger: `edge.${ctx.fn}`,
      environment: Deno.env.get("SENTRY_ENVIRONMENT") || "production",
      tags: { fn: ctx.fn, ...(ctx.op ? { op: ctx.op } : {}) },
      extra: ctx.extra ?? {},
      exception: { values: [{ type: error instanceof Error ? error.name : "EdgeFunctionError", value: message }] },
    };
    const envelope =
      JSON.stringify({ event_id: eventId, sent_at: sentAt }) + "\n" +
      JSON.stringify({ type: "event" }) + "\n" + JSON.stringify(event) + "\n";
    await fetch(`${u.protocol}//${u.host}/api/${projectId}/envelope/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=otterquote-ef/1.0, sentry_key=${u.username}` },
      body: envelope,
    });
  } catch (postErr) {
    console.error("[sentry] post failed (non-fatal):", postErr);
  }
}

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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

interface SendBidConfirmationRequest {
  quote_id: string;
  contractor_id: string;
  bid_amount: number;
  platform_fee_pct: number;
  platform_fee_amount: number;
  net_amount: number;
  property_address: string; // retained for backward compat; not used in email copy
  trade: string;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount);
}

function buildEmailHtml(
  firstName: string,
  jobNumber: string,   // D-216: "Job #XXXXXXXX"
  claimId: string,     // for rescind/review links
  trade: string,
  bidAmount: number,
  feePct: number,
  feeAmount: number
): string {
  const bidAmountFormatted = formatCurrency(bidAmount);
  const feeAmountFormatted = formatCurrency(feeAmount);
  const bidFormUrl = `https://otterquote.com/contractor-bid-form.html?claim_id=${claimId}`;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { margin-bottom: 30px; }
    .section { margin: 20px 0; padding: 15px; border-left: 4px solid #0066cc; background-color: #f5f5f5; }
    .section-title { font-weight: bold; margin-bottom: 10px; }
    .summary-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #ddd; }
    .summary-row:last-child { border-bottom: none; }
    .label { font-weight: 500; }
    .value { text-align: right; }
    .btn { display: inline-block; margin: 8px 4px; padding: 12px 24px; color: #fff; text-decoration: none; border-radius: 4px; font-weight: bold; font-size: 14px; }
    .btn-rescind { background-color: #cc3300; }
    .btn-review { background-color: #0066cc; }
    .footer { margin-top: 30px; font-size: 12px; color: #666; border-top: 1px solid #ddd; padding-top: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <p>Hi ${firstName},</p>
      <p>Your bid for <strong>${jobNumber}</strong> has been successfully submitted.</p>
    </div>

    <div class="section">
      <div class="section-title">--- BID SUMMARY ---</div>
      <div class="summary-row">
        <span class="label">Trade:</span>
        <span class="value">${trade}</span>
      </div>
      <div class="summary-row">
        <span class="label">Bid Amount:</span>
        <span class="value">${bidAmountFormatted}</span>
      </div>
      <div class="summary-row">
        <span class="label">Platform Fee (${feePct}%):</span>
        <span class="value">${feeAmountFormatted}</span>
      </div>
    </div>

    <div class="section">
      <div class="section-title">--- PLATFORM FEE AGREEMENT ---</div>
      <p>By submitting this bid, you agreed to pay Otter Quotes a platform fee of ${feePct}% (${feeAmountFormatted}) upon contract execution. If the homeowner accepts your bid and executes the contract, this fee will be charged to your card on file. This email serves as confirmation of your fee agreement.</p>
      <p>Questions? Reply to this email or contact support@otterquote.com.</p>
      <p>— The Otter Quotes Team</p>
    </div>

    <div class="section" style="border-left-color: #cc3300; text-align: center;">
      <div class="section-title">--- YOUR BID IS LIVE ---</div>
      <p>Not comfortable with these terms? Rescind your bid now. Your offer is currently live and could be accepted by the homeowner at any time.</p>
      <a href="${bidFormUrl}" class="btn btn-rescind">Rescind My Bid</a>
      <a href="${bidFormUrl}" class="btn btn-review">Review My Bid</a>
    </div>

    <div class="footer">
      <p>This email confirms your bid submission and fee agreement. Keep this email for your records.</p>
    </div>
  </div>
</body>
</html>
  `.trim();
}

function buildEmailText(
  firstName: string,
  jobNumber: string,
  claimId: string,
  trade: string,
  bidAmount: number,
  feePct: number,
  feeAmount: number
): string {
  const bidAmountFormatted = formatCurrency(bidAmount);
  const feeAmountFormatted = formatCurrency(feeAmount);
  const bidFormUrl = `https://otterquote.com/contractor-bid-form.html?claim_id=${claimId}`;

  return `Hi ${firstName},

Your bid for ${jobNumber} has been successfully submitted.

--- BID SUMMARY ---
Trade: ${trade}
Bid Amount: ${bidAmountFormatted}
Platform Fee (${feePct}%): ${feeAmountFormatted}

--- PLATFORM FEE AGREEMENT ---
By submitting this bid, you agreed to pay Otter Quotes a platform fee of ${feePct}% (${feeAmountFormatted}) upon contract execution. If the homeowner accepts your bid and executes the contract, this fee will be charged to your card on file. This email serves as confirmation of your fee agreement.

Questions? Reply to this email or contact support@otterquote.com.

— The Otter Quotes Team

--- YOUR BID IS LIVE ---
Not comfortable with these terms? Rescind your bid now. Your offer is currently live and could be accepted by the homeowner at any time.

Rescind My Bid: ${bidFormUrl}
Review My Bid: ${bidFormUrl}`;
}

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // ── D-225 Phase 2C C3: JWT verification (pattern: rescind-bid lines 31-58) ──
  // Accept either a service-role bearer (for server-to-server calls) or a valid
  // end-user JWT (for browser-fired calls). End-user calls also verify ownership.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(
      JSON.stringify({ error: "Missing Authorization header" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const isServiceRole = serviceRoleKey && token === serviceRoleKey;

  let authedUserId: string | null = null;
  if (!isServiceRole) {
    const supabaseUrlForAuth = Deno.env.get("SUPABASE_URL") || "";
    const supabaseAuth = createClient(supabaseUrlForAuth, serviceRoleKey);
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    authedUserId = user.id;
  }

  try {
    const body = (await req.json()) as SendBidConfirmationRequest;

    // Validate required fields
    const requiredFields = [
      "quote_id",
      "contractor_id",
      "bid_amount",
      "platform_fee_pct",
      "platform_fee_amount",
      "trade",
    ];

    for (const field of requiredFields) {
      if (!(field in body)) {
        return new Response(
          JSON.stringify({
            error: `Missing required field: ${field}`,
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    const {
      quote_id,
      contractor_id,
      bid_amount,
      platform_fee_pct,
      platform_fee_amount,
      trade,
    } = body;

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({
          error: "Missing Supabase configuration",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify quote exists, belongs to contractor, and fetch claim_id for Job # (D-216)
    const { data: quoteData, error: quoteError } = await supabase
      .from("quotes")
      .select("id, contractor_id, claim_id")
      .eq("id", quote_id)
      .single();

    if (quoteError || !quoteData) {
      return new Response(
        JSON.stringify({
          error: "Quote not found",
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Verify ownership: quote → contractor
    if (quoteData.contractor_id !== contractor_id) {
      return new Response(
        JSON.stringify({
          error: "Quote does not belong to this contractor",
        }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // [D-225 Phase 2C C3] Verify ownership: authed user → contractor (end-user calls only).
    if (authedUserId) {
      const { data: contractorOwner } = await supabase
        .from("contractors")
        .select("user_id")
        .eq("id", contractor_id)
        .maybeSingle();
      if (!contractorOwner || contractorOwner.user_id !== authedUserId) {
        return new Response(
          JSON.stringify({ error: "Authed user does not own this contractor record" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // D-216: derive job number from claim_id (last 8 chars, uppercase)
    const claimId: string = quoteData.claim_id || "";
    const jobNumber = claimId
      ? `Job #${claimId.slice(-8).toUpperCase()}`
      : "Job #UNKNOWN";

    // Look up contractor email and name
    const { data: contractorData, error: contractorError } = await supabase
      .from("contractors")
      .select("email, contact_name")
      .eq("id", contractor_id)
      .single();

    if (contractorError || !contractorData) {
      return new Response(
        JSON.stringify({
          error: "Contractor not found",
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const contractorEmail = contractorData.email;
    const firstName =
      contractorData.contact_name?.split(" ")[0] || "Contractor";

    // Get Mailgun API key
    const mailgunApiKey = Deno.env.get("MAILGUN_API_KEY");
    if (!mailgunApiKey) {
      return new Response(
        JSON.stringify({
          error: "Missing Mailgun API key",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Build email content — D-215: fee confirmation; D-216: Job # identifier; D-175: "Otter Quotes" brand name
    const subject = `Your Otter Quotes bid has been submitted — Fee Confirmation`;
    const htmlBody = buildEmailHtml(
      firstName,
      jobNumber,
      claimId,
      trade,
      bid_amount,
      platform_fee_pct,
      platform_fee_amount
    );
    const textBody = buildEmailText(
      firstName,
      jobNumber,
      claimId,
      trade,
      bid_amount,
      platform_fee_pct,
      platform_fee_amount
    );

    // Send via Mailgun
    const mailgunFormData = new FormData();
    mailgunFormData.append("from", "Otter Quotes <noreply@mail.otterquote.com>");
    mailgunFormData.append("to", contractorEmail);
    mailgunFormData.append("subject", subject);
    mailgunFormData.append("text", textBody);
    mailgunFormData.append("html", htmlBody);

    const mailgunResponse = await fetch(
      "https://api.mailgun.net/v3/mail.otterquote.com/messages",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`api:${mailgunApiKey}`)}`,
        },
        body: mailgunFormData,
      }
    );

    if (!mailgunResponse.ok) {
      const mailgunError = await mailgunResponse.text();
      console.error("Mailgun error:", mailgunError);
      return new Response(
        JSON.stringify({
          error: "Failed to send email",
          details: mailgunError,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const mailgunData = await mailgunResponse.json();
    const messageId = mailgunData.id || mailgunData.message;

    // Log activity
    const { error: logError } = await supabase.from("activity_log").insert({
      user_id: contractor_id,
      event_type: "bid_confirmation_email_sent",
      title: `Bid confirmation email sent for quote ${quote_id}`,
      metadata: {
        quote_id,
        claim_id: claimId,
        job_number: jobNumber,
        fee_amount: platform_fee_amount,
        fee_percentage: platform_fee_pct,
        message_id: messageId,
      },
    });

    if (logError) {
      // 86e1tz17j: de-blind — report the failure (was silently swallowed), but
      // keep non-fatal: the email was already sent.
      await reportToSentry(logError, {
        fn: "send-bid-confirmation",
        op: "activity_log.insert",
        extra: { event_type: "bid_confirmation_email_sent", quote_id, contractor_id },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        message_id: messageId,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
