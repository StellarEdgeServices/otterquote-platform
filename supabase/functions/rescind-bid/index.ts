import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const supabase = createClient(supabaseUrl, supabaseKey);

// CORS allow-list. A comma-joined Access-Control-Allow-Origin is invalid and is
// rejected by browsers, so a single origin must be chosen per request: echo the
// request Origin when it is allow-listed, otherwise fall back to the first.
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
];

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

// Statuses that permit rescission.
// 'active' is the live status a freshly-submitted bid lands in (quotes.bid_status
// schema default; the non-renewal submit path never overrides it). 'submitted' is
// produced by the D-150 renewal path. NOTE: the renew-expiry side
// (process-bid-expirations) is intentionally NOT touched here — separate Phase-18 item.
const RESCINDABLE_STATUSES = ["active", "submitted", "pending", "under_review"];

interface RescindBidRequest {
  quote_id: string;
  contractor_id: string;
  reason?: string;
}

Deno.serve(async (req: Request) => {
  // CORS handling
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: buildCorsHeaders(req) });
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
          ...buildCorsHeaders(req),
        },
      }
    );
  }

  // Verify JWT by extracting user from token
  // [D-225 Phase 2C C4] Case-insensitive Bearer prefix strip.
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        ...buildCorsHeaders(req),
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
          ...buildCorsHeaders(req),
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
          ...buildCorsHeaders(req),
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
          ...buildCorsHeaders(req),
        },
      }
    );
  }

  // Verify ownership: quote → contractor_id matches body
  if (quote.contractor_id !== body.contractor_id) {
    return new Response(
      JSON.stringify({ error: "You do not own this bid" }),
      {
        status: 403,
        headers: {
          "Content-Type": "application/json",
          ...buildCorsHeaders(req),
        },
      }
    );
  }

  // [D-225 Phase 2C C4] Verify ownership: authed user → contractor record.
  // Closes the vuln where contractor A could rescind contractor B's bid by passing B's id.
  const { data: contractorOwner } = await supabase
    .from("contractors")
    .select("user_id")
    .eq("id", body.contractor_id)
    .maybeSingle();
  if (!contractorOwner || contractorOwner.user_id !== user.id) {
    return new Response(
      JSON.stringify({ error: "Authed user does not own this contractor record" }),
      {
        status: 403,
        headers: {
          "Content-Type": "application/json",
          ...buildCorsHeaders(req),
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
          ...buildCorsHeaders(req),
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
          ...buildCorsHeaders(req),
        },
      }
    );
  }

  // Insert activity log entry
  const { error: logError } = await supabase.from("activity_log").insert({
    user_id: user.id,
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
        ...buildCorsHeaders(req),
      },
    }
  );
});
