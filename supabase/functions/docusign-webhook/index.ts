/**
 * OtterQuote Edge Function: docusign-webhook
 * Receives DocuSign Connect webhook notifications when envelope status changes.
 * Updates claims table on signing completion, decline, or void.
 *
 * Environment variables:
 *   DOCUSIGN_CONNECT_HMAC_KEY — shared secret for HMAC-SHA256 signature verification
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — auto-provided by Supabase
 *
 * DocuSign Connect sends JSON payloads to this endpoint. The webhook URL is:
 *   https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/docusign-webhook
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// CORS tightened (Session 254): origin-allowlisted instead of wildcard.
// Webhook traffic is server-to-server (no Origin header); browser probes
// fall back to the first allowed origin.
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
];

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-docusign-signature-1",
    "Vary": "Origin",
  };
}

// ========== HMAC VERIFICATION ==========
async function verifyHmacSignature(
  payload: string,
  signatureHeader: string | null,
  hmacKey: string
): Promise<boolean> {
  if (!signatureHeader || !hmacKey) {
    console.warn("Missing signature header or HMAC key — skipping verification");
    // In development/sandbox, allow unsigned requests
    // In production, return false to reject unsigned requests
    return !hmacKey; // Allow if no key configured, reject if key exists but no signature
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(hmacKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );

  const computedSignature = btoa(
    String.fromCharCode(...new Uint8Array(signatureBuffer))
  );

  return computedSignature === signatureHeader;
}

// ========== MAIN HANDLER ==========
serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Only accept POST
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // Read raw body for HMAC verification
    const rawBody = await req.text();

    // Verify HMAC signature if configured
    const hmacKey = Deno.env.get("DOCUSIGN_CONNECT_HMAC_KEY") || "";
    const signatureHeader = req.headers.get("x-docusign-signature-1");

    if (hmacKey) {
      const isValid = await verifyHmacSignature(rawBody, signatureHeader, hmacKey);
      if (!isValid) {
        console.error("HMAC signature verification failed");
        return new Response(
          JSON.stringify({ error: "Invalid signature" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      console.log("HMAC signature verified");
    }

    // Parse the payload
    const payload = JSON.parse(rawBody);

    // DocuSign Connect sends envelope status in different formats depending on config.
    // JSON format: { event, apiVersion, uri, retryCount, configurationId, generatedDateTime,
    //               data: { envelopeId, envelopeSummary: { status, emailSubject, ... } } }
    // or sometimes: { envelopeId, status, ... } directly

    let envelopeId: string | null = null;
    let status: string | null = null;
    let recipientEmail: string | null = null;
    let completedDateTime: string | null = null;
    let declinedDateTime: string | null = null;
    let voidedDateTime: string | null = null;
    let event: string | null = null;

    // Handle the Connect JSON payload format
    if (payload.data?.envelopeSummary) {
      const summary = payload.data.envelopeSummary;
      envelopeId = payload.data.envelopeId || summary.envelopeId;
      status = summary.status;
      completedDateTime = summary.completedDateTime;
      declinedDateTime = summary.declinedDateTime;
      voidedDateTime = summary.voidedDateTime;
      event = payload.event;

      // Try to get the first signer's email
      const signers = summary.recipients?.signers;
      if (signers && signers.length > 0) {
        recipientEmail = signers[0].email;
      }
    } else if (payload.envelopeId) {
      // Simpler format
      envelopeId = payload.envelopeId;
      status = payload.status;
      completedDateTime = payload.completedDateTime;
      declinedDateTime = payload.declinedDateTime;
      voidedDateTime = payload.voidedDateTime;
      event = payload.event;
    } else {
      console.warn("Unrecognized payload format:", JSON.stringify(payload).slice(0, 500));
      return new Response(
        JSON.stringify({ received: true, warning: "Unrecognized payload format" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!envelopeId) {
      console.warn("No envelopeId in payload");
      return new Response(
        JSON.stringify({ received: true, warning: "No envelopeId" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Webhook received: envelope=${envelopeId}, status=${status}, event=${event}`);

    // ========== FIND THE CLAIM ==========
    // Look up claim by docusign_envelope_id or color_confirmation_envelope_id
    const { data: claim, error: claimError } = await supabase
      .from("claims")
      .select("id, status, docusign_envelope_id, color_confirmation_envelope_id, contract_signed_at")
      .or(`docusign_envelope_id.eq.${envelopeId},color_confirmation_envelope_id.eq.${envelopeId}`)
      .limit(1)
      .single();

    if (claimError || !claim) {
      console.warn(`No claim found for envelope ${envelopeId}:`, claimError?.message);
      // Return 200 anyway — DocuSign will retry on non-2xx
      return new Response(
        JSON.stringify({ received: true, warning: "No matching claim found" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const isContract = claim.docusign_envelope_id === envelopeId;
    const isColorConfirmation = claim.color_confirmation_envelope_id === envelopeId;

    console.log(`Matched claim ${claim.id} (${isContract ? "contract" : "color_confirmation"})`);

    // ========== CONTRACTOR SIGNING TRACKING ==========
    // On every contract envelope event, scan the signers array. If the contractor
    // signer (clientUserId: "contractor_1") has completed, write contractor_signed_at
    // to the matching quote. Covers both intermediate events (contractor signed,
    // homeowner pending) and the final completed event (all signed — signedDateTime
    // is still present per signer in the payload). Idempotent via IS NULL guard.
    if (isContract) {
      const allSigners: any[] = (
        payload.data?.envelopeSummary?.recipients?.signers ||
        payload.recipients?.signers ||
        []
      );
      const contractorSigner = allSigners.find(
        (s: any) => s.clientUserId === "contractor_1" && s.status === "completed"
      );
      if (contractorSigner) {
        const { data: contractorQuote } = await supabase
          .from("quotes")
          .select("id, contractor_signed_at")
          .eq("docusign_envelope_id", envelopeId)
          .is("contractor_signed_at", null)
          .maybeSingle();
        if (contractorQuote) {
          const { error: csErr } = await supabase
            .from("quotes")
            .update({
              contractor_signed_at: contractorSigner.signedDateTime || new Date().toISOString(),
            })
            .eq("id", contractorQuote.id);
          if (csErr) {
            console.error(`Failed to write contractor_signed_at for quote ${contractorQuote.id}:`, csErr);
          } else {
            console.log(`contractor_signed_at written for quote ${contractorQuote.id} (claim ${claim.id})`);
          }
        }
      }
    }

    // ========== UPDATE CLAIM BASED ON STATUS ==========
    const updateData: Record<string, any> = {};
    let shouldNotifyContractor = false;

    if (status === "completed") {
      // Envelope fully signed by all parties
      if (isContract) {
        // ========== HANDLE PAYMENT CHARGING (D-127) ==========
        // Contract signed → charge contractor → release to contractor (if payment succeeds)
        // This is the critical D-127 flow: payment AFTER signing, not at selection

        if (!claim.contract_signed_at) {
          // Not yet marked signed — time to charge
          console.log(`Contract signed for claim ${claim.id}. Attempting payment charge...`);

          try {
            // Look up the winning quote to get contractor ID and amount
            const { data: quote, error: quoteErr } = await supabase
              .from("quotes")
              .select("id, contractor_id, total_price, payment_status")
              .eq("claim_id", claim.id)
              .eq("status", "awarded")
              .single();

            if (quoteErr || !quote) {
              throw new Error(
                `Could not find awarded quote for claim ${claim.id}: ${quoteErr?.message || "not found"}`
              );
            }

            // Get contractor's Stripe info
            const { data: contractor, error: contractorErr } = await supabase
              .from("contractors")
              .select(
                "id, stripe_customer_id, stripe_payment_method_id, company_name"
              )
              .eq("id", quote.contractor_id)
              .single();

            if (contractorErr || !contractor) {
              throw new Error(
                `Could not find contractor ${quote.contractor_id}: ${contractorErr?.message || "not found"}`
              );
            }

            if (
              !contractor.stripe_customer_id ||
              !contractor.stripe_payment_method_id
            ) {
              throw new Error(
                `Contractor ${contractor.id} does not have payment method on file`
              );
            }

            // Fetch platform fee percentage
            const { data: platformSettings, error: psErr } = await supabase
              .from("platform_settings")
              .select("platform_fee_percent")
              .single();

            if (psErr) {
              console.warn(
                "Could not fetch platform fee, using default 5%:",
                psErr
              );
            }
            const platformFeePercent =
              platformSettings?.platform_fee_percent || 5;
            const feeAmount = Math.round(
              quote.total_price * (platformFeePercent / 100) * 100
            );

            // Call create-payment-intent via internal function invocation
            console.log(
              `Charging contractor ${contractor.id} ${feeAmount} cents for platform fee...`
            );

            const paymentResponse = await fetch(
              `${supabaseUrl}/functions/v1/create-payment-intent`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${supabaseKey}`,
                },
                body: JSON.stringify({
                  amount: feeAmount,
                  currency: "usd",
                  description: `OtterQuote platform fee (${platformFeePercent}%) for claim ${claim.id}`,
                  metadata: {
                    claim_id: claim.id,
                    contractor_id: quote.contractor_id,
                    type: "platform_fee",
                  },
                  contractor_id: quote.contractor_id,
                  off_session: true,
                }),
              }
            );

            if (!paymentResponse.ok) {
              const paymentError = await paymentResponse.text();
              throw new Error(
                `Payment function returned ${paymentResponse.status}: ${paymentError}`
              );
            }

            const paymentResult = await paymentResponse.json();
            console.log(
              `Payment result: status=${paymentResult.status}, id=${paymentResult.payment_intent_id}`
            );

            // Check if payment succeeded
            const isPaymentSuccessful = paymentResult.succeeded === true;

            if (!isPaymentSuccessful) {
              // ── Payment FAILED — do NOT mark contract as signed, trigger dunning ──
              console.error(
                `Payment failed for quote ${quote.id}: ${paymentResult.status}`
              );

              // Store payment info and mark as dunning
              await supabase
                .from("quotes")
                .update({
                  payment_intent_id: paymentResult.payment_intent_id,
                  payment_status: "dunning",
                })
                .eq("id", quote.id);

              // Trigger dunning sequence
              try {
                const dunningResponse = await fetch(
                  `${supabaseUrl}/functions/v1/process-dunning`,
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${supabaseKey}`,
                    },
                    body: JSON.stringify({
                      quote_id: quote.id,
                      contractor_id: quote.contractor_id,
                      claim_id: claim.id,
                      amount_cents: feeAmount,
                      stripe_error:
                        paymentResult.error || "Payment failed after signing",
                    }),
                  }
                );
                console.log(`Dunning sequence triggered: ${dunningResponse.status}`);
              } catch (dunningErr) {
                console.error("Failed to trigger dunning:", dunningErr);
              }

              // Return early — do NOT update claim status or notify contractor
              return new Response(
                JSON.stringify({
                  received: true,
                  envelope_id: envelopeId,
                  status,
                  claim_id: claim.id,
                  payment_failed: true,
                  message: "Contract signed but payment failed. Dunning initiated.",
                }),
                {
                  status: 200,
                  headers: { ...corsHeaders, "Content-Type": "application/json" },
                }
              );
            }

            // ── Payment SUCCEEDED — mark contract as signed and notify contractor ──
            console.log(`Payment succeeded for quote ${quote.id}`);

            // Update quote with payment success
            await supabase
              .from("quotes")
              .update({
                payment_intent_id: paymentResult.payment_intent_id,
                payment_status: "paid",
              })
              .eq("id", quote.id);

            // Now update claim status
            updateData.contract_signed_at =
              completedDateTime || new Date().toISOString();
            updateData.contract_signed_by = recipientEmail || null;
            updateData.status = "contract_signed";

            // Flag for contractor notification (only after successful payment)
            shouldNotifyContractor = true;
          } catch (paymentErr) {
            console.error(
              "Error processing payment after contract signing:",
              paymentErr
            );
            // Don't mark as signed if something went wrong
            // Return early to prevent partial updates
            return new Response(
              JSON.stringify({
                received: true,
                envelope_id: envelopeId,
                status,
                claim_id: claim.id,
                error: paymentErr instanceof Error ? paymentErr.message : "Unknown payment error",
              }),
              {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              }
            );
          }
        }
      } else if (isColorConfirmation) {
        updateData.color_confirmed_at =
          completedDateTime || new Date().toISOString();
      }
    } else if (status === "declined") {
      // A signer declined
      if (isContract) {
        updateData.contract_declined_at =
          declinedDateTime || new Date().toISOString();
        // Don't change claim status — homeowner may re-sign or choose another contractor
      }
    } else if (status === "voided") {
      // Envelope was voided (cancelled)
      if (isContract) {
        updateData.contract_voided_at =
          voidedDateTime || new Date().toISOString();
      }
    } else if (status === "sent" || status === "delivered") {
      // Informational — envelope was sent or viewed. No claim update needed.
      console.log(`Informational status: ${status} for envelope ${envelopeId}`);
    }

    // Apply updates if any
    if (Object.keys(updateData).length > 0) {
      const { error: updateError } = await supabase
        .from("claims")
        .update(updateData)
        .eq("id", claim.id);

      if (updateError) {
        console.error(`Failed to update claim ${claim.id}:`, updateError);
        // Still return 200 to avoid DocuSign retries
      } else {
        console.log(`Updated claim ${claim.id}:`, JSON.stringify(updateData));
      }

      // ── Notify contractor ONLY after payment succeeds ──
      if (shouldNotifyContractor) {
        try {
          // Fire-and-forget notification to contractor
          const notifyResponse = await fetch(
            `${supabaseUrl}/functions/v1/notify-contractors`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${supabaseKey}`,
              },
              body: JSON.stringify({
                claim_id: claim.id,
                event_type: "contract_signed",
                message:
                  "A homeowner has signed your contract! Contact them within 48 hours.",
              }),
            }
          );
          console.log(`Contractor notification sent: ${notifyResponse.status}`);
        } catch (notifyErr) {
          // Non-critical — don't fail the webhook
          console.error("Failed to notify contractor:", notifyErr);
        }
      }
    }

    // ========== LOG THE EVENT ==========
    try {
      await supabase.from("notifications").insert({
        claim_id: claim.id,
        channel: "webhook",
        notification_type: `docusign_${status}`,
        recipient: recipientEmail || "unknown",
        message_preview: `Envelope ${envelopeId} status: ${status}`,
      });
    } catch (logErr) {
      // Non-critical
      console.error("Failed to log webhook event:", logErr);
    }

    // ========== SUCCESS ==========
    return new Response(
      JSON.stringify({
        received: true,
        envelope_id: envelopeId,
        status,
        claim_id: claim.id,
        updated: Object.keys(updateData).length > 0,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("docusign-webhook error:", error);

    // Always return 200 to prevent DocuSign from retrying on parse errors
    return new Response(
      JSON.stringify({
        received: true,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
