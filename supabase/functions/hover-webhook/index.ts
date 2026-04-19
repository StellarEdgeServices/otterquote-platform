/**
 * OtterQuote Edge Function: hover-webhook
 * Receives webhook events from Hover when job states change.
 * Primary use: detect when a measurement job completes, then
 * fetch the measurements and attach them to the claim.
 *
 * Webhook event: job-state-changed
 * When state becomes "complete", we fetch the measurement data
 * and store it in Supabase for the associated claim.
 *
 * No rate limiting needed — Hover calls us, not the other way around.
 *
 * Environment variables:
 *   HOVER_CLIENT_ID
 *   HOVER_CLIENT_SECRET
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const HOVER_API_BASE = "https://hover.to";

serve(async (req) => {
  // Hover webhooks are POST requests
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const payload = await req.json();

    console.log("Hover webhook received:", JSON.stringify(payload));

    // Hover webhook payload includes:
    // { event: "job-state-changed", job_id: 12345, state: "complete", ... }
    const { event, job_id, state } = payload;

    if (!event || !job_id) {
      console.warn("Invalid webhook payload — missing event or job_id");
      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log(`Hover webhook: event=${event}, job_id=${job_id}, state=${state}`);

    // Look up the hover order in our database
    const { data: orders, error: lookupError } = await supabase
      .from("hover_orders")
      .select("id, claim_id, status, hover_job_id")
      .eq("hover_job_id", job_id)
      .limit(1);

    if (lookupError || !orders || orders.length === 0) {
      // Also try pending_job_id match via capture_request
      console.warn(
        `No hover_order found for job_id ${job_id}. Trying alternative lookup...`
      );

      // Store the event anyway for debugging
      return new Response(
        JSON.stringify({
          received: true,
          matched: false,
          job_id,
          event,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const order = orders[0];

    // Update order status based on job state
    const statusMap: Record<string, string> = {
      processing: "processing",
      complete: "complete",
      failed: "failed",
      cancelled: "cancelled",
    };

    const newStatus = statusMap[state] || order.status;

    await supabase
      .from("hover_orders")
      .update({ status: newStatus })
      .eq("id", order.id);

    console.log(
      `Updated hover_order ${order.id} status: ${order.status} → ${newStatus}`
    );

    // If the job is complete, fetch measurements
    if (state === "complete" && order.claim_id) {
      console.log(
        `Job ${job_id} complete! Fetching measurements for claim ${order.claim_id}...`
      );

      try {
        // Get a valid access token
        const accessToken = await getValidAccessToken(supabase);

        if (accessToken) {
          // Fetch JSON measurements
          const measurementsResponse = await fetch(
            `${HOVER_API_BASE}/api/v1/jobs/${job_id}/measurements.json`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
            }
          );

          if (measurementsResponse.ok) {
            const measurements = await measurementsResponse.json();

            // Store measurements as JSON in the hover_orders table
            await supabase
              .from("hover_orders")
              .update({
                status: "complete",
                measurements_json: measurements,
              })
              .eq("id", order.id);

            // Also update the claim's measurements_filename to indicate Hover data is available
            await supabase
              .from("claims")
              .update({
                measurements_filename: `hover_${job_id}_measurements.json`,
              })
              .eq("id", order.claim_id);

            console.log(
              `Measurements stored for hover_order ${order.id}, claim ${order.claim_id}`
            );

            // Create a notification for the homeowner
            const { data: claim } = await supabase
              .from("claims")
              .select("user_id, funding_type, trades, siding_bid_released_at")
              .eq("id", order.claim_id)
              .single();

            if (claim?.user_id) {
              await supabase.from("notifications").insert({
                user_id: claim.user_id,
                type: "hover_complete",
                title: "Measurements Ready",
                message:
                  "Your property measurements from Hover are now available. You can proceed with submitting for contractor bids.",
                claim_id: order.claim_id,
              });
            }

            // ── D-164: Check siding design gate immediately on measurement completion ──
            // The homeowner typically hasn't designed in Hover yet at this point, but
            // calling the check function is cheap and handles the edge case where the
            // design was done before measurements (or on another account).
            // The primary release mechanism is the 30-min polling cron job.
            const isRetailSiding =
              claim?.funding_type === "cash" &&
              Array.isArray(claim?.trades) &&
              claim.trades.some((t: string) => t.toLowerCase().includes("siding")) &&
              !claim?.siding_bid_released_at;

            if (isRetailSiding) {
              console.log(
                `D-164: Retail siding claim ${order.claim_id} — checking design gate immediately...`
              );
              try {
                const checkUrl =
                  Deno.env.get("SUPABASE_URL")!.replace(
                    ".supabase.co",
                    ".functions.supabase.co"
                  ) + "/functions/v1/check-siding-design-completion";

                const checkRes = await fetch(checkUrl, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`,
                  },
                  body: JSON.stringify({ claim_id: order.claim_id }),
                });
                const checkData = await checkRes.json();
                console.log(`D-164: gate check result for claim ${order.claim_id}:`, JSON.stringify(checkData));
              } catch (gateErr) {
                // Non-fatal — the 30-min cron will catch it
                console.warn("D-164: Immediate gate check failed (non-fatal):", gateErr);
              }
            }
          } else {
            console.error(
              "Failed to fetch measurements:",
              measurementsResponse.status,
              await measurementsResponse.text()
            );
          }

          // PDFs are served on-demand from Hover API — not stored in Supabase Storage (Session 57 decision).
          // Hover PDFs are 5–20MB each; Supabase Pro plan includes only 8GB storage.
          // To retrieve a PDF: GET ${HOVER_API_BASE}/api/v1/jobs/{job_id}/measurements.pdf
          // with a valid Bearer token from hover_tokens. Build a dedicated on-demand fetch endpoint.
        }
      } catch (measurementError) {
        console.error("Error fetching measurements:", measurementError);
        // Non-fatal — the order is still marked complete
      }
    }

    return new Response(
      JSON.stringify({
        received: true,
        matched: true,
        order_id: order.id,
        new_status: newStatus,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("hover-webhook error:", error);
    // Always return 200 to Hover so they don't retry endlessly
    return new Response(
      JSON.stringify({ received: true, error: error.message }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
});

/**
 * Get a valid access token from the hover_tokens table.
 * Refreshes if expired.
 */
async function getValidAccessToken(supabase: any): Promise<string | null> {
  const { data: tokens, error } = await supabase
    .from("hover_tokens")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error || !tokens || tokens.length === 0) {
    console.error("No Hover tokens found for measurement fetch");
    return null;
  }

  const token = tokens[0];
  const expiresAt = new Date(token.expires_at);
  const now = new Date();

  // If token is still valid
  if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) {
    return token.access_token;
  }

  // Refresh the token
  const clientId = Deno.env.get("HOVER_CLIENT_ID")!;
  const clientSecret = Deno.env.get("HOVER_CLIENT_SECRET")!;

  const refreshResponse = await fetch(`${HOVER_API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: token.refresh_token,
    }),
  });

  if (!refreshResponse.ok) {
    console.error(
      "Token refresh failed in webhook handler:",
      refreshResponse.status
    );
    return null;
  }

  const newTokenData = await refreshResponse.json();

  const newExpiresAt = new Date(
    Date.now() + (newTokenData.expires_in || 7200) * 1000
  ).toISOString();

  await supabase
    .from("hover_tokens")
    .update({
      access_token: newTokenData.access_token,
      refresh_token: newTokenData.refresh_token || token.refresh_token,
      expires_at: newExpiresAt,
    })
    .eq("id", token.id);

  return newTokenData.access_token;
}
