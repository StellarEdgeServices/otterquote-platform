/**
 * OtterQuote Edge Function: get-hover-siding-data
 *
 * Fetches Hover design and material data for a siding claim.
 * Returns:
 *   - siding_materials[]  — material list items with product, color, qty, cost, group, type
 *   - labor_items[]       — labor line items from the Hover estimate
 *   - wall_squares        — total siding wall area in squares
 *   - wall_sqft           — total siding wall area in sq ft
 *   - design_images[]     — rendered/photo images of the 3D model
 *   - material_total      — sum of all MATERIAL-type item costs
 *   - hover_job_id        — Hover job ID for direct link
 *   - job_address         — property address from Hover
 *
 * Gracefully returns partial data if some Hover API calls fail.
 * Never errors out — always returns 200 with whatever we could fetch.
 *
 * Usage:
 *   POST /functions/v1/get-hover-siding-data
 *   Body: { "claim_id": "..." }
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const HOVER_API_BASE = "https://hover.to";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { claim_id } = await req.json();
    if (!claim_id) {
      return new Response(JSON.stringify({ error: "Missing claim_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Step 1: Resolve hover_job_id ─────────────────────────────
    let hoverId: number | null = null;
    let storedMeasurementsJson: any = null;

    // 1a. Check hover_orders table (live OtterQuote jobs)
    const { data: order } = await supabase
      .from("hover_orders")
      .select("hover_job_id, measurements_json")
      .eq("claim_id", claim_id)
      .eq("status", "complete")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (order?.hover_job_id) {
      hoverId = order.hover_job_id;
      storedMeasurementsJson = order.measurements_json;
    }

    // 1b. Fallback: parse hover job ID from claim's measurements_filename
    if (!hoverId) {
      const { data: claim } = await supabase
        .from("claims")
        .select("measurements_filename")
        .eq("id", claim_id)
        .single();

      if (claim?.measurements_filename) {
        // Match: hover_11418054_measurements.json  OR  hover-measurements-job-11418054.pdf
        const match =
          claim.measurements_filename.match(/hover[_-](\d{6,})[_-]/) ||
          claim.measurements_filename.match(/job[_-](\d{6,})/i) ||
          claim.measurements_filename.match(/(\d{6,})/);
        if (match) hoverId = parseInt(match[1]);
      }
    }

    // No Hover job found — return empty result (not an error)
    if (!hoverId) {
      return new Response(
        JSON.stringify({
          hover_job_id: null,
          siding_materials: [],
          labor_items: [],
          wall_squares: null,
          wall_sqft: null,
          design_images: [],
          material_total: null,
          message: "No Hover job linked to this claim",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Step 2: Get Hover access token ────────────────────────────
    const accessToken = await getValidAccessToken(supabase);
    if (!accessToken) {
      return new Response(
        JSON.stringify({
          hover_job_id: hoverId,
          siding_materials: [],
          labor_items: [],
          wall_squares: null,
          wall_sqft: null,
          design_images: [],
          material_total: null,
          message: "Hover authentication unavailable — view in Hover directly",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Step 3: Fetch material list ───────────────────────────────
    let sidingMaterials: any[] = [];
    let laborItems: any[] = [];
    let wallSquares: number | null = null;
    let wallSqft: number | null = null;
    let materialTotal: number | null = null;

    try {
      const mlResponse = await fetch(
        `${HOVER_API_BASE}/api/v1/jobs/${hoverId}/material_list`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (mlResponse.ok) {
        const mlData = await mlResponse.json();
        // Hover may return the list under different keys depending on version
        const listItems: any[] =
          mlData?.list_items ??
          mlData?.listItems ??
          mlData?.data ??
          (Array.isArray(mlData) ? mlData : []);

        // Separate siding materials from labor items
        const sidingItems = listItems.filter((item: any) => {
          const tt = (item.tradeType || item.trade_type || "").toUpperCase();
          return tt.includes("SIDING") || tt.includes("WALL");
        });

        // Map to rich output format
        const mapItem = (item: any) => ({
          product_name:       item.name || item.product_name || item.description || item.listItemGroupName || null,
          group_name:         item.listItemGroupName || item.list_item_group_name || null,
          color:              item.color || null,
          quantity:           item.quantity ?? null,
          calculated_quantity: item.calculatedQuantity ?? item.calculated_quantity ?? null,
          units:              item.quantityUnits || item.measurementUnits || item.quantity_units || null,
          unit_cost:          item.unitCost ?? item.unit_cost ?? null,
          waste_factor:       item.wasteFactor ?? item.waste_factor ?? null,
          pretax_cost:        item.pretaxCost ?? item.pretax_cost ?? null,
          total_cost:         item.totalCost ?? item.total_cost ?? null,
          type:               (item.type || "MATERIAL").toUpperCase(),
          product_catalog_id: item.productCatalogProductId ?? item.product_catalog_product_id ?? null,
        });

        sidingMaterials = sidingItems
          .filter((item: any) => (item.type || "MATERIAL").toUpperCase() === "MATERIAL")
          .map(mapItem);

        laborItems = sidingItems
          .filter((item: any) => (item.type || "").toUpperCase() === "LABOR")
          .map(mapItem);

        // Total cost of all MATERIAL type items
        const totalCostItems = sidingItems
          .filter((item: any) => (item.type || "MATERIAL").toUpperCase() === "MATERIAL")
          .map((item: any) => parseFloat(item.totalCost ?? item.total_cost ?? 0) || 0);
        if (totalCostItems.length > 0) {
          materialTotal = totalCostItems.reduce((a: number, b: number) => a + b, 0);
          if (materialTotal === 0) materialTotal = null; // don't show $0
        }

        // Extract wall area in squares from material data
        const squaresItem = sidingItems.find((m: any) => {
          const units = (m.quantityUnits || m.measurementUnits || "").toLowerCase();
          return units.includes("square") || units.includes("sq");
        });
        if (squaresItem) {
          const qty = squaresItem.calculatedQuantity ?? squaresItem.calculated_quantity ?? squaresItem.quantity;
          if (qty != null) {
            wallSquares = parseFloat(parseFloat(qty).toFixed(1));
            wallSqft = Math.round(wallSquares * 100);
          }
        }
      }
    } catch (mlErr) {
      console.warn("Material list fetch failed (non-fatal):", mlErr);
    }

    // ── Step 4: Fetch job details (for rendered images + measurements) ─
    let designImages: string[] = [];
    let jobAddress: string | null = null;

    try {
      const jobResponse = await fetch(
        `${HOVER_API_BASE}/api/v1/jobs/${hoverId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (jobResponse.ok) {
        const jobData = await jobResponse.json();
        const job = jobData?.job ?? jobData;

        // Try multiple image fields — Hover may return renders, photos, or images
        // Priority: renders > wireframe_images > images > photos
        const imageCollections = [
          job?.renders,
          job?.render_images,
          job?.wireframe_images,
          job?.deliverable_images,
          job?.images,
          job?.photos,
        ];

        for (const collection of imageCollections) {
          if (Array.isArray(collection) && collection.length > 0) {
            const urls = collection
              .filter((img: any) => img?.url || typeof img === "string")
              .map((img: any) => (img?.url || img) as string)
              .filter((url: string) => url && url.startsWith("http"));
            if (urls.length > 0) {
              // Prefer rendered/wireframe images (often higher resolution and show the 3D model)
              designImages = urls.slice(0, 6);
              break;
            }
          }
        }

        // Grab address for display
        if (job?.location?.full_address) {
          jobAddress = job.location.full_address;
        } else if (job?.location?.address) {
          jobAddress = job.location.address;
        }

        // Extract wall area from job measurements if not yet found
        if (!wallSquares && job?.measurements) {
          const wallSqFtRaw =
            job.measurements.wall_area_sq_ft ??
            job.measurements.total_wall_area ??
            job.measurements.siding_area ??
            null;
          if (wallSqFtRaw) {
            wallSqft = Math.round(parseFloat(wallSqFtRaw));
            wallSquares = parseFloat((wallSqft / 100).toFixed(1));
          }
        }
      }
    } catch (jobErr) {
      console.warn("Job details fetch failed (non-fatal):", jobErr);
    }

    // ── Step 5: Extract wall area from stored measurements_json ───
    if (!wallSquares && storedMeasurementsJson) {
      try {
        const mj = storedMeasurementsJson;
        const wallSqFtRaw =
          mj?.structures?.[0]?.areas?.wall ??
          mj?.wall_area_sq_ft ??
          mj?.measurements?.wall_area ??
          mj?.wall_area ??
          null;
        if (wallSqFtRaw) {
          wallSqft = Math.round(parseFloat(wallSqFtRaw));
          wallSquares = parseFloat((wallSqft / 100).toFixed(1));
        }
      } catch (_) {
        // Non-fatal
      }
    }

    return new Response(
      JSON.stringify({
        hover_job_id: hoverId,
        siding_materials: sidingMaterials,
        labor_items: laborItems,
        wall_squares: wallSquares,
        wall_sqft: wallSqft,
        design_images: designImages,
        material_total: materialTotal,
        job_address: jobAddress,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("get-hover-siding-data error:", error);
    // Always return 200 with empty data — never break the bid form
    return new Response(
      JSON.stringify({
        hover_job_id: null,
        siding_materials: [],
        labor_items: [],
        wall_squares: null,
        wall_sqft: null,
        design_images: [],
        material_total: null,
        error: error instanceof Error ? error.message : "Unexpected error",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// ── Token management (same pattern as get-hover-pdf) ─────────────────

async function getValidAccessToken(supabase: any): Promise<string | null> {
  const { data: tokens, error } = await supabase
    .from("hover_tokens")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error || !tokens || tokens.length === 0) {
    console.error("No Hover tokens in hover_tokens table");
    return null;
  }

  const token = tokens[0];
  const expiresAt = new Date(token.expires_at);
  const now = new Date();

  // Still valid (with 5-minute buffer)
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
    console.error("Hover token refresh failed:", refreshResponse.status);
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
