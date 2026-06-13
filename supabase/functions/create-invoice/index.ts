import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.104.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const mailgunDomain = "mail.otterquote.com";
const mailgunApiKey = Deno.env.get("MAILGUN_API_KEY") || "";

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

interface CreateInvoiceRequest {
  quote_id: string;
  contractor_id: string;
  homeowner_name: string;
  property_address: string;
  contract_signed_at: string;
}

function formatCurrency(cents: number): string {
  return (cents / 100).toFixed(2);
}

function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return isoString;
  }
}

async function sendGA4Event(eventName: string, params: Record<string, unknown> = {}): Promise<void> {
  const measurementId = Deno.env.get("GA4_MEASUREMENT_ID");
  const apiSecret = Deno.env.get("GA4_API_SECRET");
  if (!measurementId || !apiSecret) return;
  try {
    await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: "server",
          events: [{ name: eventName, params }],
        }),
      }
    );
  } catch (_) { /* non-fatal */ }
}

async function sendInvoiceEmail(
  contractorEmail: string,
  contractorName: string,
  propertyAddress: string,
  homeownerName: string,
  bidAmount: number,
  platformFeeAmount: number,
  feePct: number,
  contractorNet: number,
  feeAcceptedAt: string,
  jobNumber: string // D-216: "Job #XXXXXXXX" formatted identifier
): Promise<void> {
  const contractSignedDate = formatDate(new Date().toISOString());
  const feeAcceptedDate = formatDate(feeAcceptedAt);

  const emailBody = `
INVOICE

Date: ${contractSignedDate}
Job: ${jobNumber}

TO: ${contractorName}
FROM: OtterQuote (Stellar Edge Services, LLC)

PROPERTY: ${propertyAddress}
HOMEOWNER: ${homeownerName}

--- FEE SUMMARY ---
Contract Value (Bid Amount): $${formatCurrency(bidAmount)}
Platform Fee (${feePct}%):   $${formatCurrency(platformFeeAmount)}
Net Payment to Contractor:   $${formatCurrency(contractorNet)}

--- PLATFORM FEE DISCLOSURE ---
This invoice confirms the platform fee of ${feePct}% ($${formatCurrency(platformFeeAmount)}) 
you agreed to pay OtterQuote upon contract execution. This fee was disclosed 
and accepted on ${feeAcceptedDate}. Per your agreement, you will 
receive $${formatCurrency(contractorNet)} upon project completion.

Questions? Contact support@otterquote.com.

Stellar Edge Services, LLC | OtterQuote
`;

  const formData = new FormData();
  formData.append(
    "from",
    "OtterQuote <noreply@mail.otterquote.com>"
  );
  formData.append("to", contractorEmail);
  formData.append(
    "subject",
    `OtterQuote Invoice — ${propertyAddress}`
  );
  formData.append("text", emailBody);

  const auth = "Basic " + btoa(`api:${mailgunApiKey}`);
  const response = await fetch(
    `https://api.mailgun.net/v3/${mailgunDomain}/messages`,
    {
      method: "POST",
      headers: {
        "Authorization": auth,
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Mailgun error: ${response.status} ${error}`);
  }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "https://otterquote.com, https://app.otterquote.com",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── D-225 Phase 2C C3: JWT verification ──
  // Accepts service-role bearer (typical: docusign-webhook server-to-server)
  // or a valid end-user JWT (defense-in-depth if invoked from a client).
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(
      JSON.stringify({ error: "Missing Authorization header" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const isServiceRole = serviceRoleKey && token === serviceRoleKey;
  let authedUserId: string | null = null;
  if (!isServiceRole) {
    const supabaseAuth = createClient(supabaseUrl, serviceRoleKey);
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    authedUserId = user.id;
  }

  try {
    const payload = (await req.json()) as CreateInvoiceRequest;

    const { quote_id, contractor_id, homeowner_name, property_address, contract_signed_at } = payload;

    if (
      !quote_id ||
      !contractor_id ||
      !homeowner_name ||
      !property_address ||
      !contract_signed_at
    ) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const sb = createClient(supabaseUrl, supabaseKey);

    // Fetch quote and verify ownership
    const { data: quote, error: quoteError } = await sb
      .from("quotes")
      .select(
        "id, contractor_id, claim_id, total_price, fee_percentage, platform_fee_pct, platform_fee_basis, fee_accepted_at"
      )
      .eq("id", quote_id)
      .single();

    if (quoteError || !quote) {
      return new Response(
        JSON.stringify({ error: "Quote not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    if (quote.contractor_id !== contractor_id) {
      return new Response(
        JSON.stringify({ error: "Ownership mismatch" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // [D-225 Phase 2C C3] End-user calls: verify authed user owns the contractor record.
    if (authedUserId) {
      const { data: contractorOwner } = await sb
        .from("contractors")
        .select("user_id")
        .eq("id", contractor_id)
        .maybeSingle();
      if (!contractorOwner || contractorOwner.user_id !== authedUserId) {
        return new Response(
          JSON.stringify({ error: "Authed user does not own this contractor record" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Calculate amounts
    const bidAmount = Math.round(parseFloat(quote.total_price) * 100);
    const feePct = quote.platform_fee_pct || quote.fee_percentage;
    const platformFeeAmount = Math.round((bidAmount * feePct) / 100);
    const contractorNet = bidAmount - platformFeeAmount;

    // Fetch contractor email
    const { data: contractor, error: contractorError } = await sb
      .from("contractors")
      .select("contact_name, email, user_id")
      .eq("id", contractor_id)
      .single();

    if (contractorError || !contractor) {
      return new Response(
        JSON.stringify({ error: "Contractor not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // D-216: derive Job # from claim_id (last 8 chars, uppercase)
    const claimId: string = quote.claim_id || "";
    const jobNumber = claimId
      ? `Job #${claimId.slice(-8).toUpperCase()}`
      : "Job #UNKNOWN";

    // Send invoice email
    await sendInvoiceEmail(
      contractor.email,
      contractor.contact_name,
      property_address,
      homeowner_name,
      bidAmount,
      platformFeeAmount,
      feePct,
      contractorNet,
      quote.fee_accepted_at,
      jobNumber
    );

    // Insert activity log entry
    const { error: logError } = await sb.from("activity_log").insert({
      event_type: "invoice_created",
      title: "invoice_created",
      user_id: contractor.user_id,
      metadata: {
        contractor_id,
        quote_id,
        invoice_amount: platformFeeAmount,
        net_amount: contractorNet,
        property_address,
        homeowner_name,
      },
    });

    if (logError) {
      // 86e1tz17j: de-blind — report the failure (was silently swallowed), but
      // keep non-fatal: the email was already sent, log is secondary.
      await reportToSentry(logError, {
        fn: "create-invoice",
        op: "activity_log.insert",
        extra: { event_type: "invoice_created", quote_id, contractor_id },
      });
    }

    await sendGA4Event("payment_completed", {
      quote_id,
      contractor_id,
      platform_fee_amount: platformFeeAmount,
      bid_amount: bidAmount,
    });

    return new Response(
      JSON.stringify({
        success: true,
        invoice_id: quote_id,
        contractor_net: contractorNet,
        platform_fee_amount: platformFeeAmount,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
