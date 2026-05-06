import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const supabase = createClient(supabaseUrl, supabaseKey);

// Statuses that permit rescission
const RESCINDABLE_STATUSES = ["submitted", "pending", "under_review"];

interface RescindBidRequest {
  quote_id: string;
  contractor_id: string;
  reason?: string;
}

Deno.serve(async (req: Request) => {
  // CORS handling
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin":
          "https://otterquote.com, https://app.otterquote.com, http://localhost:*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  // Get Authorization header for JWT verification
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(
      JSON.stringify({ error: "Missing Authorization header" }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "https://otterquote.com",
        },
      }
    );
  }

  // Verify JWT by extracting user from token
  const token = authHeader.replace("Bearer ", "");
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "https://otterquote.com",
      },
    });
  }

  // Parse request body
  let body: RescindBidRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON in request body" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "https://otterquote.com",
        },
      }
    );
  }

  // Validate required fields
  if (!body.quote_id || !body.contractor_id) {
    return new Response(
      JSON.stringify({
        error: "Missing required fields: quote_id, contractor_id",
      }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "https://otterquote.com",
        },
      }
    );
  }

  // Fetch the quote
  const { data: quote, error: fetchError } = await supabase
    .from("quotes")
    .select("id, bid_status, contractor_id, created_at")
    .eq("id", body.quote_id)
    .single();

  if (fetchError || !quote) {
    return new Response(
      JSON.stringify({ error: "Quote not found or access denied" }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "https://otterquote.com",
        },
      }
    );
  }

  // Verify ownership
  if (quote.contractor_id !== body.contractor_id) {
    return new Response(
      JSON.stringify({ error: "You do not own this bid" }),
      {
        status: 403,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "https://otterquote.com",
        },
      }
    );
  }

  // Check if status allows rescission
  if (!RESCINDABLE_STATUSES.includes(quote.bid_status)) {
    return new Response(
      JSON.stringify({
        error: "Bid cannot be rescinded in current status",
        current_status: quote.bid_status,
        allowed_statuses: RESCINDABLE_STATUSES,
      }),
      {
        status: 409,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "https://otterquote.com",
        },
      }
    );
  }

  const previousStatus = quote.bid_status;
  const rescindedAt = new Date().toISOString();

  // Update the quote
  const { error: updateError } = await supabase
    .from("quotes")
    .update({
      bid_status: "rescinded",
      updated_at: rescindedAt,
    })
    .eq("id", body.quote_id);

  if (updateError) {
    return new Response(
      JSON.stringify({ error: "Failed to rescind bid", details: updateError }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "https://otterquote.com",
        },
      }
    );
  }

  // Insert activity log entry
  const { error: logError } = await supabase.from("activity_log").insert({
    user_id: body.contractor_id,
    event_type: "bid_rescinded",
    title: `Bid rescinded for quote ${body.quote_id}`,
    metadata: {
      quote_id: body.quote_id,
      previous_status: previousStatus,
      reason: body.reason || null,
      contractor_id: body.contractor_id,
    },
  });

  if (logError) {
    console.error("Failed to log rescission:", logError);
    // Don't fail the response; log insertion is non-critical
  }

  // Success response
  return new Response(
    JSON.stringify({
      success: true,
      quote_id: body.quote_id,
      rescinded_at: rescindedAt,
      previous_status: previousStatus,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "https://otterquote.com",
      },
    }
  );
});
