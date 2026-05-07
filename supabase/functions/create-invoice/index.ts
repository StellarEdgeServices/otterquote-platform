import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.104.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const mailgunDomain = "mail.otterquote.com";
const mailgunApiKey = Deno.env.get("MAILGUN_API_KEY") || "";

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
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } }
    );
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

    // Calculate amounts
    const bidAmount = Math.round(parseFloat(quote.total_price) * 100);
    const feePct = quote.platform_fee_pct || quote.fee_percentage;
    const platformFeeAmount = Math.round((bidAmount * feePct) / 100);
    const contractorNet = bidAmount - platformFeeAmount;

    // Fetch contractor email
    const { data: contractor, error: contractorError } = await sb
      .from("contractors")
      .select("contact_name, email")
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
      contractor_id,
      event_type: "invoice_created",
      metadata: {
        quote_id,
        invoice_amount: platformFeeAmount,
        net_amount: contractorNet,
        property_address,
        homeowner_name,
      },
    });

    if (logError) {
      console.error("Activity log error:", logError);
      // Don't fail the function — email was sent, log is secondary
    }

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
