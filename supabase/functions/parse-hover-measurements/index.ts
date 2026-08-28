import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.104.0";
import { extractText, getDocumentProxy } from "https://esm.sh/unpdf@0.11.0";

// ============================================================================
// parse-hover-measurements
// ----------------------------------------------------------------------------
// Standalone service-role Edge Function. Input: { claim_id }.
//   1. Reads claims.measurements_filename.
//   2. Downloads that object from the `claim-documents` storage bucket.
//   3. Extracts all-page text via unpdf.
//   4. Parses the Hover "ROOF SUMMARY" table (roof area, ridges/hips, valleys,
//      rakes, eaves, drip-edge/perimeter, step flashing, flashing, pitch).
//   5. Writes a normalized JSONB blob to claims.hover_measurements.
//
// Contract:
//   - Auth: Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY> (server-to-server;
//     invoked by create-docusign-envelope). No user-JWT path.
//   - Returns { ok:true, measurements } on success.
//   - Returns 200 { ok:false, error } on a "soft" miss (no measurements_filename,
//     download failure, unreadable PDF, or ROOF SUMMARY not found) — nothing to
//     parse is not a server error.
//   - Returns 500 { ok:false, error } only on a hard failure (DB read/write
//     error or an unexpected exception).
//   - Never throws out of the parser itself (defensive; nulls for missing fields).
// ============================================================================

