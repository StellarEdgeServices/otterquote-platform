import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.104.0";

const corsHeaders = {
  "Access-Control-Allow-Origin":
    "https://otterquote.com, https://app.otterquote.com, http://localhost:*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

interface SendBidConfirmationRequest {
  quote_id: string;
  contractor_id: string;
  bid_amount: number;
  platform_fee_pct: number;
  platform_fee_amount: number;
  net_amount: number;
  property_address: string;
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
  propertyAddress: string,
  trade: string,
  bidAmount: number,
  feePct: number,
  feeAmount: number,
  netAmount: number
): string {
  const bidAmountFormatted = formatCurrency(bidAmount);
  const feeAmountFormatted = formatCurrency(feeAmount);
  const netAmountFormatted = formatCurrency(netAmount);

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
    .footer { margin-top: 30px; font-size: 12px; color: #666; border-top: 1px solid #ddd; padding-top: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <p>Hi ${firstName},</p>
      <p>Your bid for <strong>${propertyAddress}</strong> has been successfully submitted.</p>
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
      <div class="summary-row">
        <span class="label"><strong>You Receive:</strong></span>
        <span class="value"><strong>${netAmountFormatted}</strong></span>
      </div>
    </div>

    <div class="section">
      <div class="section-title">--- PLATFORM FEE AGREEMENT ---</div>
      <p>By submitting this bid, you agreed to pay OtterQuote a platform fee of ${feePct}% (${feeAmountFormatted}) upon contract execution. This fee will be deducted from your bid amount before disbursement. This email serves as confirmation of your fee agreement.</p>
      <p>If a homeowner accepts your bid and the contract is executed, you will receive ${netAmountFormatted} upon project completion.</p>
      <p>Questions? Reply to this email or contact support@otterquote.com.</p>
      <p>— The OtterQuote Team</p>
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
  propertyAddress: string,
  trade: string,
  bidAmount: number,
  feePct: number,
  feeAmount: number,
  netAmount: number
): string {
  const bidAmountFormatted = formatCurrency(bidAmount);
  const feeAmountFormatted = formatCurrency(feeAmount);
  const netAmountFormatted = formatCurrency(netAmount);

  return `Hi ${firstName},

Your bid for ${propertyAddress} has been successfully submitted.

--- BID SUMMARY ---
Trade: ${trade}
Bid Amount: ${bidAmountFormatted}
Platform Fee (${feePct}%): ${feeAmountFormatted}
You Receive: ${netAmountFormatted}

--- PLATFORM FEE AGREEMENT ---
By submitting this bid, you agreed to pay OtterQuote a platform fee of ${feePct}% (${feeAmountFormatted}) upon contract execution. This fee will be deducted from your bid amount before disbursement. This email serves as confirmation of your fee agreement.

If a homeowner accepts your bid and the contract is executed, you will receive ${netAmountFormatted} upon project completion.

Questions? Reply to this email or contact support@otterquote.com.

— The OtterQuote Team`;
}

serve(async (req: Request) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
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
      "net_amount",
      "property_address",
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
      net_amount,
      property_address,
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

    // Verify quote exists and belongs to contractor
    const { data: quoteData, error: quoteError } = await supabase
      .from("quotes")
      .select("id, contractor_id")
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

    // Verify ownership
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

    // Build email content
    const subject = "Your OtterQuote bid has been submitted — Fee Confirmation";
    const htmlBody = buildEmailHtml(
      firstName,
      property_address,
      trade,
      bid_amount,
      platform_fee_pct,
      platform_fee_amount,
      net_amount
    );
    const textBody = buildEmailText(
      firstName,
      property_address,
      trade,
      bid_amount,
      platform_fee_pct,
      platform_fee_amount,
      net_amount
    );

    // Send via Mailgun
    const mailgunFormData = new FormData();
    mailgunFormData.append("from", "OtterQuote <noreply@mail.otterquote.com>");
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
        fee_amount: platform_fee_amount,
        fee_percentage: platform_fee_pct,
        message_id: messageId,
      },
    });

    if (logError) {
      console.error("Activity log error:", logError);
      // Don't fail the response if activity_log write fails; email was sent
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
