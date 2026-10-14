import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import {
  BID_SELECTED_ERROR,
  BID_SELECTED_MESSAGE,
  isBidSelectedOrAwarded,
  RESCINDABLE_STATUSES,
  RESCINDED_BID_STATUS,
  SELECTED_QUOTE_STATUS,
} from "./status.ts";
import { mailgunSender, notifyHomeownerOfWithdrawal } from "./notify.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const supabase = createClient(supabaseUrl, supabaseKey);

// CORS allow-list. A comma-joined Access-Control-Allow-Origin is invalid and is
// rejected by browsers, so a single origin must be chosen per request: echo the
// request Origin when it is allow-listed, otherwise fall back to the first.
// gh-1536: app-staging.otterquote.com removed — it is a Netlify DOMAIN ALIAS
// on the PRODUCTION app site, not a staging environment.
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
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

// Statuses that permit rescission, and the admitted bid_status a rescinded bid is written with, live in
// ./status.ts (gh-2564: the old write, 'rescinded', was refused by quotes_bid_status_check).

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
    .select("id, bid_status, status, claim_id, contractor_id, created_at, is_test")
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

  // gh-2564: refuse when the homeowner already selected this bid, or its claim is awarded / contract_signed.
  // The contractor is routed to support (D-215(b)); the policy for withdrawing a selected bid is Dustin's (D-369).
  let claimStatus: string | null = null;
  if (quote.claim_id) {
    const { data: claimRow } = await supabase
      .from("claims")
      .select("status")
      .eq("id", quote.claim_id)
      .maybeSingle();
    claimStatus = claimRow?.status ?? null;
  }
  if (isBidSelectedOrAwarded(quote.status, claimStatus)) {
    return new Response(
      JSON.stringify({ error: BID_SELECTED_ERROR, message: BID_SELECTED_MESSAGE }),
      {
        status: 409,
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
  const { error: updateError, data: updateRows } = await supabase
    .from("quotes")
    .update({
      bid_status: RESCINDED_BID_STATUS,
      updated_at: rescindedAt,
    })
    .eq("id", body.quote_id)
    // gh-2564 (CEO RUN 104 point 3): condition the write on the state that was checked above, so a homeowner
    // selecting this bid, or a double submit, between the read and the write matches zero rows (409 below).
    .neq("status", SELECTED_QUOTE_STATUS)
    .in("bid_status", RESCINDABLE_STATUSES)
    .select("id");

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

  // gh-2105 (decision a, money — HIGH PRIORITY): `.update()` without
  // `.select()` reports success even on a zero-row RLS/id-mismatch match.
  // `quote` was fetched earlier by this same id, so a zero-row match here
  // means it changed out from under the request (RLS, concurrent delete) —
  // without this check the caller would get `success: true` while
  // quotes.bid_status never actually flipped to RESCINDED_BID_STATUS, leaving a bid
  // that still looks live/payable to the award flow.
  if (!Array.isArray(updateRows) || updateRows.length === 0) {
    return new Response(
      JSON.stringify({
        error: "Failed to rescind bid",
        details: "gh2105_zero_rows: no matching quote row was updated",
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

  // Insert activity log entry
  const { error: logError } = await supabase.from("activity_log").insert({
    user_id: user.id,
    event_type: "bid_rescinded",
    title: `Bid rescinded for quote ${body.quote_id}`,
    is_test: quote.is_test ?? false,
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

  // gh-2564: the confirmation card tells the contractor "the homeowner will be notified"; this is that notice.
  // One email, non-fatal: the bid is already withdrawn, so a send failure is logged, never returned as an error.
  let homeownerNotified = false;
  try {
    // gh-2564 (point 4): "The other bids on your project have not changed." is sent only when another live bid exists.
    // Live = another quote on this claim that is still bid_status 'active' and status submitted/selected. A failed
    // count counts as "none", so the sentence is omitted rather than asserted.
    let otherLiveBids = false;
    if (quote.claim_id) {
      const { count: otherCount, error: otherErr } = await supabase
        .from("quotes")
        .select("id", { count: "exact", head: true })
        .eq("claim_id", quote.claim_id)
        .neq("id", body.quote_id)
        .eq("bid_status", "active")
        .in("status", ["submitted", "selected"]);
      otherLiveBids = !otherErr && (otherCount ?? 0) > 0;
    }
    const mailgunApiKey = Deno.env.get("MAILGUN_API_KEY") || "";
    const mailgunDomain = Deno.env.get("MAILGUN_DOMAIN") || "";
    if (mailgunApiKey && mailgunDomain) {
      const notice = await notifyHomeownerOfWithdrawal(
        supabase,
        mailgunSender(mailgunApiKey, mailgunDomain),
        { claimId: quote.claim_id ?? null, contractorId: body.contractor_id, mailgunDomain, otherLiveBids },
      );
      homeownerNotified = notice.sent;
      if (!notice.sent) console.error("[rescind-bid] homeowner notice not sent:", notice.reason);
    } else {
      console.error("[rescind-bid] homeowner notice not sent: MAILGUN_API_KEY / MAILGUN_DOMAIN not set");
    }
  } catch (noticeErr) {
    console.error("[rescind-bid] homeowner notice failed (non-fatal):", noticeErr);
  }

  // Success response
  return new Response(
    JSON.stringify({
      success: true,
      quote_id: body.quote_id,
      rescinded_at: rescindedAt,
      previous_status: previousStatus,
      homeowner_notified: homeownerNotified,
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
