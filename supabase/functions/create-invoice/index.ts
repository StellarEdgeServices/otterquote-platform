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

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

/**
 * HTML counterpart of the invoice email (gh-1013). Wraps the SAME
 * GC-approved emailBody string used for the text part — escaped and
 * rendered in a monospace <pre> block so every dollar figure, invoice
 * field, and disclosure sentence stays byte-identical to the text/plain
 * part. Do not re-derive the copy here; always pass the computed emailBody.
 */
function invoiceEmailHtml(emailBody: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr>
          <td style="padding:32px;">
            <pre style="margin:0;white-space:pre-wrap;word-wrap:break-word;font-family:'Courier New',Courier,monospace;font-size:13px;line-height:1.6;color:#0F172A;">${escapeHtml(emailBody)}</pre>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();
}

async function sendInvoiceEmail(
  contractorEmail: string,
  contractorName: string,
  contractorAddress: string, // D-237: mailing address line (v14 columns)
  propertyAddress: string,
  homeownerName: string,
  bidAmount: number,
  platformFeeAmount: number,
  feePct: number,
  feeAcceptedAt: string,
  contractSignedAt: string,
  jobNumber: string, // D-216: "Job #XXXXXXXX" formatted identifier
  invoiceNumber: string, // INV-[YYYYMMDD]-[last 8 of bid ID, uppercase]
  bidId: string // full bid/quote ID — audit tie to fee_acceptances.bid_id
): Promise<void> {
  // GC-approved fixed-field template (#547 item 2, D-215-conformant).
  // Direct-charge model (D-226): no "Net Payment" line, no collect-and-disburse
  // framing. Deviations from this wording require new GC sign-off.
  const dateIssued = formatDate(contractSignedAt);
  const feeAcceptedDate = formatDate(feeAcceptedAt);

  const emailBody = `
INVOICE

Invoice #:   ${invoiceNumber}
Date Issued: ${dateIssued}
Due:         Upon contract execution (Net 0)
Job:         ${jobNumber}
Bid ID:      ${bidId}

FROM:  Stellar Edge Services, LLC d/b/a Otter Quotes
       3410 N High School Rd, Ste G #102, Indianapolis, IN 46224

TO:    ${contractorName}
       ${contractorAddress}

PROPERTY:  ${propertyAddress}
HOMEOWNER: ${homeownerName}

--- CHARGES ---
Otter Quotes Platform Fee — ${propertyAddress} — ${jobNumber}   $${formatCurrency(platformFeeAmount)}
Fee rate: ${feePct}% of contract value ($${formatCurrency(bidAmount)}) — agreed to at
bid submission on ${feeAcceptedDate}

AMOUNT DUE: $${formatCurrency(platformFeeAmount)}

--- PLATFORM FEE DISCLOSURE ---
This invoice confirms the platform fee of $${formatCurrency(platformFeeAmount)} (${feePct}%) you agreed
to pay Otter Quotes at bid submission on ${feeAcceptedDate}.
The fee is due upon contract execution and will be charged to your
card on file.

Questions? Contact support@otterquote.com.

Stellar Edge Services, LLC d/b/a Otter Quotes
`;

  const formData = new FormData();
  formData.append(
    "from",
    "Otter Quotes <noreply@mail.otterquote.com>"
  );
  formData.append("to", contractorEmail);
  formData.append(
    "subject",
    `Otter Quotes Invoice ${invoiceNumber} — ${propertyAddress}`
  );
  formData.append("text", emailBody);
  formData.append("html", invoiceEmailHtml(emailBody));

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
  //
  // [D-274 / #631] Operator-token gate added for the boldsign-webhook ->
  // create-invoice server-to-server call. The JWT-key migration workstream is
  // moving every Edge Function off SUPABASE_SERVICE_ROLE_KEY, and the old
  // `token === serviceRoleKey` check below is exactly the "credential
  // happens to be a valid JWT" pattern that migration is retiring — a plain
  // service-role bearer is indistinguishable from a leaked one. This adds a
  // DEDICATED shared secret (EF_OPERATOR_TOKEN), sent as its own header
  // (never in Authorization, so it can never be confused with a JWT) and
  // compared timing-safely (constantTimeEqual, same primitive as
  // hover-webhook's query-token check). boldsign-webhook is the first,
  // and so far only, caller using this path — see boldsign-webhook/index.ts
  // for the sending side. The legacy isServiceRole path below is left in
  // place for other callers until they are migrated individually; it is
  // NOT removed by this change. DO NOT revert this block when migrating
  // create-invoice off SUPABASE_SERVICE_ROLE_KEY — EF_OPERATOR_TOKEN is a
  // separate secret from SUPABASE_SECRET_KEYS and must survive that migration.
  const EF_OPERATOR_TOKEN = Deno.env.get("EF_OPERATOR_TOKEN") || "";
  function constantTimeEqual(a: string, b: string): boolean {
    const enc = new TextEncoder();
    const ab = enc.encode(a);
    const bb = enc.encode(b);
    if (ab.length !== bb.length) return false;
    let diff = 0;
    for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
    return diff === 0;
  }
  const incomingOperatorToken = req.headers.get("X-Operator-Token") || "";
  const isOperator = !!EF_OPERATOR_TOKEN && constantTimeEqual(incomingOperatorToken, EF_OPERATOR_TOKEN);

  const authHeader = req.headers.get("Authorization");
  if (!isOperator && !authHeader) {
    return new Response(
      JSON.stringify({ error: "Missing Authorization header" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }
  const token = authHeader ? authHeader.replace(/^Bearer\s+/i, "") : "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const isServiceRole = !isOperator && !!serviceRoleKey && token === serviceRoleKey;
  let authedUserId: string | null = null;
  if (!isOperator && !isServiceRole) {
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
        "id, contractor_id, claim_id, total_price, fee_percentage, platform_fee_pct, platform_fee_basis, fee_accepted_at, is_test"
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

    // Fetch contractor email + mailing address (D-237; v14 address columns)
    const { data: contractor, error: contractorError } = await sb
      .from("contractors")
      .select("contact_name, email, user_id, address_line1, address_city, address_state, address_zip")
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

    // Invoice #: INV-[YYYYMMDD from contract-signed date]-[last 8 of bid ID, uppercase]
    const signedDate = new Date(contract_signed_at);
    const yyyymmdd = (isNaN(signedDate.getTime()) ? new Date() : signedDate)
      .toISOString().slice(0, 10).replace(/-/g, "");
    const invoiceNumber = `INV-${yyyymmdd}-${quote_id.slice(-8).toUpperCase()}`;

    // D-237: single-line mailing address from whatever v14 columns are on file.
    const addressParts = [
      contractor.address_line1,
      [contractor.address_city, contractor.address_state].filter(Boolean).join(", "),
      contractor.address_zip,
    ].filter((p) => p && String(p).trim().length > 0);
    const contractorAddress = addressParts.length > 0
      ? addressParts.join(", ")
      : "Address not on file";

    // Send invoice email
    await sendInvoiceEmail(
      contractor.email,
      contractor.contact_name,
      contractorAddress,
      property_address,
      homeowner_name,
      bidAmount,
      platformFeeAmount,
      feePct,
      quote.fee_accepted_at,
      contract_signed_at,
      jobNumber,
      invoiceNumber,
      quote_id
    );

    // Insert activity log entry
    const { error: logError } = await sb.from("activity_log").insert({
      event_type: "invoice_created",
      title: "invoice_created",
      user_id: contractor.user_id,
      is_test: quote.is_test ?? false,
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
