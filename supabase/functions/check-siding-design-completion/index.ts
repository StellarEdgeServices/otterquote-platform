/**
 * OtterQuote Edge Function: check-siding-design-completion
 *
 * D-164 polling function — runs every 30 minutes via pg_cron.
 *
 * Finds all retail siding claims where:
 *   - funding_type = 'cash' (retail)
 *   - 'siding' is in the trades array
 *   - has_measurements = true (Hover job is done, homeowner can design)
 *   - siding_bid_released_at IS NULL (gate not yet cleared)
 *   - status IN ('bidding', 'submitted') — claim is live
 *
 * For each qualifying claim:
 *   1. Calls get-hover-siding-data to evaluate the four-field gate
 *      (manufacturer, profile, color, trim must all be present)
 *   2. If design_complete = true:
 *      a. Sets claims.siding_bid_released_at = NOW()
 *      b. Calls notify-contractors scoped to siding trade only
 *      c. Sends homeowner a confirmation notification
 *
 * Can also be called manually for a specific claim:
 *   POST /functions/v1/check-siding-design-completion
 *   Body: { "claim_id": "..." }  ← optional; omit to scan all
 *
 * No JWT auth required (cron caller uses service role key via Authorization header).
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const HOVER_API_BASE = "https://hover.to";

// D-164: Known siding manufacturer name fragments
const KNOWN_MANUFACTURERS = [
  "james hardie", "hardie", "lp smartside", "smartside",
  "certainteed", "vinyl", "alside", "mastic", "revere",
  "gentek", "provia", "fiber cement", "wood", "aluminum", "steel",
];

// D-164: Known siding profile/style name fragments
const KNOWN_PROFILES = [
  "dutch lap", "board and batten", "board & batten", "clapboard",
  "beveled", "shakes", "shingle", "smooth panel", "lap siding",
  "lap panel", "beaded", "v-groove", "vertical", "horizontal", "plank",
];

// D-164: Trim indicator fragments
const TRIM_INDICATORS = [
  "trim", "fascia", "corner", "j-trim", "j trim", "frieze",
  "soffit", "rake", "starter strip", "finish trim", "window trim", "door trim",
];

// CORS tightened (Session 254): origin-allowlisted instead of wildcard.
// NOTE: This endpoint is typically invoked by pg_cron (no CORS needed) or
// the service role key; the allowlist is defense-in-depth.
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
];

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Vary": "Origin",
  };
}

// ── Cron health helper ───────────────────────────────────────────────────────
async function writeCronHealth(supabase: any, status: "success" | "error", error?: string): Promise<void> {
  try {
    await supabase.rpc("record_cron_health", {
      p_job_name: "check-siding-design-completion",
      p_status:   status,
      p_error:    error ?? null,
    });
  } catch (e) {
    console.warn("[D-164] cron_health write failed (non-fatal):", e);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: buildCorsHeaders(req) });
  }

  const supabaseUrl  = Deno.env.get("SUPABASE_URL")!;
  const serviceKey   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase     = createClient(supabaseUrl, serviceKey);
  const selfBaseUrl  = supabaseUrl.replace(".supabase.co", ".functions.supabase.co");

  const results: any[] = [];
  let targetClaimId: string | null = null;

  // Optional: single-claim override
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body?.claim_id) targetClaimId = body.claim_id;
    }
  } catch (_) { /* non-fatal */ }

  try {
    // ── 1. Find qualifying retail siding claims ─────────────────
    let query = supabase
      .from("claims")
      .select("id, user_id, trades, property_address, measurements_filename, siding_bid_released_at")
      .eq("funding_type", "cash")
      .eq("has_measurements", true)
      .is("siding_bid_released_at", null)
      .in("status", ["bidding", "submitted"]);

    if (targetClaimId) {
      query = query.eq("id", targetClaimId);
    } else {
      // Only claims that include siding — Postgres JSON contains operator
      query = query.contains("trades", ["siding"]);
    }

    const { data: claims, error: claimsErr } = await query;

    if (claimsErr) {
      console.error("[D-164] Failed to load claims:", claimsErr.message);
      await writeCronHealth(supabase, "error", `claims query failed: ${claimsErr.message}`);
      return new Response(JSON.stringify({ ok: false, error: claimsErr.message }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!claims || claims.length === 0) {
      console.log("[D-164] No qualifying claims found.");
      await writeCronHealth(supabase, "success");
      return new Response(JSON.stringify({ ok: true, checked: 0, released: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Filter by siding trade when doing a full scan (JS fallback if DB operator varies)
    const sidingClaims = targetClaimId
      ? claims
      : claims.filter((c: any) =>
          Array.isArray(c.trades) && c.trades.some((t: string) => t.toLowerCase().includes("siding"))
        );

    console.log(`[D-164] Checking ${sidingClaims.length} retail siding claim(s)`);

    // ── 2. Get Hover access token (once for the whole batch) ─────
    const accessToken = await getValidAccessToken(supabase);

    // ── 3. Evaluate each claim ───────────────────────────────────
    for (const claim of sidingClaims) {
      try {
        const result = await evaluateClaim(claim, supabase, accessToken, serviceKey, selfBaseUrl);
        results.push({ claim_id: claim.id, ...result });
      } catch (err) {
        console.error(`[D-164] Error evaluating claim ${claim.id}:`, err);
        results.push({ claim_id: claim.id, error: String(err) });
      }
    }

    const released = results.filter((r: any) => r.released).length;
    console.log(`[D-164] Done. Checked: ${sidingClaims.length}, Released: ${released}`);

    const errorResults = results.filter((r: any) => r.error);
    const cronStatus   = errorResults.length > 0 ? "error" : "success";
    const cronError    = errorResults.length > 0
      ? errorResults.slice(0, 3).map((r: any) => `${r.claim_id}: ${r.error}`).join("; ")
      : null;
    await writeCronHealth(supabase, cronStatus, cronError ?? undefined);

    return new Response(
      JSON.stringify({ ok: true, checked: sidingClaims.length, released, results }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[D-164] Unexpected error:", err);
    await writeCronHealth(supabase, "error", `unexpected: ${String(err)}`);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a US address string like "123 Main St, Springfield, IL 62704"
 * into claim_zip, claim_city, claim_state fields for notify-contractors.
 */
function parseAddress(addr: string): { claim_zip: string; claim_city: string; claim_state: string; claim_county: string } {
  const parts = addr.split(",").map((p) => p.trim());
  let claim_zip = "";
  let claim_city = "";
  let claim_state = "IN"; // fallback

  if (parts.length >= 3) {
    // Last part: "IL 62704" or "IN 46032"
    const stateZip = parts[parts.length - 1].trim();
    const stateZipParts = stateZip.split(/\s+/);
    if (stateZipParts.length >= 2) {
      claim_state = stateZipParts[0];
      claim_zip   = stateZipParts[stateZipParts.length - 1];
    } else {
      claim_state = stateZip;
    }
    claim_city = parts[parts.length - 2].trim();
  } else if (parts.length === 2) {
    claim_city = parts[0].trim();
    claim_state = parts[1].trim();
  }

  return { claim_zip, claim_city, claim_state, claim_county: "" };
}

// ─────────────────────────────────────────────────────────────────────────────

async function evaluateClaim(
  claim: any,
  supabase: any,
  accessToken: string | null,
  serviceKey: string,
  selfBaseUrl: string
): Promise<{ released: boolean; reason: string }> {
  const claimId = claim.id;

  // ── Resolve hover_job_id ─────────────────────────────────────
  let hoverId: number | null = null;

  const { data: order } = await supabase
    .from("hover_orders")
    .select("hover_job_id")
    .eq("claim_id", claimId)
    .eq("status", "complete")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (order?.hover_job_id) {
    hoverId = order.hover_job_id;
  } else if (claim.measurements_filename) {
    const mf = claim.measurements_filename;
    const m =
      mf.match(/hover[_-](\d{6,})[_-]/) ||
      mf.match(/job[_-](\d{6,})/i) ||
      mf.match(/(\d{6,})/);
    if (m) hoverId = parseInt(m[1]);
  }

  if (!hoverId) {
    return { released: false, reason: "no_hover_job" };
  }

  if (!accessToken) {
    return { released: false, reason: "no_hover_token" };
  }

  // ── Fetch material list from Hover ───────────────────────────
  let allSidingItems: any[] = [];

  try {
    const mlRes = await fetch(
      `${HOVER_API_BASE}/api/v1/jobs/${hoverId}/material_list`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (mlRes.ok) {
      const mlData = await mlRes.json();
      const listItems: any[] =
        mlData?.list_items ?? mlData?.listItems ?? mlData?.data ??
        (Array.isArray(mlData) ? mlData : []);

      allSidingItems = listItems.filter((item: any) => {
        const tt = (item.tradeType || item.trade_type || "").toUpperCase();
        return tt.includes("SIDING") || tt.includes("WALL");
      });
    } else {
      console.warn(`[D-164] Hover material_list ${mlRes.status} for job ${hoverId}`);
      return { released: false, reason: `hover_api_${mlRes.status}` };
    }
  } catch (err) {
    console.warn(`[D-164] Hover material_list fetch failed for job ${hoverId}:`, err);
    return { released: false, reason: "hover_fetch_error" };
  }

  // ── Evaluate four-field gate ─────────────────────────────────
  const attrs = extractDesignAttributes(allSidingItems);
  console.log(`[D-164] Claim ${claimId}: manufacturer=${attrs.manufacturer}, profile=${attrs.profile}, color=${attrs.color}, trim=${attrs.trim}, complete=${attrs.complete}`);

  if (!attrs.complete) {
    return { released: false, reason: "design_incomplete" };
  }

  // ── Gate cleared — release siding bids ──────────────────────
  const now = new Date().toISOString();

  const { error: updateErr } = await supabase
    .from("claims")
    .update({ siding_bid_released_at: now })
    .eq("id", claimId)
    .is("siding_bid_released_at", null); // idempotent guard

  if (updateErr) {
    console.error(`[D-164] Failed to set siding_bid_released_at on claim ${claimId}:`, updateErr.message);
    return { released: false, reason: "db_update_failed" };
  }

  console.log(`[D-164] ✅ Siding bids RELEASED for claim ${claimId}`);

  // ── Notify contractors (siding trade only) ───────────────────
  try {
    const notifyRes = await fetch(
      `${selfBaseUrl}/functions/v1/notify-contractors`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({
          event: "new_opportunity",
          claim_id:    claimId,
          ...parseAddress(claim.property_address || ""),
          trade_types: ["siding"],  // D-165: scoped to siding contractors only
          job_type:    "retail",
        }),
      }
    );
    if (!notifyRes.ok) {
      console.warn(`[D-164] notify-contractors returned ${notifyRes.status} for claim ${claimId}`);
    }
  } catch (notifyErr) {
    console.warn(`[D-164] notify-contractors call failed (non-fatal) for claim ${claimId}:`, notifyErr);
  }

  // ── Notify homeowner (dashboard notification) ───────────────
  try {
    await supabase.from("notifications").insert({
      user_id:           claim.user_id,
      claim_id:          claimId,
      notification_type: "siding_bids_released",
      channel:           "dashboard",
      message_preview:   "Your siding design is locked in and contractors are now bidding. Check back soon to compare quotes.",
    });
  } catch (notifErr) {
    console.warn(`[D-164] Homeowner notification insert failed (non-fatal) for claim ${claimId}:`, notifErr);
  }

  return { released: true, reason: "design_complete" };
}

// ── Design attribute extraction (mirrors get-hover-siding-data) ──────────────

function extractDesignAttributes(sidingItems: any[]): {
  manufacturer: string | null;
  profile: string | null;
  color: string | null;
  trim: string | null;
  complete: boolean;
} {
  let manufacturer: string | null = null;
  let profile: string | null = null;
  let color: string | null = null;
  let trim: string | null = null;

  for (const item of sidingItems) {
    const productName = (item.name || item.product_name || item.description || "").toLowerCase();
    const groupName   = (item.listItemGroupName || item.list_item_group_name || "").toLowerCase();
    const combined    = `${productName} ${groupName}`;
    const itemColor   = (item.color || "").trim();

    if (!manufacturer) {
      for (const mfr of KNOWN_MANUFACTURERS) {
        if (combined.includes(mfr)) {
          manufacturer = item.listItemGroupName || item.list_item_group_name || item.name || item.product_name || mfr;
          break;
        }
      }
    }

    if (!profile) {
      for (const prof of KNOWN_PROFILES) {
        if (combined.includes(prof)) {
          profile = item.name || item.product_name || item.description || prof;
          break;
        }
      }
    }

    if (!color && itemColor.length > 0) {
      color = itemColor;
    }

    if (!trim) {
      for (const indicator of TRIM_INDICATORS) {
        if (combined.includes(indicator)) {
          trim = item.name || item.product_name || item.description || item.listItemGroupName || indicator;
          break;
        }
      }
    }
  }

  return { manufacturer, profile, color, trim, complete: !!(manufacturer && profile && color && trim) };
}

// ── Token management ─────────────────────────────────────────────────────────

async function getValidAccessToken(supabase: any): Promise<string | null> {
  const { data: tokens, error } = await supabase
    .from("hover_tokens")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error || !tokens || tokens.length === 0) {
    console.error("[D-164] No Hover tokens found");
    return null;
  }

  const token = tokens[0];
  const expiresAt = new Date(token.e