// CORS allowlist — mirrors create-docusign-envelope / send-sms / switch-contractor.
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];
function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function jsonResponse(status: number, body: unknown, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// ROOF SUMMARY parser (pure; never throws; nulls for anything not confidently
// extracted). Validated against the reference Hover report 10187447: roof
// 2260 sf / 22.6 SQ, ridges/hips 91.17, valleys 99.67, rakes 226.25, eaves
// 86.67, drip/perimeter 312.92, step flashing 55.83, flashing 24.33, 9/12.
// ---------------------------------------------------------------------------
interface RoofSummary {
  roof_area_sf: number | null;
  squares: number | null;
  ridge_hip_lf: number | null;
  valley_lf: number | null;
  rake_lf: number | null;
  eave_lf: number | null;
  drip_edge_perimeter_lf: number | null;
  step_flashing_lf: number | null;
  flashing_lf: number | null;
  predominant_pitch: string | null;
  // [C4 / Tier 3A, 2026-08-27] Per-pitch area breakdown. Additive and nullable:
  // every existing consumer keeps working when this is absent.
  //
  // The parser ALREADY walked this table -- it scanned `<n>/<n> <area> ft <pct>%`
  // rows to pick the highest-percentage pitch and threw the areas away. Keeping
  // them is what lets Exhibit A break tear-off and install out by slope band
  // instead of quoting one lump `Roof area +10%` row.
  //
  // NOTE ON SOURCE: this reads the HOVER report layout. RoofScope and RoofScope X
  // -- which are the reports OtterQuote actually buys (see the gh-1245 catalog:
  // roof_basic is RoofScopeX) -- are image-only PDFs with NO text layer at all,
  // verified 2026-08-27 with unpdf, pdftotext and pypdf all returning 0 chars.
  // No text parser can read them; that path needs the Scope Technologies API.
  areas_by_pitch: Array<{ pitch: string; area_sf: number; squares: number; pct: number | null }> | null;
}

function parseRoofSummary(fullText: string | null | undefined): RoofSummary {
  const out: RoofSummary = {
    roof_area_sf: null, squares: null,
    ridge_hip_lf: null, valley_lf: null, rake_lf: null, eave_lf: null,
    drip_edge_perimeter_lf: null, step_flashing_lf: null, flashing_lf: null,
    predominant_pitch: null,
    areas_by_pitch: null,
  };
  if (!fullText || typeof fullText !== "string") return out;

  // Normalize: NBSP -> space, collapse all whitespace (incl. newlines) to a
  // single space. unpdf joins page text with spaces/newlines; after this the
  // ROOF SUMMARY table cells read left-to-right as
  // "<label> <area> <count> <length>" (e.g. `Ridges / Hips - 7 91' 2"`).
  const text = fullText.replace(/ /g, " ").replace(/[ \t\r\n\f\v]+/g, " ");

  const round2 = (n: number) => Math.round(n * 100) / 100;

  // Isolate the roof-measurement table so cross-section look-alikes cannot
  // contaminate roofline lengths: the siding section carries "Eaves Fascia
  // 86' 8\"" / "Rakes Fascia 226' 3\"" and per-facet pages repeat lowercase
  // "eave"/"rake". The table runs from "Roof Facets" to the waste table that
  // follows the pitch rows ("ROOF SUMMARY"/"Example Waste"/"Footprint").
  let region = text;
  const rfIdx = text.search(/Roof\s+Facets/i);
  if (rfIdx !== -1) {
    const rest = text.slice(rfIdx);
    const endM = rest.search(/ROOF SUMMARY|Example Waste|Footprint|Soffit Summary/i);
    region = endM === -1 ? rest : rest.slice(0, endM);
  }

  // Feet(-inches) length for a labeled roofline row, scoped to `region`.
  // Requires a feet token ("<n>'") within a short window AFTER the label, so a
  // label that also appears as prose (carrying no measurement) is skipped and
  // the count cell (a bare number, no apostrophe) is stepped over by backtracking.
  function lfFor(labelPat: string): number | null {
    const re = new RegExp(labelPat + "[\\s\\S]{0,24}?(\\d+)'(?:\\s*(\\d+)\\s*\")?", "i");
    const m = region.match(re);
    if (!m) return null;
    const feet = parseInt(m[1], 10);
    const inches = m[2] ? parseInt(m[2], 10) : 0;
    if (Number.isNaN(feet)) return null;
    return round2(feet + inches / 12);
  }

  out.ridge_hip_lf = lfFor("Ridges\\s*/\\s*Hips");
  out.valley_lf = lfFor("Valleys");
  out.rake_lf = lfFor("Rakes");
  out.eave_lf = lfFor("Eaves");
  out.flashing_lf = lfFor("Flashing"); // standalone "Flashing" precedes "Step Flashing"
  out.step_flashing_lf = lfFor("Step Flashing");
  out.drip_edge_perimeter_lf = lfFor("Drip Edge\\s*/\\s*Perimeter");

  // Roof area (sf): the "Roof Facets <area> ft" data row.
  let am = region.match(/Roof\s+Facets[\s\S]{0,20}?([\d,]+)\s*ft/i);
  if (!am) {
    // Fallback: the waste table's zero-waste "Area <sf> ft" first column.
    am = text.match(/\bArea\s+([\d,]+)\s*ft/i);
  }
  if (am) {
    const sf = parseInt(am[1].replace(/,/g, ""), 10);
    if (!Number.isNaN(sf) && sf > 0) {
      out.roof_area_sf = sf;
      out.squares = Math.round((sf / 100) * 10) / 10; // squares = round(area/100, 1)
    }
  }

  // Pitch rows: "<n> / <n> <area> ft <pct>%". The area column is now CAPTURED
  // (it used to be a non-capturing [\d,]+ and was discarded) so the same single
  // pass yields both the predominant pitch and the full per-pitch breakdown.
  const pitchRe = /(\d+)\s*\/\s*(\d+)\s+([\d,]+)\s*ft\S*\s+([\d.]+)\s*%/gi;
  let pm: RegExpExecArray | null;
  let best: { pitch: string; pct: number } | null = null;
  const byPitch: Array<{ pitch: string; area_sf: number; squares: number; pct: number | null }> = [];
  while ((pm = pitchRe.exec(region)) !== null) {
    const pct = parseFloat(pm[4]);
    const areaSf = parseInt(pm[3].replace(/,/g, ""), 10);
    const pitch = `${pm[1]}/${pm[2]}`;
    if (!Number.isNaN(pct) && (best === null || pct > best.pct)) {
      best = { pitch, pct };
    }
    if (!Number.isNaN(areaSf) && areaSf > 0) {
      byPitch.push({
        pitch,
        area_sf: areaSf,
        squares: Math.round((areaSf / 100) * 100) / 100,
        pct: Number.isNaN(pct) ? null : pct,
      });
    }
  }
  if (best) out.predominant_pitch = best.pitch;
  // Only emitted when more than nothing was found. An empty array would read as
  // "measured, and the roof has no pitched area", which is not what null means.
  if (byPitch.length > 0) out.areas_by_pitch = byPitch;

  return out;
}

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // ===== AUTH: service-role bearer only =====
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authHeader = req.headers.get("Authorization") || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!serviceRoleKey || bearer !== serviceRoleKey) {
    return jsonResponse(401, { ok: false, error: "Unauthorized" }, corsHeaders);
  }

  // ===== INPUT =====
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const claimId = typeof body?.claim_id === "string" ? body.claim_id : null;
  if (!claimId) {
    return jsonResponse(400, { ok: false, error: "Missing claim_id" }, corsHeaders);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) {
    return jsonResponse(500, { ok: false, error: "SUPABASE_URL not configured" }, corsHeaders);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    // 1. Read the stored Hover report path off the claim.
    const { data: claim, error: claimErr } = await supabase
      .from("claims")
      .select("measurements_filename")
      .eq("id", claimId)
      .maybeSingle();
    if (claimErr) {
      // Hard failure — DB read error.
      return jsonResponse(500, { ok: false, error: `claims read failed: ${claimErr.message}` }, corsHeaders);
    }
    const filename = claim?.measurements_filename;
    if (!filename) {
      // Soft miss — nothing to parse.
      return jsonResponse(200, { ok: false, error: "No measurements_filename on claim" }, corsHeaders);
    }

    // 2. Download the Hover PDF from storage.
    let pdfBytes: Uint8Array | null = null;
    try {
      const { data: blob, error: dlErr } = await supabase.storage
        .from("claim-documents")
        .download(String(filename));
      if (dlErr || !blob) {
        return jsonResponse(200, {
          ok: false,
          error: `Download failed for claim-documents/${filename}: ${dlErr?.message ?? "no data"}`,
        }, corsHeaders);
      }
      pdfBytes = new Uint8Array(await blob.arrayBuffer());
    } catch (dlEx) {
      return jsonResponse(200, {
        ok: false,
        error: `Download exception: ${dlEx instanceof Error ? dlEx.message : String(dlEx)}`,
      }, corsHeaders);
    }

    // 3. Extract all-page text via unpdf. An unreadable/corrupt PDF is a soft
    //    miss (there is simply nothing to parse), not a server error.
    let fullText = "";
    try {
      const pdf = await getDocumentProxy(pdfBytes);
      const extracted = await extractText(pdf, { mergePages: true });
      const t = (extracted as { text?: unknown })?.text;
      fullText = Array.isArray(t) ? t.join("\n") : String(t ?? "");
    } catch (exErr) {
      return jsonResponse(200, {
        ok: false,
        error: `PDF text extraction failed: ${exErr instanceof Error ? exErr.message : String(exErr)}`,
      }, corsHeaders);
    }

    // 4. Parse the ROOF SUMMARY.
    const parsed = parseRoofSummary(fullText);

    const anyValue =
      parsed.roof_area_sf != null || parsed.ridge_hip_lf != null || parsed.valley_lf != null ||
      parsed.rake_lf != null || parsed.eave_lf != null || parsed.drip_edge_perimeter_lf != null ||
      parsed.step_flashing_lf != null || parsed.flashing_lf != null || parsed.predominant_pitch != null;
    if (!anyValue) {
      // Soft miss — ROOF SUMMARY not found / not parseable in this document.
      return jsonResponse(200, { ok: false, error: "ROOF SUMMARY not found in PDF" }, corsHeaders);
    }

    // 5. Persist the normalized measurements.
    const measurements = {
      source: "pdf_parse",
      parsed_at: new Date().toISOString(),
      roof_area_sf: parsed.roof_area_sf,
      squares: parsed.squares,
      ridge_hip_lf: parsed.ridge_hip_lf,
      valley_lf: parsed.valley_lf,
      rake_lf: parsed.rake_lf,
      eave_lf: parsed.eave_lf,
      drip_edge_perimeter_lf: parsed.drip_edge_perimeter_lf,
      step_flashing_lf: parsed.step_flashing_lf,
      flashing_lf: parsed.flashing_lf,
      predominant_pitch: parsed.predominant_pitch,
      areas_by_pitch: parsed.areas_by_pitch,
    };

    const { error: upErr } = await supabase
      .from("claims")
      .update({ hover_measurements: measurements })
      .eq("id", claimId);
    if (upErr) {
      // Hard failure — DB write error.
      return jsonResponse(500, { ok: false, error: `claims update failed: ${upErr.message}` }, corsHeaders);
    }

    return jsonResponse(200, { ok: true, measurements }, corsHeaders);
  } catch (err) {
    // Unexpected hard failure.
    console.error("parse-hover-measurements error:", err);
    return jsonResponse(500, {
      ok: false,
      error: err instanceof Error ? err.message : "Unexpected error",
    }, corsHeaders);
  }
});
