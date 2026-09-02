import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.104.0";
// deno-lint-ignore no-explicit-any
async function getHomeownerName(supabase, claimId) {
  const empty = {
    fullName: "",
    email: ""
  };
  if (!claimId) return empty;
  const { data: claimData } = await supabase.from("claims").select("user_id").eq("id", claimId).single();
  if (!claimData?.user_id) return empty;
  const { data: profile } = await supabase.from("profiles").select("full_name, email").eq("id", claimData.user_id).single();
  return {
    fullName: profile?.full_name ?? "",
    email: profile?.email ?? ""
  };
}
const FUNCTION_NAME = "create-docusign-envelope";
const PDF_MAX_BYTES = 3_000_000;
class DocumentTooLargeError extends Error {
  statusCode = 400;
  code = "DOCUMENT_TOO_LARGE";
  constructor(fileName, bytes){
    super(`PDF "${fileName}" is ${(bytes / 1_000_000).toFixed(1)} MB — exceeds the 3 MB limit. Upload a smaller file.`);
    this.name = "DocumentTooLargeError";
  }
}
// CORS tightened Apr 15, 2026 (Session 195): sensitive function (contract
// envelope creation + DocuSign signing URL generation) — origin allowlisted
// instead of wildcard. Matches the Session 181 pattern applied to send-sms,
// send-adjuster-email, create-payment-intent, create-setup-intent,
// admin-contractor-action, and switch-contractor.
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app"
];
function buildCorsHeaders(req) {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin"
  };
}
// [D-274 / #631] Service-role-equivalent credential via the new secret-key
// rotation pattern, NOT the legacy auto-injected SUPABASE_SERVICE_ROLE_KEY —
// same helper/rationale as docusign-webhook/index.ts's getServiceRoleKey().
function getServiceRoleKey() {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.default) return parsed.default;
    } catch (_e) {
      console.warn("[create-docusign-envelope] SUPABASE_SECRET_KEYS present but not valid JSON — falling back to legacy key");
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}
// ========== GA4 MEASUREMENT PROTOCOL ==========
async function sendGA4Event(eventName, params = {}) {
  const measurementId = Deno.env.get("GA4_MEASUREMENT_ID");
  const apiSecret = Deno.env.get("GA4_API_SECRET");
  if (!measurementId || !apiSecret) return;
  try {
    await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        client_id: "server",
        events: [
          {
            name: eventName,
            params
          }
        ]
      })
    });
  } catch (_) {}
}
// ========== BOLDSIGN AUTH (D-274 / #631) ==========
// Replaces ~175 lines of DocuSign JWT-grant machinery (base64url encoding,
// PKCS#1->PKCS#8 ASN.1 wrapping, token fetch + caching, /oauth/userinfo
// account-ID resolution) with a single header. BoldSign auth is a plain API
// key (X-API-KEY) — no OAuth exchange, no token expiry/caching needed, no
// "account ID" concept to resolve. BOLDSIGN_API is the confirmed-working
// secret name (verified 2026-08-13 via a throwaway diagnostic EF against
// GET /v1/senderIdentities/list — see the D-274 build report on #631).
const BOLDSIGN_API_BASE = Deno.env.get("BOLDSIGN_API_BASE") || "https://api.boldsign.com";
function getBoldSignApiKey() {
  const key = Deno.env.get("BOLDSIGN_API");
  if (!key) {
    throw new Error("BOLDSIGN_API not configured.");
  }
  return key;
}
function boldSignHeaders(extra = {}) {
  return {
    "X-API-KEY": getBoldSignApiKey(),
    ...extra
  };
}
// gh-1244: POST /v1/document/send returns a documentId once BoldSign accepts
// the request, but document creation (Text Tag discovery/validation) happens
// asynchronously afterward. Calling getEmbeddedSignLink (or properties)
// before that finishes returns 403 {"error":"Invalid Document ID"} -- NOT a
// permission/scope problem. Proven live on gh-1244: the identical documentId,
// key, and endpoint 403'd 2.5s after send and returned a signing URL 4
// minutes later. Poll properties until it settles instead of failing on the
// first 403 -- do not delete this as a nonsense retry-on-403, see the
// gh-1244 comment thread for the full proof.
async function waitForBoldSignDocumentReady(documentId, { intervalMs = 200, ceilingMs = 15000 } = {}) {
  const deadline = Date.now() + ceilingMs;
  let lastStatus = null;
  let lastBody = "";
  while (Date.now() < deadline) {
    const res = await fetch(
      `${BOLDSIGN_API_BASE}/v1/document/properties?documentId=${encodeURIComponent(documentId)}`,
      { headers: boldSignHeaders() }
    );
    if (res.ok) return;
    lastStatus = res.status;
    lastBody = await res.text().catch(() => "");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `BoldSign document ${documentId} did not finish background creation within ${ceilingMs}ms ` +
    `(last response: ${lastStatus} ${lastBody}). This is a wait timeout, not a permission or ` +
    `scope problem -- see gh-1244: BoldSign returns 403 for a document that exists but has not ` +
    `finished background validation yet.`
  );
}
// ========== PDF RETRIEVAL ==========
async function getTemplateFromStorage(supabase, contractorId, documentType) {
  const bucketName = "contractor-templates";
  const filePath = `${contractorId}/${documentType}.pdf`;
  try {
    const { data, error } = await supabase.storage.from(bucketName).download(filePath);
    if (error) {
      throw new Error(`Storage error: ${error.message}`);
    }
    if (!data) {
      throw new Error("No data returned from storage");
    }
    const arrayBuffer = await data.arrayBuffer();
    const fileBytes = new Uint8Array(arrayBuffer);
    if (fileBytes.length > PDF_MAX_BYTES) {
      throw new DocumentTooLargeError(filePath, fileBytes.length);
    }
    return base64EncodeBinary(fileBytes);
  } catch (err) {
    if (err instanceof DocumentTooLargeError) throw err;
    throw new Error(`Failed to retrieve template PDF (${bucketName}/${filePath}): ${err.message}`);
  }
}
async function fetchTemplateFromUrl(url) {
  console.log(`Fetching template PDF from URL: ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch template from URL (${response.status} ${response.statusText}): ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return base64EncodeBinary(new Uint8Array(arrayBuffer));
}
async function getPcTemplateFromStorage(supabase, fileUrl) {
  let storagePath;
  const pathMatch = fileUrl.match(/contractor-templates\/(.+?)(\?|$)/);
  if (pathMatch) {
    storagePath = decodeURIComponent(pathMatch[1]);
  } else {
    storagePath = fileUrl;
  }
  console.log(`Fetching PC template from storage: contractor-templates/${storagePath}`);
  const { data, error } = await supabase.storage.from("contractor-templates").download(storagePath);
  if (error) {
    throw new Error(`PC template storage error (${storagePath}): ${error.message}`);
  }
  if (!data) {
    throw new Error(`No data returned from storage for PC template: ${storagePath}`);
  }
  const arrayBuffer = await data.arrayBuffer();
  const fileBytes = new Uint8Array(arrayBuffer);
  if (fileBytes.length > PDF_MAX_BYTES) {
    throw new DocumentTooLargeError(storagePath, fileBytes.length);
  }
  return base64EncodeBinary(fileBytes);
}
function selectPcTemplateSlot(pcTemplateJsonb, trade, fundingType) {
  if (!pcTemplateJsonb || typeof pcTemplateJsonb !== "object") return null;
  const primaryKey = `${trade.toLowerCase()}/${fundingType.toLowerCase()}`;
  const fallbackKey = "roofing/insurance";
  const primary = pcTemplateJsonb[primaryKey];
  if (primary?.file_url) {
    console.log(`PC template: using slot ${primaryKey}`);
    return primary;
  }
  const fallback = pcTemplateJsonb[fallbackKey];
  if (fallback?.file_url) {
    console.warn(`PC template: slot ${primaryKey} missing — falling back to ${fallbackKey}`);
    return fallback;
  }
  console.warn(`PC template: no usable slot found (tried ${primaryKey} and ${fallbackKey})`);
  return null;
}
function base64EncodeBinary(bytes) {
  let binary = "";
  for(let i = 0; i < bytes.byteLength; i++){
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
// ========== [C4 2026-08-27] SLOPE BANDS ==========
// Dustin's ruling, 2026-08-27: "Per contractor band, but fall back to
// exactimate if none is given."
//
// WHY PER-CONTRACTOR AND NOT A PLATFORM CONSTANT. Three authorities disagree
// about where "steep" starts, and all three are real:
//   - Indy Rooftops' own rate card: "STEEP CHARGES OVER 5/12", then a second
//     band his document describes as "Roofs from 10/12 to 12/12".
//   - Xactimate: applies its pitch modifier at 7/12 and steeper (confirmed).
//   - RoofScope's own report: Flat 0:12-1:12, Low 2:12-3:12, Standard 4:12-6:12,
//     Steep "7:12 or greater" -- i.e. Xactimate-aligned (read off a live
//     RoofScope report, 2026-08-27).
// A contractor bidding retail off 5/12 while supplementing insurance off 7/12
// produces inconsistent numbers on the same roof. That is his commercial
// choice to make, so the bands are HIS data. We store the raw per-pitch areas
// and bucket at render time -- never store pre-bucketed totals, or changing a
// band would silently rewrite history.
//
// FALLBACK. Only what could be confirmed from a primary source is encoded: the
// 7/12 threshold. The commonly-cited upper Xactimate boundaries (7-9, 10-12,
// over 12) could NOT be confirmed, so they are deliberately NOT invented here.
// Two bands, not four. Check a live Xactimate price list before adding more.
const XACTIMATE_FALLBACK_BANDS = [
  { label: "Standard slope (6/12 and under)", max_over_12: 6 },
  { label: "Steep slope (7/12 and greater)", min_over_12: 7 },
];

// Parse "10/12", "10:12" or "10" to its rise over 12. Returns null if the run
// is not 12 -- we do not rescale, because a 6/6 pitch is not a 12/12 roof and
// silently converting one to the other would misprice the job.
function pitchOver12(pitch) {
  if (pitch == null) return null;
  const m = String(pitch).trim().match(/^(\d+(?:\.\d+)?)\s*[\/:]\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const rise = Number(m[1]), run = Number(m[2]);
    if (!Number.isFinite(rise) || !Number.isFinite(run) || run === 0) return null;
    return run === 12 ? rise : null;
  }
  const bare = Number(String(pitch).trim());
  return Number.isFinite(bare) ? bare : null;
}

/**
 * Bucket per-pitch areas into a contractor's priced slope bands.
 *
 * Returns { buckets, unbandedSquares, unparsedSquares }.
 *   - buckets: one entry per band that actually has area, in band order.
 *   - unbandedSquares: area whose pitch is ABOVE the top priced band. This is
 *     surfaced, never folded into the last band. The reference RoofScope report
 *     carries 2.80 SQ at 24:12 against a rate card whose top band stops at
 *     12/12 -- quietly absorbing that is how a contractor ends up doing 63-degree
 *     roof for free.
 *   - unparsedSquares: rows whose pitch string could not be read at all.
 */
// Compact a bucket's pitch list for display: a single pitch renders as itself,
// several render as a range. Long comma lists blew out the Basis column and told
// the reader nothing the range does not.
function pitchRangeLabel(pitches) {
  const nums = pitches.map(pitchOver12).filter((n) => n !== null).sort((a, b) => a - b);
  if (nums.length === 0) return pitches.join(", ");
  if (nums.length === 1) return `${nums[0]}/12`;
  return `${nums[0]}/12-${nums[nums.length - 1]}/12`;
}

function bucketByBands(areasByPitch, bands) {
  const list = Array.isArray(areasByPitch) ? areasByPitch : [];
  const useBands = (Array.isArray(bands) && bands.length > 0) ? bands : XACTIMATE_FALLBACK_BANDS;
  const buckets = useBands.map((b) => ({ band: b, squares: 0, pitches: [] }));
  let unbandedSquares = 0;
  const unbandedPitches = [];
  let unparsedSquares = 0;
  for (const row of list) {
    const sq = Number(row?.squares != null ? row.squares : (row?.area_sf != null ? row.area_sf / 100 : NaN));
    if (!Number.isFinite(sq) || sq <= 0) continue;
    const p = pitchOver12(row?.pitch);
    if (p === null) { unparsedSquares += sq; continue; }
    let placed = false;
    for (const bucket of buckets) {
      const lo = bucket.band.min_over_12 != null ? bucket.band.min_over_12 : -Infinity;
      const hi = bucket.band.max_over_12 != null ? bucket.band.max_over_12 : Infinity;
      if (p >= lo && p <= hi) {
        bucket.squares += sq;
        bucket.pitches.push(String(row.pitch));
        placed = true;
        break;
      }
    }
    if (!placed) { unbandedSquares += sq; unbandedPitches.push(String(row.pitch)); }
  }
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    buckets: buckets.filter((b) => b.squares > 0).map((b) => ({ ...b, squares: round2(b.squares) })),
    unbandedSquares: round2(unbandedSquares),
    unbandedPitches,
    unparsedSquares: round2(unparsedSquares),
    usedFallback: !(Array.isArray(bands) && bands.length > 0),
  };
}

// ========== [C2 2026-08-27] CONTRACTOR-VOICE GUARD ==========
// A prior run wrote assistant-authored prose into quotes.message_to_homeowner
// in the contractor's voice -- "Thanks for the opportunity, Mr. Paulsen. Your
// 9/12 pitch puts this in our steep-roof band..." -- and it rendered on
// Exhibit A under the heading "Message from Contractor", inside a document
// presented as a contract exhibit. Mitchel Dotson never wrote a word of it.
//
// Rule (Dustin, 2026-08-27): never synthesize contractor voice. Text that
// renders as a party's own words must trace to a field that party typed.
//
// This is the mechanism, not the rule (R-148 -- a recurring defect closes on a
// mechanism, never on a rule alone):
//   1. ONLY the two contractor-entered columns are read. There is deliberately
//      no fallback to anything derived, generated or summarised.
//   2. A bid carrying is_test = true yields NOTHING unless
//      value_adds.message_contractor_authored is explicitly true. Test and demo
//      bids are exactly where fabricated prose gets introduced, and this is the
//      gate that stops it reaching a signed document.
//   3. Empty or whitespace-only yields null, so the render site omits the whole
//      block rather than printing a heading over nothing.
function contractorAuthoredMessage(bidData) {
  if (!bidData) return null;
  // [2026-08-27] CORRECTION, caught while fixing #1314's phantom-column list:
  // `quotes.message_to_homeowner` and `quotes.contractor_message` DO NOT EXIST.
  // Verified against the live schema -- quotes' full column list has neither.
  // Exhibit A has been reading both, so a real contractor message has never
  // rendered in the "Message from Contractor" block since that block was written.
  //
  // The contractor's message to the homeowner is `quotes.notes`, written from
  // the bid form's `homeownerMessage` input (contractor-bid-form.html:5376).
  // That is the one contractor-typed field, so it is the only one read here.
  // The two dead names are kept as a trailing fallback purely in case a future
  // migration introduces them; they cost nothing and resolve to undefined today.
  const raw = bidData.notes ?? bidData.message_to_homeowner ?? bidData.contractor_message ?? null;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  if (bidData.is_test === true) {
    const va = bidData.value_adds || {};
    if (va.message_contractor_authored !== true) {
      console.warn(
        "[C2] Suppressed message_to_homeowner on test bid " + (bidData.id ?? "?") +
        ": not marked value_adds.message_contractor_authored. Exhibit A will omit " +
        "the 'Message from Contractor' block rather than attribute unverified prose to the contractor."
      );
      return null;
    }
  }
  return text;
}

// ========== [C1 2026-08-27] IC 24-5-11 COMPLIANCE ADDENDUM RETIRED ==========
// generateComplianceAddendumPdf() is DELETED, not disabled. It generated the
// envelope's Document 3: the Statement of Right to Cancel, the full Notice of
// Cancellation form, the IC 24-5-11-12 down-payment cap notice, and the
// PLATFORM DISCLOSURE block.
//
// Dustin's ruling, 2026-08-27, verbatim: "I don't want us adding the right to
// cancel, the notice of cancellation form, the platform disclosure, or the
// down payment cap. We shouldn't be adding terms to their contracts. We
// shouldn't have our name on their contract. But we also aren't taking terms
// out, either."
//
// Every line of that document was OURS -- none of it came from any
// contractor's template. The contractor's own contract keeps whatever
// cancellation terms it carries; we simply stop appending ours to it.
//
// TWO THINGS THAT MOVED RATHER THAN DIED, so nobody re-adds this function:
//  1. The REQUIRED `otterquote_acknowledgment` field now lives at the bottom of
//     the Scope of Work (generateRetailScopeOfWorkPdf, "PLATFORM
//     ACKNOWLEDGMENT"). D-269 (#550) ack-verify.ts is unchanged and still
//     fails closed on that exact field id. To keep it reachable on every
//     envelope, the Scope of Work is now generated for INSURANCE jobs too --
//     it used to be gated on `isRetail`.
//  2. The optional `cancellation_acknowledgment_signature` field is gone with
//     the Notice of Cancellation form it sat on. Nothing verifies it; it was
//     optional by design.
//
// OPERATIONAL CONSEQUENCE, and it belongs to the contractor, not to us: a
// contractor template whose terms cite "the attached Notice of Cancellation"
// (Indy Rooftops' T&C section 11 does) now cites an attachment the envelope no
// longer contains. IC 24-5-11-10 requires that notice be furnished. The fix is
// that the contractor's own template carries his own notice -- which is what
// the #1313 pre-tagged starter PDF should include a slot for.

// ========== HOVER MEASUREMENTS FETCH ==========
async function fetchHoverMeasurements(supabase, claimId) {
  const toNum = (v) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  };
  try {
    // Prefer parsed Hover-PDF measurements persisted on the claim by
    // parse-hover-measurements. These carry the full loss-sheet line-item set
    // consumed by the retail Scope of Work MEASUREMENT SUMMARY + LINE-ITEM table.
    const { data: claimRow } = await supabase.from("claims").select("hover_measurements").eq("id", claimId).maybeSingle();
    const hm = claimRow?.hover_measurements;
    if (hm && typeof hm === "object") {
      const roofAreaSf = toNum(hm.roof_area_sf);
      const dripEdgeLf = toNum(hm.drip_edge_perimeter_lf);
      const squares = toNum(hm.squares) ?? (roofAreaSf != null ? Math.round((roofAreaSf / 100) * 10) / 10 : null);
      const anyRoof = roofAreaSf != null || dripEdgeLf != null || toNum(hm.ridge_hip_lf) != null ||
        toNum(hm.valley_lf) != null || toNum(hm.rake_lf) != null || toNum(hm.eave_lf) != null ||
        toNum(hm.step_flashing_lf) != null || toNum(hm.flashing_lf) != null;
      if (anyRoof || hm.predominant_pitch) {
        return {
          // legacy keys (siding branch + any older consumers)
          roofSqFt: roofAreaSf != null ? Math.round(roofAreaSf) : null,
          wallSqFt: null,
          perimeterFt: dripEdgeLf != null ? Math.round(dripEdgeLf) : null,
          pitch: hm.predominant_pitch ?? null,
          // new normalized roofing superset
          squares,
          roofAreaSf,
          ridgeHipLf: toNum(hm.ridge_hip_lf),
          valleyLf: toNum(hm.valley_lf),
          rakeLf: toNum(hm.rake_lf),
          eaveLf: toNum(hm.eave_lf),
          dripEdgeLf,
          stepFlashingLf: toNum(hm.step_flashing_lf),
          flashingLf: toNum(hm.flashing_lf),
          predominantPitch: hm.predominant_pitch ?? null,
          // [C4 2026-08-27] Per-pitch breakdown, additive and nullable. Absent on
          // every claim measured before parse-hover-measurements started emitting
          // it, and absent for RoofScope reports entirely (image-only PDFs).
          areasByPitch: Array.isArray(hm.areas_by_pitch) ? hm.areas_by_pitch : null
        };
      }
    }
    // Fallback: hover_orders.measurements_json (Hover API shape). The orders
    // table is currently unused (the PDF-parse path above is canonical), but
    // this keeps the API path functional and maps it into the same superset.
    const { data: order } = await supabase.from("hover_orders").select("hover_job_id, measurements_json").eq("claim_id", claimId).eq("status", "complete").order("created_at", {
      ascending: false
    }).limit(1).maybeSingle();
    if (order?.measurements_json) {
      const mj = order.measurements_json;
      const roofSqFtRaw = mj?.structures?.[0]?.areas?.roof ?? mj?.total_sq_ft ?? mj?.total_area_sq_ft ?? mj?.roof_area_sq_ft ?? mj?.measurements?.total_area ?? null;
      const wallSqFtRaw = mj?.structures?.[0]?.areas?.wall ?? mj?.wall_area_sq_ft ?? mj?.measurements?.wall_area ?? null;
      const perimeterFtRaw = mj?.structures?.[0]?.eaves ?? mj?.eaves_length ?? mj?.perimeter_ft ?? mj?.measurements?.perimeter ?? null;
      const pitchRaw = mj?.structures?.[0]?.pitch ?? mj?.primary_pitch ?? mj?.pitch ?? null;
      const ridgeHipRaw = mj?.structures?.[0]?.ridges_hips ?? mj?.ridges_hips ?? mj?.ridge_hip_length ?? null;
      const valleyRaw = mj?.structures?.[0]?.valleys ?? mj?.valleys ?? mj?.valley_length ?? null;
      const rakeRaw = mj?.structures?.[0]?.rakes ?? mj?.rakes ?? mj?.rake_length ?? null;
      const eaveRaw = mj?.structures?.[0]?.eaves ?? mj?.eaves ?? mj?.eave_length ?? null;
      const dripRaw = mj?.structures?.[0]?.drip_edge ?? mj?.drip_edge ?? mj?.drip_edge_length ?? perimeterFtRaw;
      const stepRaw = mj?.structures?.[0]?.step_flashing ?? mj?.step_flashing ?? mj?.step_flashing_length ?? null;
      const flashRaw = mj?.structures?.[0]?.flashing ?? mj?.flashing ?? mj?.flashing_length ?? null;
      if (roofSqFtRaw || wallSqFtRaw || perimeterFtRaw) {
        const roofAreaSf = roofSqFtRaw != null ? Math.round(Number(roofSqFtRaw)) : null;
        return {
          roofSqFt: roofAreaSf,
          wallSqFt: wallSqFtRaw ? Math.round(Number(wallSqFtRaw)) : null,
          perimeterFt: perimeterFtRaw ? Math.round(Number(perimeterFtRaw)) : null,
          pitch: pitchRaw ? String(pitchRaw) : null,
          squares: roofAreaSf != null ? Math.round((roofAreaSf / 100) * 10) / 10 : null,
          roofAreaSf,
          ridgeHipLf: toNum(ridgeHipRaw),
          valleyLf: toNum(valleyRaw),
          rakeLf: toNum(rakeRaw),
          eaveLf: toNum(eaveRaw),
          dripEdgeLf: toNum(dripRaw),
          stepFlashingLf: toNum(stepRaw),
          flashingLf: toNum(flashRaw),
          predominantPitch: pitchRaw ? String(pitchRaw) : null
        };
      }
    }
    return null;
  } catch (err) {
    console.warn("fetchHoverMeasurements: non-fatal error:", err);
    return null;
  }
}

// ========== EXHIBIT A MEASUREMENT SHAPES ==========
// [Part 2 2026-08-28] Dustin's ruling 5, verbatim: "I think we need two exhibit
// A shapes... I think we do Exhibit A on all jobs. But for ACV and RCV jobs, we
// can use the insurance estimate to fill out exhibit A."
//
// The all-jobs half landed in C1 (the isRetail gate came off). This is the
// other half. generateRetailScopeOfWorkPdf assumed exactly ONE measurement
// shape -- a full report carrying linear measurements -- and gated BOTH the
// MEASUREMENT SUMMARY and the entire LINE-ITEM SCOPE table on one
// `hasRoofMeasurements` boolean. A claim with no parsed measurements therefore
// shipped an Exhibit A with a header, a disclaimer, some bid selections and no
// body at all, and nothing in the document said why.
//
// FOUR shapes, resolved from what is actually ON THE CLAIM rather than from a
// vendor or product label we may not have:
//
//   full      Full RoofScope, or a Hover report. Carries linear measurements.
//             MEASUREMENT SUMMARY + the full band-expanded LINE-ITEM SCOPE.
//   basic     RoofScope X ($15 to the homeowner, $11 vendor cost; a contractor
//             who wants the full report buys it himself). VERIFIED against a
//             real report: it carries the complete per-pitch area table and
//             total squares, and NO linear measurements whatsoever -- no eave,
//             rake, ridge, hip, valley, step or headwall flashing. Rows 4-10 of
//             the line-item table every one depend on LF and cannot be built.
//   insurance ACV/RCV. parse-loss-sheet has ALREADY written
//             claims.parsed_line_items (sectioned line items),
//             contractor_scope_summary, rcv_amount, acv_amount and
//             deductible_amount. No new parser is needed; the insurer's own
//             scope is the line-item basis.
//   none      No measurement report on file. The document says so, explicitly.
//
// The measurement shape and the line-item basis are resolved SEPARATELY and
// deliberately. An insurance job can also carry a full RoofScope; when it does
// both facts are true and both render -- the measured roof under MEASUREMENT
// SUMMARY, the insurer's scope as the priced basis. One flat enum would have
// thrown away whichever of the two arrived second.
//
// Detection is by CONTENT, not by product code. hover_orders.product_code
// exists (gh-1245: roof_basic == RoofScope X) but the PDF-parse path is the
// canonical one today and writes no product code at all, so keying off it would
// mis-shape every claim measured through the path we actually use.
function resolveMeasurementShape(measurements: any) {
  const m = measurements || {};
  const LINEAR = ["ridgeHipLf", "valleyLf", "rakeLf", "eaveLf", "dripEdgeLf", "stepFlashingLf", "flashingLf"];
  if (LINEAR.some((k) => m[k] != null)) return "full";
  const hasArea = m.roofAreaSf != null || m.squares != null ||
    (Array.isArray(m.areasByPitch) && m.areasByPitch.length > 0);
  return hasArea ? "basic" : "none";
}

// Flatten the insurer's parsed estimate (the parse-loss-sheet shape on
// claims.parsed_line_items) into display rows. Returns null when nothing was
// parsed, so the caller can distinguish "no loss sheet" from "an empty one".
//
// parse-loss-sheet strips PII at extraction time (its prompt names insured
// name, address, policy and claim numbers, adjuster contact -- all excluded),
// so nothing read here needs a second redaction pass. Unit prices ARE present
// in the parsed data and are deliberately NOT rendered: the insurer's unit
// price is not the contract price, and putting the two on one page invites
// them to be read as the same number.
function insurerScopeRows(insurance: any) {
  const parsed = insurance?.parsedLineItems;
  const sections = Array.isArray(parsed?.sections) ? parsed.sections : [];
  const rows = [];
  for (const section of sections) {
    const label = [section?.section_name || section?.name, section?.area_name].filter(Boolean).join(" - ");
    const items = section?.line_items || section?.items || [];
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (!it || !it.description) continue;
      rows.push({
        section: label || "",
        description: String(it.description),
        quantity: it.quantity != null ? String(it.quantity) : "per estimate",
        unit: it.unit ? String(it.unit) : "",
        notes: it.notes ? String(it.notes) : "",
      });
    }
  }
  return rows.length ? rows : null;
}

// ========== RETAIL SCOPE OF WORK PDF ==========
function generateRetailScopeOfWorkPdf(params) {
  const { homeownerName, contractorName, propertyAddress, claimId, trades, contractPrice, estimatedStartDate, valueAdds, bidBrand, deckingPricePerSheet, fullRedeckPrice, messageToHomeowner, homeownerNotes, projectConfirmation, measurements, contractDate, fundingType, pitchBands, twoStoryAdder, insurance, warrantySnapshot, workmanshipWarrantyYears } = params;
  const va = valueAdds || {};
  const pc = projectConfirmation || null;
  // ---- Page geometry ----
  const PAGE_W = 612, PAGE_H = 792;
  const TOP_Y = 750, BOTTOM_Y = 70;
  const LEFT_X = 50, RIGHT_X = 562;
  // ---- Multi-page content buffers. Each page is its own content-stream line
  // array; when the cursor `y` would drop below BOTTOM_Y we finalize the current
  // page and start a fresh one with a light "SCOPE OF WORK (cont.)" header. ----
  const pages = [];
  let contentLines = [];
  let y = TOP_Y;
  function esc(text) {
    let s = String(text == null ? "" : text);
    // Fold common non-ASCII punctuation to ASCII so the content stream stays
    // single-byte — this keeps the hand-rolled xref byte-offsets and the
    // stream /Length values byte-accurate (a stray em-dash/superscript would
    // otherwise be multi-byte under UTF-8 and corrupt the offsets).
    s = s
      .replace(/[‐-―]/g, "-")
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/…/g, "...")
      .replace(/²/g, "2")
      .replace(/½/g, "1/2").replace(/¼/g, "1/4").replace(/¾/g, "3/4")
      // [Part 2 2026-08-28] Was a regex literal matching the non-breaking space
      // by its backslash-u escape. Rewritten to carry
      // NO backslash-u escape sequence at all, because the MCP tool-call
      // transport that lands changes in this repo REWRITES those sequences:
      // a real U+00A0 sent as an argument arrives as a plain space, and the six
      // characters of the escape arrive as a real U+00A0. That hazard cost two
      // silently-corrupted landings on 2026-08-27 (In Flight/reports/
      // int-mcp-unicode-escape-transport-20260827.md) and this line was one of
      // the two sites. String.fromCharCode(160) is the same character, is pure
      // ASCII in source, and cannot be rewritten in transit.
      .replace(new RegExp(String.fromCharCode(160), "g"), " ");
    // Literal space-to-tilde range rather than the backslash-x escapes it used
    // to carry, for the same transport reason as the line above: the escape
    // form is rewritable in transit, the literal characters are not. Same
    // range, same behaviour -- drop anything outside printable ASCII.
    s = s.replace(/[^ -~]/g, "");
    return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  }
  function addText(x, yy, fontSize, font, text) {
    contentLines.push(`BT /${font} ${fontSize} Tf ${x} ${yy} Td (${esc(text)}) Tj ET`);
  }
  // [D-225 Phase 2B / D-186; re-tagged D-274 / #631] Render text in a chosen
  // non-stroking gray (1.0 = white = invisible on white paper). Used to embed
  // BoldSign Text Tags invisibly (was DocuSign anchor strings pre-D-274).
  function addTextColored(x, yy, fontSize, font, text, gray) {
    contentLines.push(`BT ${gray} g /${font} ${fontSize} Tf ${x} ${yy} Td (${esc(text)}) Tj ET 0 g`);
  }
  function hLine(yy) {
    contentLines.push(`${LEFT_X} ${yy} m ${RIGHT_X} ${yy} l S`);
  }
  // Finalize the current page and open a new one with a continuation header.
  // Returns the new cursor y (also assigned to the closure `y`).
  function pageBreak() {
    pages.push(contentLines);
    contentLines = [];
    let yy = TOP_Y;
    addText(LEFT_X, yy, 12, "F2", "SCOPE OF WORK (cont.)");
    yy -= 14;
    hLine(yy);
    yy -= 16;
    y = yy;
    return yy;
  }
  // Page-break if fewer than `need` vertical points remain before the bottom margin.
  function ensure(need) {
    if (y - need < BOTTOM_Y) { y = pageBreak(); }
  }
  function addWrappedText(x, startY, fontSize, font, text, maxWidth) {
    const charWidth = fontSize * 0.5;
    const maxChars = Math.max(1, Math.floor(maxWidth / charWidth));
    const words = String(text || "").split(" ");
    let line = "";
    let yy = startY;
    const ls = fontSize * 1.4;
    const flush = () => {
      if (yy - ls < BOTTOM_Y) { yy = pageBreak(); }
      addText(x, yy, fontSize, font, line.trim());
      yy -= ls;
    };
    for (const word of words) {
      if (line.length + word.length + 1 > maxChars) { flush(); line = word + " "; }
      else { line += word + " "; }
    }
    if (line.trim()) { flush(); }
    y = yy;
    return yy;
  }
  // Word-wrap helper that returns the wrapped lines (used for table cells).
  function wrapToLines(text, maxChars) {
    const words = String(text == null ? "" : text).split(" ");
    const out = [];
    let line = "";
    for (const word of words) {
      if (line.length + word.length + 1 > maxChars) {
        if (line.trim()) out.push(line.trim());
        line = word + " ";
      } else { line += word + " "; }
    }
    if (line.trim()) out.push(line.trim());
    return out.length ? out : [""];
  }
  function fmt$(val) {
    if (val == null) return "TBD";
    return "$" + Number(val).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // ===== PAGE 1 HEADER =====
  addText(LEFT_X, y, 16, "F2", "SCOPE OF WORK");
  y -= 18;
  // [C1 2026-08-27, Dustin-directed, verbatim: "Prepared by Otter Quotes on
  // behalf of [homeowner] for the purpose of obtaining competitive bids".
  // Attribution is to the HOMEOWNER, not the contractor: this document is
  // prepared for the homeowner to solicit competitive bids, which is also what
  // preserves the contractor's ability to dispute measurements he did not take
  // (see the MEASUREMENT DISCLAIMER below). Previously read "on behalf of
  // ${contractorName}". Wrapped rather than single-line because a long
  // homeowner name overflows 512pt at 9pt.
  y = addWrappedText(LEFT_X, y, 9, "F1", `Prepared by Otter Quotes on behalf of ${homeownerName} for the purpose of obtaining competitive bids`, 512);
  y -= 2;
  hLine(y);
  y -= 16;
  addText(LEFT_X, y, 10, "F2", "PROJECT:");
  addText(160, y, 10, "F1", propertyAddress);
  y -= 14;
  addText(LEFT_X, y, 10, "F2", "HOMEOWNER:");
  addText(160, y, 10, "F1", homeownerName);
  y -= 14;
  addText(LEFT_X, y, 10, "F2", "CONTRACTOR:");
  addText(160, y, 10, "F1", contractorName);
  y -= 14;
  addText(LEFT_X, y, 10, "F2", "DATE:");
  addText(160, y, 10, "F1", contractDate);
  y -= 14;
  addText(LEFT_X, y, 10, "F2", "JOB REF:");
  addText(160, y, 10, "F1", claimId.slice(-8).toUpperCase());
  y -= 20;
  hLine(y);
  y -= 16;
  addText(LEFT_X, y, 12, "F2", "CONTRACT SUMMARY");
  y -= 16;
  const tradeLabel = (trades || []).map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(", ") || "See below";
  addText(LEFT_X, y, 10, "F2", "Trade(s):");
  addText(160, y, 10, "F1", tradeLabel);
  y -= 14;
  addText(LEFT_X, y, 10, "F2", "Financing:");
  // [C1 2026-08-27] Was hardcoded "Retail / Homeowner-Financed" because this
  // document only ever rendered on retail jobs. Dustin ruled Exhibit A renders
  // on ALL jobs, so an insurance-funded claim would otherwise carry a false
  // statement about how it is paid for.
  addText(160, y, 10, "F1", fundingType === "insurance" ? "Insurance-Funded (ACV / RCV)" : "Retail / Homeowner-Financed");
  y -= 14;
  addText(LEFT_X, y, 10, "F2", "Contract Price:");
  addText(160, y, 10, "F1", contractPrice ? fmt$(contractPrice) : "Per contractor agreement");
  y -= 14;
  addText(LEFT_X, y, 10, "F2", "Est. Start:");
  addText(160, y, 10, "F1", estimatedStartDate || "To be scheduled");
  y -= 20;
  hLine(y);
  y -= 16;
  // D-186/D-203 — Verbatim measurement disclaimer (required at top of every retail Exhibit A).
  addText(LEFT_X, y, 10, "F2", "MEASUREMENT DISCLAIMER");
  y -= 14;
  y = addWrappedText(LEFT_X, y, 9, "F1", "The measurements contained in this Statement of Work were provided to Contractor on behalf of Customer. Both parties have relied upon the accuracy of this information in negotiating the terms of this Agreement. Prior to starting the work set forth in this agreement, either party shall have the right to perform his or her own measurements to verify the measurements contained herein. If any measurement in this statement of work is off by more than 10%, either party shall have the right to: (1) negotiate a change order to adjust the compensation due under the Agreement; (2) cancel the Agreement; or (3) proceed under the terms set forth in the Agreement.", 512);
  y -= 12;
  hLine(y);
  y -= 16;
  const hasRoofing = (trades || []).some((t) => t.toLowerCase().includes("roof"));
  const hasSiding = (trades || []).some((t) => t.toLowerCase().includes("siding"));
  const hasGutters = (trades || []).some((t) => t.toLowerCase().includes("gutter"));
  const hasWindows = (trades || []).some((t) => t.toLowerCase().includes("window"));
  // ===== MEASUREMENT SUMMARY + LINE-ITEM SCOPE =====
  // [Part 2 2026-08-28] Restructured into the four shapes resolved by
  // resolveMeasurementShape(). See the tombstone above that function for why.
  // Previously this whole region was gated on a single `hasRoofMeasurements`
  // boolean, so a claim with no parsed measurements shipped an Exhibit A with a
  // header, a disclaimer, some bid selections and NO BODY AT ALL -- and nothing
  // in the document said why.
  const m = measurements || {};
  const r0 = (n) => (n == null || Number.isNaN(Number(n))) ? null : Math.round(Number(n));
  const sq = (m.squares != null && !Number.isNaN(Number(m.squares)))
    ? Number(m.squares)
    : (m.roofAreaSf != null ? Math.round((Number(m.roofAreaSf) / 100) * 10) / 10 : null);
  const roofAreaSf = (m.roofAreaSf != null) ? Number(m.roofAreaSf) : (sq != null ? Math.round(sq * 100) : null);
  const rh = r0(m.ridgeHipLf), vv = r0(m.valleyLf), rk = r0(m.rakeLf), ev = r0(m.eaveLf),
        drip = r0(m.dripEdgeLf), st = r0(m.stepFlashingLf), fl = r0(m.flashingLf);

  const measurementShape = resolveMeasurementShape(m);
  const ins = insurance || null;
  const insRows = insurerScopeRows(ins);
  const hasInsurerBasis = !!(insRows || (ins && (ins.rcv != null || ins.acv != null || ins.deductible != null || ins.scopeSummary)));
  // The insurer's own estimate is the priced basis whenever one has been
  // parsed -- Dustin, verbatim: "for ACV and RCV jobs, we can use the insurance
  // estimate to fill out exhibit A." Otherwise the basis is derived from the
  // measurement report, and with neither there is no basis at all.
  const lineItemBasis = insRows ? "insurer" : (measurementShape === "none" ? "none" : "derived");

  // ---- Shared table helpers (used by both the derived and insurer tables) ----
  // Height of a block of wrapped prose at a given font size. Exists so a
  // table's OPENING BLOCK -- heading, caption, any explanatory note, the column
  // header and the first data row -- can be budgeted as one unit before any of
  // it is drawn. A section that budgets only its heading leaves the heading, or
  // worse a bare column-header row, orphaned at the foot of a page and reprints
  // it overleaf. C4e fixed exactly this for the contingencies heading; the two
  // line-item tables still had it, and the `basic` shape (whose opening block
  // carries a four-line note) hit it on the very first render.
  //
  // The arithmetic mirrors addWrappedText's, which is the function that will
  // actually lay the prose out. If one changes, change both.
  const proseHeight = (text: string, fontSize: number, maxWidth: number) => {
    const maxChars = Math.max(1, Math.floor(maxWidth / (fontSize * 0.5)));
    return wrapToLines(text, maxChars).length * (fontSize * 1.4);
  };
  const firstRowHeight = (cols: any[], rowsIn: any[]) => {
    if (!rowsIn.length) return 0;
    return Math.max(1, ...cols.map((c: any) => wrapToLines(rowsIn[0][c.key], c.chars).length)) * 10 + 2;
  };
  const drawRows = (cols: any[], rowsIn: any[], header: () => void) => {
    const lineH = 10;
    header();
    for (const row of rowsIn) {
      const cells = cols.map((c: any) => wrapToLines(row[c.key], c.chars));
      const nLines = Math.max(1, ...cells.map((c: any) => c.length));
      const rowH = nLines * lineH + 2;
      const pagesBefore = pages.length;
      ensure(rowH);
      if (pages.length > pagesBefore) { header(); }
      const topY = y;
      cells.forEach((lines: any[], ci: number) => lines.forEach((ln: string, k: number) => addText(cols[ci].x, topY - k * lineH, 8, "F1", ln)));
      y = topY - rowH;
    }
    y -= 4;
    hLine(y);
    y -= 16;
  };

  // ================= A. MEASUREMENT SUMMARY =================
  if (hasRoofing) {
    if (measurementShape === "full" || measurementShape === "basic") {
      ensure(34);
      // [C4 2026-08-27] De-branded. The measurement report OtterQuote actually
      // buys is RoofScope / RoofScope X (gh-1245 catalog: roof_basic is
      // RoofScopeX), not Hover, and naming the wrong vendor on a contract
      // exhibit is a statement about where the numbers came from.
      addText(LEFT_X, y, 12, "F2", "MEASUREMENT SUMMARY");
      y -= 16;
      const sumRow = (label, value) => {
        if (value == null || value === "") return;
        ensure(13);
        addText(LEFT_X, y, 10, "F2", label);
        addText(250, y, 10, "F1", value);
        y -= 13;
      };
      const areaVal = roofAreaSf != null
        ? `${roofAreaSf.toLocaleString("en-US")} sf${sq != null ? ` (${sq} SQ)` : ""}`
        : (sq != null ? `${sq} SQ` : null);
      sumRow("Roof area:", areaVal);
      if (measurementShape === "full") {
        sumRow("Ridges / Hips:", m.ridgeHipLf != null ? `${m.ridgeHipLf} LF` : null);
        sumRow("Valleys:", m.valleyLf != null ? `${m.valleyLf} LF` : null);
        sumRow("Eaves:", m.eaveLf != null ? `${m.eaveLf} LF` : null);
        sumRow("Rakes:", m.rakeLf != null ? `${m.rakeLf} LF` : null);
        sumRow("Drip edge / perimeter:", m.dripEdgeLf != null ? `${m.dripEdgeLf} LF` : null);
        sumRow("Step flashing:", m.stepFlashingLf != null ? `${m.stepFlashingLf} LF` : null);
        sumRow("Headwall / apron flashing:", m.flashingLf != null ? `${m.flashingLf} LF` : null);
      }
      sumRow("Predominant pitch:", m.predominantPitch || null);
      // Per-pitch area table. On a BASIC report this is the whole of the
      // measurement content, so it is rendered as a table rather than folded
      // into the line items. On a FULL report it is supplementary and the
      // slope breakout in the line-item table carries it, so it is skipped
      // there to avoid stating the same numbers twice on one page.
      if (measurementShape === "basic" && Array.isArray(m.areasByPitch) && m.areasByPitch.length > 0) {
        y -= 4;
        ensure(30);
        addText(LEFT_X, y, 10, "F2", "Area by pitch");
        y -= 12;
        const pitchRows = m.areasByPitch
          .map((row: any) => {
            const rowSq = Number(row?.squares != null ? row.squares : (row?.area_sf != null ? row.area_sf / 100 : NaN));
            if (!Number.isFinite(rowSq) || rowSq <= 0) return null;
            const pctNum = (sq != null && sq > 0) ? Math.round((rowSq / sq) * 100) : null;
            return {
              pitch: String(row?.pitch ?? "unstated"),
              squares: `${Math.round(rowSq * 100) / 100} SQ`,
              pct: pctNum != null ? `${pctNum}%` : "",
            };
          })
          .filter(Boolean);
        const pitchCols = [
          { key: "pitch", x: 66, chars: 20 },
          { key: "squares", x: 200, chars: 16 },
          { key: "pct", x: 290, chars: 8 },
        ];
        drawRows(pitchCols, pitchRows, () => {
          ensure(18);
          addText(66, y, 8, "F2", "Pitch");
          addText(200, y, 8, "F2", "Area");
          addText(290, y, 8, "F2", "Share");
          y -= 3; hLine(y); y -= 11;
        });
      } else {
        y -= 6;
        hLine(y);
        y -= 16;
      }
      if (measurementShape === "basic") {
        // Say exactly what this report does and does not carry. A homeowner
        // comparing two Exhibit As should not have to guess why one has eight
        // measurement rows and the other has one.
        ensure(26);
        y = addWrappedText(LEFT_X, y, 8, "F1", "The measurement report on file is a basic roof report. It carries roof area and the area of each pitch, and it carries NO linear measurements - no eave, rake, ridge, hip, valley, step flashing or headwall flashing lengths. The work items that depend on those lengths therefore cannot be quantified from it; they are named in full beneath the line-item scope below and are field-verified on site.", 512);
        y -= 8;
        hLine(y);
        y -= 16;
      }
    } else {
      // ---- measurementShape === "none" ----
      // The whole point of this branch: say it out loud. The prior behaviour
      // was to render nothing, which is indistinguishable from a roof with no
      // work on it.
      ensure(40);
      addText(LEFT_X, y, 12, "F2", "MEASUREMENT SUMMARY");
      y -= 14;
      y = addWrappedText(LEFT_X, y, 9, "F1", hasInsurerBasis
        ? "No measurement report is on file for this property. The scope below is taken from the insurance estimate rather than from an aerial measurement report; quantities are the insurer's, and all of them are subject to field verification before work begins."
        : "No measurement report is on file for this property. No aerial or field measurements were available when this document was prepared, so no measured quantities and no line-item scope can be stated. Every quantity for this job is to be field-verified, and the MEASUREMENT DISCLAIMER above governs any measurement either party later takes.", 512);
      y -= 8;
      hLine(y);
      y -= 16;
    }
  }

  // ================= B. INSURANCE SETTLEMENT BASIS =================
  // Rendered for any trade, not only roofing: an insurance siding job has a
  // loss sheet too. parse-loss-sheet has already stripped PII from
  // claims.parsed_line_items, so nothing here needs redaction.
  if (hasInsurerBasis) {
    ensure(40);
    addText(LEFT_X, y, 12, "F2", "INSURANCE SETTLEMENT BASIS");
    y -= 8;
    addText(LEFT_X, y, 8, "F1", "From the carrier's own estimate on file. These are the insurer's figures, not the contract price.");
    y -= 14;
    const insRow = (label: string, value: any) => {
      if (value == null || value === "") return;
      ensure(13);
      addText(LEFT_X, y, 10, "F2", label);
      addText(250, y, 10, "F1", value);
      y -= 13;
    };
    insRow("Carrier:", ins?.carrier || null);
    // The raw enum from parse-loss-sheet ("xactimate" | "corelogic_itel" |
    // "carrier_proprietary" | "unknown"). Printing it raw put a lowercase
    // machine token on a contract exhibit.
    const FORMAT_LABELS: Record<string, string> = {
      xactimate: "Xactimate",
      corelogic_itel: "CoreLogic / ITEL",
      carrier_proprietary: "Carrier proprietary",
    };
    insRow("Estimate format:", ins?.format ? (FORMAT_LABELS[String(ins.format)] || null) : null);
    insRow("Pricing basis:", ins?.pricingDatabase || null);
    insRow("Replacement cost value (RCV):", ins?.rcv != null ? fmt$(ins.rcv) : null);
    insRow("Actual cash value (ACV):", ins?.acv != null ? fmt$(ins.acv) : null);
    insRow("Deductible:", ins?.deductible != null ? fmt$(ins.deductible) : null);
    y -= 6;
    hLine(y);
    y -= 16;
  }

  // ================= C. LINE-ITEM SCOPE =================
  if (lineItemBasis === "insurer") {
    const insCaption = "Quantities taken from the insurance estimate on file. Unit pricing is omitted: the insurer's unit prices are not the contract price and stating them here would invite the two to be read as the same number.";
    const insCols = [
      { key: "num", x: 50, chars: 4 },
      { key: "description", x: 66, chars: 40 },
      { key: "quantity", x: 262, chars: 12 },
      { key: "unit", x: 312, chars: 8 },
      { key: "section", x: 352, chars: 24 },
      { key: "notes", x: 470, chars: 22 },
    ];
    const numbered = (insRows || []).map((r: any, i: number) => ({ ...r, num: String(i + 1) }));
    ensure(22 + proseHeight(insCaption, 8, 512) + 24 + firstRowHeight(insCols, numbered));
    addText(LEFT_X, y, 12, "F2", "LINE-ITEM SCOPE");
    y -= 8;
    y = addWrappedText(LEFT_X, y, 8, "F1", insCaption, 512);
    y -= 6;
    drawRows(insCols, numbered, () => {
      ensure(18);
      addText(50, y, 8, "F2", "#");
      addText(66, y, 8, "F2", "Work Item (insurer)");
      addText(262, y, 8, "F2", "Qty");
      addText(312, y, 8, "F2", "Unit");
      addText(352, y, 8, "F2", "Estimate Section");
      addText(470, y, 8, "F2", "Notes");
      y -= 3; hLine(y); y -= 11;
    });
  } else if (hasRoofing && lineItemBasis === "derived") {
    // ---- LINE-ITEM SCOPE table (quantities only; no unit prices) ----
    // NOTHING is drawn until the rows are built, because the opening block's
    // height depends on which notes this shape emits -- see the single ensure()
    // below.
    const colNum = 50, colItem = 66, colQty = 246, colUnit = 286, colBasis = 330, colNotes = 448;
    // [C4 2026-08-27] basisMaxChars added. Basis was the one cell rendered with
    // a bare addText and no wrap, which was invisible while every basis string
    // was short ("Roof area +10%") and became a collision the moment the slope
    // breakout started emitting "16.14 SQ +10% (1/12-5/12)". 8pt Helvetica at
    // ~0.5em/char over the 118pt between colBasis and colNotes.
    const itemMaxChars = 44, notesMaxChars = 28, basisMaxChars = 28;
    const drawTableHeader = () => {
      ensure(18);
      addText(colNum, y, 8, "F2", "#");
      addText(colItem, y, 8, "F2", "Work Item");
      addText(colQty, y, 8, "F2", "Qty");
      addText(colUnit, y, 8, "F2", "Unit");
      addText(colBasis, y, 8, "F2", "Basis");
      addText(colNotes, y, 8, "F2", "Notes");
      y -= 3;
      hLine(y);
      y -= 11;
    };
    const qtyStr = (val) => (val == null ? "per bid" : String(val));
    const areaWaste = (sq != null) ? Math.ceil(sq * 1.1) : null; // area items + 10% waste (SQ)
    const iceWater = (vv != null && ev != null) ? (vv + ev) : null;   // valleys + eaves
    const starter = (ev != null && rk != null) ? (ev + rk) : null;    // eaves + rakes
    // [C4 2026-08-27] Rows 1-3 break out by slope band when the measurement
    // report carried a per-pitch table; otherwise they stay as the single lump
    // "Roof area +10%" row they have always been.
    //
    // The fallback is deliberate and is the whole point of C4 step 4: with no
    // per-pitch table, apportioning the roof by the PREDOMINANT pitch would be
    // fabricating a slope split on a priced line item, which is worse than one
    // honest lump row. We degrade and say why rather than invent.
    const bandSplit = (m.areasByPitch && m.areasByPitch.length > 0)
      ? bucketByBands(m.areasByPitch, pitchBands)
      : null;
    const useBandRows = !!(bandSplit && (bandSplit.buckets.length > 1 || bandSplit.unbandedSquares > 0));
    const areaRows = [
      { label: "Tear off & dispose existing roofing (all layers)", notes: "Haul-off included" },
      { label: `Architectural laminate shingles - ${bidBrand || "per bid"}`, notes: "Per mfr. spec" },
      { label: "Synthetic underlayment", notes: "Full coverage" },
    ];
    const rows = [];
    let rowNum = 0;
    if (useBandRows) {
      const w = (s) => Math.ceil(s * 1.1);
      for (const ar of areaRows) {
        for (const b of bandSplit.buckets) {
          rows.push({
            num: ++rowNum,
            item: `${ar.label} - ${b.band.label}`,
            qty: String(w(b.squares)),
            unit: "SQ",
            basis: `${b.squares} SQ +10% (${pitchRangeLabel(b.pitches)})`,
            notes: ar.notes,
          });
        }
        if (bandSplit.unbandedSquares > 0) {
          rows.push({
            num: ++rowNum,
            item: `${ar.label} - above priced slope bands`,
            qty: String(w(bandSplit.unbandedSquares)),
            unit: "SQ",
            basis: `${bandSplit.unbandedSquares} SQ +10% (${pitchRangeLabel(bandSplit.unbandedPitches)})`,
            notes: "Quote required - see Contingencies",
          });
        }
      }
    } else {
      for (const ar of areaRows) {
        rows.push({ num: ++rowNum, item: ar.label, qty: qtyStr(areaWaste), unit: "SQ", basis: "Roof area +10%", notes: ar.notes });
      }
    }
    // [Part 2 2026-08-28] The seven LF-driven rows are built ONLY on a `full`
    // report. A basic report (RoofScope X) carries no linear measurements at
    // all, so every one of them would render "per bid / ?" -- seven rows of
    // question marks on a contract exhibit, which reads as a defect rather than
    // as an honest absence. They are replaced by one sentence that says so.
    if (measurementShape === "full") {
      rows.push(
        { num: ++rowNum, item: "Ice & water shield - valleys + eaves", qty: qtyStr(iceWater), unit: "LF", basis: `Valleys ${vv != null ? vv : "?"} + eaves ${ev != null ? ev : "?"}`, notes: "Code / leak-prone areas" },
        { num: ++rowNum, item: "Starter course", qty: qtyStr(starter), unit: "LF", basis: `Eaves ${ev != null ? ev : "?"} + rakes ${rk != null ? rk : "?"}`, notes: "Eaves & rakes" },
        { num: ++rowNum, item: "Hip & ridge cap shingles", qty: qtyStr(rh), unit: "LF", basis: `Ridges/Hips ${rh != null ? rh : "?"}`, notes: "Matching profile" },
        { num: ++rowNum, item: "Drip edge", qty: qtyStr(drip), unit: "LF", basis: `Perimeter ${drip != null ? drip : "?"}`, notes: "Eaves & rakes" },
        { num: ++rowNum, item: "Closed-cut valley", qty: qtyStr(vv), unit: "LF", basis: `Valleys ${vv != null ? vv : "?"}`, notes: "Per mfr." },
        { num: ++rowNum, item: "Step flashing (roof-to-wall)", qty: qtyStr(st), unit: "LF", basis: `Step flashing ${st != null ? st : "?"}`, notes: "Replace" },
        { num: ++rowNum, item: "Headwall / apron flashing", qty: qtyStr(fl), unit: "LF", basis: `Flashing ${fl != null ? fl : "?"}`, notes: "Replace" },
      );
    }
    rows.push(
      { num: ++rowNum, item: "Pipe boots / penetration flashings", qty: "field", unit: "EA", basis: "Field-verified", notes: "Count confirmed on site" },
      { num: ++rowNum, item: "Roof/exhaust vents", qty: "field", unit: "EA", basis: "Field-verified", notes: "Reset or replace" },
      // [C3 2026-08-27] Rates removed -- decking and full re-deck are stated once,
      // in CONTINGENCIES AND CONDITIONAL PRICING, each beside its trigger.
      { num: ++rowNum, item: "Decking replacement allowance", qty: "as req'd", unit: "SHEET", basis: "-", notes: "See Contingencies" },
    );
    const derivedCols = [
      { key: "num", x: colNum, chars: 4 },
      { key: "item", x: colItem, chars: itemMaxChars },
      // qty and unit are wide enough to hold their longest real value on one
      // line ("as req'd", "SHEET"). Before Part 2 they were drawn with a bare
      // addText and never wrapped; routing them through the shared drawRows
      // wrapper reintroduced wrapping, and "as req'd" split across two lines on
      // the first render. Caught by reading the PDF, not the code.
      { key: "qty", x: colQty, chars: 12 },
      { key: "unit", x: colUnit, chars: 8 },
      { key: "basis", x: colBasis, chars: basisMaxChars },
      { key: "notes", x: colNotes, chars: notesMaxChars },
    ];
    const derivedRows = rows.map((r: any) => ({ ...r, num: String(r.num) }));
    const caption = "Quantities derived from the aerial measurement report on file. Field-verified items confirmed on site. No unit pricing shown.";
    // Say WHY the scope is one lump row instead of a slope breakout, rather
    // than leaving the reader to assume the roof is a single pitch.
    const slopeNote = useBandRows ? null : (m.areasByPitch
      ? "Slope breakout unavailable: the measurement report's pitch table did not resolve into priced bands."
      : "Slope breakout unavailable: the measurement report on file carries no per-pitch area table.");
    // [Part 2 2026-08-28] On a `basic` report the seven LF-driven rows are not
    // in the table at all. Name them, so their absence reads as a stated fact
    // rather than as an omission -- and say it BELOW the table it refers to,
    // which is where the reader is when the question occurs to them.
    const basicNote = measurementShape === "basic"
      ? "Not itemised above, because the basic measurement report carries no linear measurements: ice & water shield, starter course, hip & ridge cap, drip edge, valley, step flashing and headwall / apron flashing. All seven are included in the work and their quantities are field-verified on site before installation."
      : null;
    ensure(22 + proseHeight(caption, 8, 512) + (slopeNote ? 12 : 0) + 24 + firstRowHeight(derivedCols, derivedRows));
    addText(LEFT_X, y, 12, "F2", "LINE-ITEM SCOPE");
    y -= 8;
    y = addWrappedText(LEFT_X, y, 8, "F1", caption, 512);
    y -= 4;
    if (slopeNote) {
      addText(LEFT_X, y, 8, "F1", slopeNote);
      y -= 12;
    }
    drawRows(derivedCols, derivedRows, drawTableHeader);
    if (basicNote) {
      ensure(proseHeight(basicNote, 8, 512) + 8);
      y = addWrappedText(LEFT_X, y, 8, "F1", basicNote, 512);
      y -= 10;
    }
  }
  // ===== SCOPE OF WORK DETAILS (selections from the contractor bid) =====
  ensure(30);
  addText(LEFT_X, y, 12, "F2", "SCOPE OF WORK DETAILS");
  y -= 16;
  if (hasRoofing) {
    ensure(20);
    addText(LEFT_X, y, 11, "F2", "ROOFING");
    y -= 14;
    if (bidBrand) {
      ensure(14);
      addText(60, y, 10, "F2", "Materials:");
      addText(160, y, 10, "F1", bidBrand);
      y -= 14;
    }
    if (pc?.shingleManufacturer || pc?.shingleColor) {
      const shingleStr = [pc.shingleManufacturer, pc.shingleColor].filter(Boolean).join(" - ");
      ensure(14);
      addText(60, y, 10, "F2", "Shingle:");
      addText(160, y, 10, "F1", shingleStr);
      y -= 14;
    }
    if (pc?.dripEdgeColor) {
      ensure(14);
      addText(60, y, 10, "F2", "Drip Edge Color:");
      addText(160, y, 10, "F1", pc.dripEdgeColor);
      y -= 14;
    }
    if (va.underlayment?.type) {
      ensure(14);
      addText(60, y, 10, "F2", "Underlayment:");
      addText(160, y, 10, "F1", va.underlayment.type === "synthetic" ? "Synthetic" : "Felt");
      y -= 14;
    }
    if (va.starter_strip) {
      const ssMap = { rakes: "Rakes only", eaves: "Eaves only", rakes_and_eaves: "Rakes and Eaves", neither: "None" };
      ensure(14);
      addText(60, y, 10, "F2", "Starter Strip:");
      addText(160, y, 10, "F1", ssMap[va.starter_strip] || String(va.starter_strip));
      y -= 14;
    }
    if (va.ventilation) {
      // [C3 2026-08-27] Price removed -- the OOP amount is a contingency and is
      // stated once, in CONTINGENCIES AND CONDITIONAL PRICING.
      const ventDesc = va.ventilation.ridge_vent_included ? "Ridge Vent - Included" : va.ventilation.ridge_vent_oop ? "Ridge Vent - homeowner out-of-pocket, see Contingencies" : null;
      if (ventDesc) {
        ensure(14);
        addText(60, y, 10, "F2", "Ventilation:");
        addText(160, y, 10, "F1", ventDesc);
        y -= 14;
      }
    }
    // [C3 2026-08-27] The decking rate moved to CONTINGENCIES AND CONDITIONAL
    // PRICING. This block describes what IS included; a per-sheet rate that
    // only applies if deteriorated decking is found is a contingency, and
    // Dustin's instruction was that every price-changing condition live in one
    // section with its trigger beside it.
    // [C3 2026-08-27] BUG FIX, verified against contractor-bid-form.html:5254.
    // This read `va.chimney_flashing`, which the bid form sets to a literal
    // `null` and labels `deprecated -- replaced by chimney (86e10t28v)`. So the
    // chimney line has rendered NOTHING for every bid submitted since that
    // rename. The live shape is `va.chimney` = { type, option, oop_price }.
    // Legacy shapes are still read so historical bids keep rendering.
    const chim = va.chimney ?? va.chimney_flashing ?? va.chimney_reflash ?? null;
    const chimOption = chim?.option && chim.option !== "na" ? String(chim.option) : null;
    if (chimOption) {
      const cfMap = { reuse: "Reuse existing", replace: "Replace - Included", included: "Included", oop: "Homeowner out-of-pocket option - see Contingencies", replace_oop: "Homeowner out-of-pocket option - see Contingencies" };
      ensure(14);
      addText(60, y, 10, "F2", "Chimney Flashing:");
      addText(160, y, 10, "F1", cfMap[chimOption] || chimOption);
      y -= 14;
    }
    if (va.skylights && va.skylights !== "na") {
      ensure(14);
      addText(60, y, 10, "F2", "Skylights:");
      addText(160, y, 10, "F1", va.skylights === "reflash" ? "Reflash" : "Replace");
      y -= 14;
    }
    if (pc?.valleyType) {
      ensure(14);
      addText(60, y, 10, "F2", "Valleys:");
      addText(160, y, 10, "F1", pc.valleyType === "closed" ? "Closed Cut" : "Open / Metal");
      y -= 14;
    }
    if (pc?.gutterGuards) {
      ensure(14);
      addText(60, y, 10, "F2", "Gutter Guards:");
      addText(160, y, 10, "F1", pc.gutterGuards);
      y -= 14;
    }
    if (pc?.satelliteDish && pc.satelliteDish !== "NONE") {
      const satMap = { "REMOVE-TRASH": "Remove & discard", "REMOVE-RESET": "Remove & reset after install" };
      ensure(14);
      addText(60, y, 10, "F2", "Satellite Dish:");
      addText(160, y, 10, "F1", satMap[pc.satelliteDish] || String(pc.satelliteDish));
      y -= 14;
    }
    y -= 8;
  }
  // [C3 2026-08-27] The standalone SECOND-LAYER TEAR-OFF CONTINGENCY heading is
  // gone. It is now row 1 of CONTINGENCIES AND CONDITIONAL PRICING, which is
  // where every price-changing condition lives.
  if (hasGutters) {
    ensure(20);
    addText(LEFT_X, y, 11, "F2", "GUTTERS");
    y -= 14;
    if (va.gutters?.option) {
      const go = va.gutters.option;
      let gutterDesc = String(go);
      if (go === "5inch_included" || go === "5inch") gutterDesc = '5" Gutters - Included';
      else if (go === "6inch_included" || go === "6inch") gutterDesc = '6" Gutters - Included';
      // [C3 2026-08-27] Amounts moved to CONTINGENCIES AND CONDITIONAL PRICING.
      else if (go.includes("5inch") && go.includes("additional")) gutterDesc = '5" Gutters - homeowner out-of-pocket, see Contingencies';
      else if (go.includes("6inch") && go.includes("additional")) gutterDesc = '6" Gutters - homeowner out-of-pocket, see Contingencies';
      else if (go === "none") gutterDesc = "No gutter work included";
      ensure(14);
      addText(60, y, 10, "F2", "Gutters:");
      addText(160, y, 10, "F1", gutterDesc);
      y -= 14;
    }
    if (va.gutter_guards) {
      const gg = va.gutter_guards;
      if (gg.pricing_on_request) {
        ensure(14);
        addText(60, y, 10, "F2", "Gutter Guards:");
        addText(160, y, 10, "F1", "Available - pricing on request");
        y -= 14;
      } else if (gg.mesh_oop || gg.screw_in_oop) {
        // [C3 2026-08-27] Amounts moved to CONTINGENCIES AND CONDITIONAL PRICING.
        ensure(14);
        addText(60, y, 10, "F2", "Gutter Guards:");
        addText(160, y, 10, "F1", "Available at homeowner cost - see Contingencies");
        y -= 14;
      }
    }
    y -= 8;
  }
  if (hasSiding) {
    ensure(20);
    addText(LEFT_X, y, 11, "F2", "SIDING");
    y -= 14;
    addText(60, y, 10, "F1", "Scope per contractor bid and property design specifications.");
    y -= 14;
    if (measurements?.wallSqFt) {
      ensure(14);
      addText(60, y, 10, "F2", "Wall Area:");
      addText(160, y, 10, "F1", `${(measurements.wallSqFt / 100).toFixed(1)} squares`);
      y -= 14;
    }
    y -= 8;
  }
  if (hasWindows) {
    ensure(20);
    addText(LEFT_X, y, 11, "F2", "WINDOWS");
    y -= 14;
    addText(60, y, 10, "F1", "Scope per contractor bid.");
    y -= 14;
    y -= 8;
  }
  // ===== WARRANTIES =====
  // [Part 2 item 4 2026-08-28] THIS SECTION HAS NEVER RENDERED FOR ANY CURRENT
  // BID. It read `va.warranties`, and contractor-bid-form.html sets that key to
  // a literal `null` -- commented, in the bid form itself, "D-202 Phase 2:
  // superseded by quotes.warranty_option_id / warranty_snapshot (Session 463)".
  // The read was left pointing at the old field when the field moved. Same
  // defect class as the four C3 fixed: a dead read failing silently.
  //
  // Warranty terms are both a selling point and a contract term, so an Exhibit
  // A that silently omits them is materially incomplete. The live source is
  // quotes.warranty_snapshot -- TEXT, not JSON: a prose sentence captured at
  // bid time, e.g. "GAF Silver Pledge - Material: 50 years (non-prorated);
  // Labor: 10 years; Wind: 130 mph; Hail: Standard. ... OtterQuote is not the
  // warrantor." It is a SNAPSHOT by design (D-202) and is rendered verbatim:
  // reformatting it into rows would mean parsing prose whose shape is set by
  // whoever wrote the warranty option, and getting that wrong on a contract
  // exhibit misstates a warranty term.
  //
  // quotes.workmanship_warranty_years is the contractor's own labor warranty
  // and is separate from the manufacturer program above.
  //
  // The legacy `va.warranties` array is still read so historical bids written
  // before Session 463 keep rendering.
  const legacyWarranties = Array.isArray(va.warranties) ? va.warranties.filter((w: any) => w && w.name) : [];
  const warrantyText = (typeof warrantySnapshot === "string" && warrantySnapshot.trim()) ? warrantySnapshot.trim() : null;
  const workmanshipYears = (workmanshipWarrantyYears != null && !Number.isNaN(Number(workmanshipWarrantyYears)))
    ? Number(workmanshipWarrantyYears) : null;
  if (warrantyText || workmanshipYears != null || legacyWarranties.length > 0) {
    ensure(28);
    hLine(y + 4);
    y -= 12;
    addText(LEFT_X, y, 12, "F2", "WARRANTIES");
    y -= 14;
    if (warrantyText) {
      ensure(24);
      addText(60, y, 10, "F2", "Manufacturer / system warranty:");
      y -= 12;
      y = addWrappedText(70, y, 9, "F1", warrantyText, 480);
      y -= 6;
    }
    if (workmanshipYears != null) {
      ensure(16);
      addText(60, y, 10, "F2", "Contractor workmanship warranty:");
      addText(260, y, 10, "F1", `${workmanshipYears} year${workmanshipYears === 1 ? "" : "s"}`);
      y -= 14;
    }
    for (const w of legacyWarranties) {
      ensure(24);
      addText(60, y, 10, "F2", w.name);
      y -= 12;
      if (w.material_defects?.years) { addText(70, y, 9, "F1", `Material Defects: ${w.material_defects.years} yrs`); y -= 11; }
      if (w.labor?.years) { addText(70, y, 9, "F1", `Labor: ${w.labor.years} yrs`); y -= 11; }
      if (w.wind_damage?.years) { addText(70, y, 9, "F1", `Wind: ${w.wind_damage.years} yrs`); y -= 11; }
      if (w.hail_damage?.years) { addText(70, y, 9, "F1", `Hail: ${w.hail_damage.years} yrs`); y -= 11; }
      y -= 4;
    }
    y -= 4;
  }
  // ===== CONTINGENCIES AND CONDITIONAL PRICING =====
  // [C3 2026-08-27, Dustin-directed] One section listing EVERY condition that
  // can change the contract price, each with its trigger and its rate. These
  // were previously scattered -- decking inside the roofing detail block,
  // second-layer tear-off under its own heading, out-of-pocket options inline
  // with their trades -- and several never rendered at all.
  //
  // Every key below was verified against contractor-bid-form.html's own
  // valueAdds constructor (~line 5233) rather than assumed. Four of these had
  // NEVER reached this document:
  //   - va.drip_edge          (written at :5286, never read here)
  //   - va.rotten_wood_pricing (written at :5318, never read here)
  //   - va.siding_rotten_sheathing_pricing (written at :5328, never read here)
  //   - va.num_stories         (written at :5303, never read here)
  // and a fifth, va.chimney, was read under its deprecated name -- see the
  // chimney fix above.
  //
  // A row with no value is OMITTED. Nothing renders as "TBD": a contract
  // exhibit that says "TBD" next to a price trigger is worse than silence,
  // because it implies a number exists somewhere that the homeowner has not
  // been shown.
  {
    const rows = [];
    const add = (name, trigger, price) => {
      if (price == null || price === "") return;
      rows.push({ name, trigger, price });
    };
    const slc = va?.secondLayerContingency;
    if (hasRoofing && slc) {
      const flat = slc.method === "flat_fee" && slc.flatFeeAlternative != null;
      const amt = flat ? slc.flatFeeAlternative : slc.pricePerSquare;
      if (amt != null) add("Second-layer tear-off", "More than one layer of existing shingles found at tear-off", flat ? `${fmt$(amt)} flat fee` : `${fmt$(amt)} per square`);
    }
    if (hasRoofing) {
      add("Decking replacement", "Deteriorated roof decking found after tear-off", deckingPricePerSheet != null ? `${fmt$(deckingPricePerSheet)} per sheet` : null);
      add("Full re-deck", "Entire roof deck requires replacement", fullRedeckPrice != null ? fmt$(fullRedeckPrice) : null);
    }
    add("Rotten wood / fascia / soffit", "Concealed rot found during the work", typeof va.rotten_wood_pricing === "string" && va.rotten_wood_pricing.trim() ? va.rotten_wood_pricing.trim() : null);
    add("Rotten sheathing behind siding", "Concealed rot found behind removed siding", typeof va.siding_rotten_sheathing_pricing === "string" && va.siding_rotten_sheathing_pricing.trim() ? va.siding_rotten_sheathing_pricing.trim() : null);
    {
      const c = va.chimney ?? va.chimney_flashing ?? va.chimney_reflash ?? null;
      if (c && (c.option === "oop" || c.option === "replace_oop") && c.oop_price != null) {
        add("Chimney flashing", "Homeowner elects chimney flashing work (not included in base price)", fmt$(c.oop_price));
      }
    }
    if (va.ventilation && !va.ventilation.ridge_vent_included && va.ventilation.ridge_vent_oop != null) {
      add("Ridge vent", "Homeowner elects ridge vent (not included in base price)", fmt$(va.ventilation.ridge_vent_oop));
    }
    if (va.drip_edge?.option === "oop" && va.drip_edge.oop_price != null) {
      add("Drip edge", "Homeowner elects drip edge (not included in base price)", fmt$(va.drip_edge.oop_price));
    }
    if (va.gutter_guards) {
      const gg = va.gutter_guards;
      if (gg.mesh_oop != null) add("Gutter guards - mesh", "Homeowner elects mesh gutter guards", fmt$(gg.mesh_oop));
      if (gg.screw_in_oop != null) add("Gutter guards - screw-in", "Homeowner elects screw-in gutter guards", fmt$(gg.screw_in_oop));
      if (gg.pricing_on_request && gg.mesh_oop == null && gg.screw_in_oop == null) {
        add("Gutter guards", "Homeowner elects gutter guards", "Pricing on request");
      }
    }
    if (va.gutters?.option) {
      const go = String(va.gutters.option);
      if (go.includes("5inch") && go.includes("additional") && va.gutters.additional_cost_5inch != null) add('Gutters - 5"', "Homeowner elects 5-inch gutters (not included in base price)", fmt$(va.gutters.additional_cost_5inch));
      if (go.includes("6inch") && go.includes("additional") && va.gutters.additional_cost_6inch != null) add('Gutters - 6"', "Homeowner elects 6-inch gutters (not included in base price)", fmt$(va.gutters.additional_cost_6inch));
    }
    if (va.skylights && va.skylights !== "na") {
      add("Skylights", "Skylight condition assessed on site", va.skylights === "reflash" ? "Reflash - per contractor bid" : "Replace - per contractor bid");
    }
    // [C4 2026-08-27] Slope and access adders. These come from the contractor's
    // rate card, not from the bid form, so they render only when he has one on
    // file -- and the "above the top priced band" row renders whenever measured
    // area sits above every band he prices, WITH or WITHOUT a rate, because the
    // homeowner needs to know that part of the roof is unpriced.
    if (hasRoofing && Array.isArray(pitchBands) && pitchBands.length > 0 && m.areasByPitch) {
      const split = bucketByBands(m.areasByPitch, pitchBands);
      for (const b of split.buckets) {
        if (b.band.rate_per_square != null) {
          add(`Steep-slope charge - ${b.band.label}`, `${b.squares} SQ measured in this slope band`, `${fmt$(b.band.rate_per_square)} per square`);
        }
      }
      if (split.unbandedSquares > 0) {
        add("Slope above priced bands", `${split.unbandedSquares} SQ measured at ${split.unbandedPitches.join(", ")}, above every band on the contractor's rate card`, "Quote required before work begins");
      }
    }
    if (hasRoofing && twoStoryAdder?.rate_per_square != null && String(va.num_stories || "").trim() && String(va.num_stories).trim() !== "1") {
      add("Two-story access", `Structure is ${va.num_stories} stories`, `${fmt$(twoStoryAdder.rate_per_square)} per square`);
    }
    if (rows.length > 0) {
      // [C4e 2026-08-27] 40 was enough for the heading and caption but not for
      // the column header and a first data row, so a section starting near the
      // foot of a page left an orphaned heading + empty header row behind and
      // reprinted both overleaf. Budget the whole opening block.
      ensure(78);
      hLine(y + 4);
      y -= 12;
      addText(LEFT_X, y, 12, "F2", "CONTINGENCIES AND CONDITIONAL PRICING");
      y -= 12;
      y = addWrappedText(LEFT_X, y, 8, "F1", "Every condition below can change the contract price. None is included in the price on page 1. Each states what triggers it and what it costs.", 512);
      y -= 4;
      const cName = 50, cTrig = 210, cPrice = 452;
      const nameChars = 36, trigChars = 56, priceChars = 26;
      const header = () => {
        ensure(18);
        addText(cName, y, 8, "F2", "Contingency");
        addText(cTrig, y, 8, "F2", "Trigger");
        addText(cPrice, y, 8, "F2", "Price");
        y -= 3; hLine(y); y -= 11;
      };
      header();
      const lineH = 10;
      for (const row of rows) {
        const nL = wrapToLines(row.name, nameChars);
        const tL = wrapToLines(row.trigger, trigChars);
        const pL = wrapToLines(row.price, priceChars);
        const n = Math.max(nL.length, tL.length, pL.length);
        const rowH = n * lineH + 3;
        const pagesBefore = pages.length;
        ensure(rowH);
        if (pages.length > pagesBefore) header();
        const topY = y;
        nL.forEach((ln, k) => addText(cName, topY - k * lineH, 8, "F1", ln));
        tL.forEach((ln, k) => addText(cTrig, topY - k * lineH, 8, "F1", ln));
        pL.forEach((ln, k) => addText(cPrice, topY - k * lineH, 8, "F1", ln));
        y = topY - rowH;
      }
      y -= 4;
      hLine(y);
      y -= 12;
      // Conditions that carry no fixed rate because they come from the
      // contractor's own terms, not from the bid form. Rendered as prose, not
      // as priceless table rows -- an empty Price cell reads as an omission.
      y = addWrappedText(LEFT_X, y, 8, "F1", "In addition, and without a fixed rate: permit and other governmental fees are excluded from the contract price unless expressly stated in the contractor's agreement; code-required work and damage concealed behind existing materials is not discoverable before the work begins; and either party may act on a measurement that proves more than 10% off, per the MEASUREMENT DISCLAIMER above. Any of these changes the price only through a written change order under the contractor's own agreement, which the homeowner may accept or decline.", 512);
      y -= 8;
    }
  }

  const hasNotes = homeownerNotes || messageToHomeowner || va.other_offers || pc?.workNotBeingDone || pc?.homeownerNotes;
  if (hasNotes) {
    ensure(28);
    hLine(y + 4);
    y -= 12;
    addText(LEFT_X, y, 12, "F2", "NOTES");
    y -= 14;
    if (homeownerNotes) {
      ensure(20);
      addText(LEFT_X, y, 10, "F2", "Homeowner Notes:");
      y -= 12;
      y = addWrappedText(60, y, 9, "F1", homeownerNotes, 500);
      y -= 4;
    }
    if (messageToHomeowner) {
      ensure(20);
      addText(LEFT_X, y, 10, "F2", "Message from Contractor:");
      y -= 12;
      y = addWrappedText(60, y, 9, "F1", messageToHomeowner, 500);
      y -= 4;
    }
    if (va.other_offers) {
      ensure(20);
      addText(LEFT_X, y, 10, "F2", "Special Offers:");
      y -= 12;
      y = addWrappedText(60, y, 9, "F1", va.other_offers, 500);
      y -= 4;
    }
    if (pc?.workNotBeingDone) {
      ensure(20);
      addText(LEFT_X, y, 10, "F2", "Exclusions:");
      y -= 12;
      y = addWrappedText(60, y, 9, "F1", pc.workNotBeingDone, 500);
      y -= 4;
    }
    if (pc?.homeownerNotes) {
      ensure(20);
      addText(LEFT_X, y, 10, "F2", "Project Notes:");
      y -= 12;
      y = addWrappedText(60, y, 9, "F1", pc.homeownerNotes, 500);
    }
  }
  // ===== PLATFORM ACKNOWLEDGMENT =====
  // [C1 2026-08-27, Dustin-directed] Relocated here from the RETIRED IC 24-5-11
  // compliance addendum (the old Document 3, deleted in this same change).
  // Dustin, verbatim: "We shouldn't be adding terms to their contracts. We
  // shouldn't have our name on their contract." This page IS ours -- it is
  // prepared by Otter Quotes for the homeowner -- so the platform's own
  // non-party disclaimer belongs here, and nowhere else in the envelope.
  //
  // THE FIELD ID IS LOAD-BEARING. D-269 (#550) docusign-webhook/ack-verify.ts
  // fails CLOSED at envelope completion when it cannot find a formFields entry
  // with id exactly `otterquote_acknowledgment` (ACK_FIELD_ID). Renaming it
  // blocks every completed contract. It moved documents; it did not change id.
  //
  // It is now drawn on its own labelled signature line. Previously (#1314) it
  // was drawn at (200,189) -- the same baseline as the visible "PLATFORM
  // DISCLOSURE" heading at (50,189) -- so the homeowner was required to sign a
  // box that sat on top of a heading and was identified as nothing at all.
  //
  // Signer index 2 = homeowner, matching the initials row below: this document
  // has exactly one call site (handleContractorSign), which always sends
  // contractor as signer 1 and homeowner as signer 2.
  ensure(96);
  y -= 12;
  hLine(y + 4);
  y -= 14;
  addText(LEFT_X, y, 12, "F2", "PLATFORM ACKNOWLEDGMENT");
  y -= 14;
  y = addWrappedText(LEFT_X, y, 9, "F1", "Otter Quotes is a technology platform that connects homeowners with contractors. Otter Quotes is NOT a party to the contract between you and the contractor, is not the contractor, and assumes no liability for the work performed under that contract. The contract is between you and the contractor named above.", 512);
  y -= 10;
  ensure(34);
  addText(LEFT_X, y, 9, "F2", "Homeowner acknowledgment:");
  addText(205, y, 9, "F1", "_____________________________________");
  addTextColored(205, y, 8, "F1", "{{sign|2|*||otterquote_acknowledgment}}", 1.0);
  y -= 11;
  addText(205, y, 8, "F1", "Sign here to confirm you have read the statement above.");
  y -= 6;

  // [D-225 Phase 2B / D-186; re-tagged D-274 / #631] Dual-party initials row.
  // The visible labels (Contractor / Homeowner) sit beside blank underscores;
  // BoldSign Text Tags are drawn in white at the same x so they are invisible
  // on paper but auto-discovered by BoldSign's UseTextTags parser. This
  // document (generateRetailScopeOfWorkPdf) has exactly one call site
  // (handleContractorSign), which always sends contractor as signer 1 and
  // homeowner as signer 2 — safe to hardcode here, unlike the compliance
  // addendum which has two callers with opposite orders.
  ensure(46);
  y -= 18;
  hLine(y + 4);
  y -= 16;
  addText(LEFT_X, y, 10, "F2", "Initials:");
  addText(115, y, 10, "F1", "Contractor:");
  addText(180, y, 10, "F1", "_________");
  // [gh-1244 fix] Position-4 Field label emptied — see the gh-1244 root-cause
  // comment: a non-empty Placeholder (position 4) on an `init` field is what
  // makes BoldSign's background document-creation validation fail silently.
  // Field ID unchanged: D-186 dual-party initials depend on it.
  addTextColored(180, y, 10, "F1", "{{init|1|*||contractor_initial_sow}}", 1.0);
  addText(320, y, 10, "F1", "Homeowner:");
  addText(390, y, 10, "F1", "_________");
  addTextColored(390, y, 10, "F1", "{{init|2|*||homeowner_initial_sow}}", 1.0);
  y -= 4;
  y -= 12;
  hLine(y + 4);
  y -= 12;
  y = addWrappedText(LEFT_X, y, 8, "F1", "This Scope of Work is a reference document generated by Otter Quotes. The contractor's signed agreement is the binding contract. Scope details are based on the contractor's bid submission and may be supplemented by on-site assessment.", 512);
  ensure(12);
  addText(LEFT_X, y, 8, "F1", `Generated by Otter Quotes on ${contractDate} - Job Ref ${claimId.slice(-8).toUpperCase()}`);
  // ===== ASSEMBLE MULTI-PAGE PDF =====
  pages.push(contentLines); // finalize the last page
  const N = pages.length;
  const pdfLines = [];
  const pdfObjects = [];
  let byteOffset = 0;
  function pdfWrite(s) { pdfLines.push(s); byteOffset += s.length + 1; }
  function pdfStartObj(n) { pdfObjects[n] = byteOffset; pdfWrite(`${n} 0 obj`); }
  pdfWrite("%PDF-1.4");
  // obj 1: Catalog, obj 2: Pages, obj 3: F1, obj 4: F2, then per page:
  // Page obj = 5 + 2*i, Contents obj = 6 + 2*i.
  pdfStartObj(1);
  pdfWrite("<< /Type /Catalog /Pages 2 0 R >>");
  pdfWrite("endobj");
  const kids = [];
  for (let i = 0; i < N; i++) kids.push(`${5 + 2 * i} 0 R`);
  pdfStartObj(2);
  pdfWrite(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${N} >>`);
  pdfWrite("endobj");
  pdfStartObj(3);
  pdfWrite("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pdfWrite("endobj");
  pdfStartObj(4);
  pdfWrite("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  pdfWrite("endobj");
  for (let i = 0; i < N; i++) {
    const pageNum = 5 + 2 * i;
    const contentsNum = 6 + 2 * i;
    const stream = pages[i].join("\n");
    pdfStartObj(pageNum);
    pdfWrite(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentsNum} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`);
    pdfWrite("endobj");
    pdfStartObj(contentsNum);
    pdfWrite(`<< /Length ${stream.length} >>`);
    pdfWrite("stream");
    pdfWrite(stream);
    pdfWrite("endstream");
    pdfWrite("endobj");
  }
  const totalObjects = 4 + 2 * N;
  const xrefOffset = byteOffset;
  pdfWrite("xref");
  pdfWrite(`0 ${totalObjects + 1}`);
  pdfWrite("0000000000 65535 f ");
  for (let i = 1; i <= totalObjects; i++) {
    pdfWrite(String(pdfObjects[i]).padStart(10, "0") + " 00000 n ");
  }
  pdfWrite("trailer");
  pdfWrite(`<< /Size ${totalObjects + 1} /Root 1 0 R >>`);
  pdfWrite("startxref");
  pdfWrite(String(xrefOffset));
  pdfWrite("%%EOF");
  return base64EncodeBinary(new TextEncoder().encode(pdfLines.join("\n")));
}

// ========== [D-274 / #631] TAB-BUILDER FUNCTIONS RETIRED ==========
// buildTextTabs, buildSignerTabs, buildSowInitialTabs, and buildAddendumTabs
// (DocuSign anchor-tab descriptors, ~160 lines) are DELETED, not ported.
// Under BoldSign, a "tab" is not a separate API object describing where to
// find an anchor — it IS the literal `{{FieldType|SignerIndex|Required|
// Label|FieldID}}` text already present in a document's content, discovered
// automatically when the send request sets `useTextTags: true`. There is
// nothing left for these functions to "build":
//   - Signature/date fields on our own generated PDFs (compliance addendum,
//     retail Scope of Work) are now baked directly into their content at
//     generation time — see generateComplianceAddendumPdf's addTextColored
//     calls (cancellation_acknowledgment_signature, otterquote_acknowledgment)
//     and generateRetailScopeOfWorkPdf's initials row
//     (contractor_initial_sow, homeowner_initial_sow).
//   - Signature/date/initial fields on the CONTRACTOR'S OWN uploaded
//     template are whatever tags the contractor typed into their PDF per
//     the v3 D-199 manifest (validate-contract-template/index.ts) — nothing
//     for this Edge Function to construct; BoldSign discovers them.
//   - Auto-filled, LOCKED header text values (customer name, contract
//     price, etc.) that buildTextTabs used to inject onto the contractor's
//     template are NOT ported — see the D-274 build report on issue #631
//     for the full explanation. In short: BoldSign can only prefill+lock a
//     value via exact-pixel `Bounds`-based FormFields, never via an inline
//     Text Tag, and this codebase has no coordinate data for arbitrary
//     contractor-uploaded PDFs (DocuSign's anchorString matching never
//     needed coordinates; BoldSign has no equivalent). This is a real,
//     flagged capability gap for insurance-funded jobs specifically (retail
//     jobs still get this data reliably via the Scope of Work's own baked
//     header block, generated independently of any e-sign vendor).
//     autoPopulateFields() below is UNCHANGED and still computes this data
//     for that reason — it feeds the SOW header — but its output is no
//     longer passed to a tab-builder for the contractor's own template.
// ========== DOCUMENT LABEL HELPERS ==========
function getDocumentLabel(documentType) {
  switch(documentType){
    case "contract":
    case "contractor_sign":
    case "homeowner_sign":
      return "Repair Contract";
    case "color_confirmation":
      return "Color Confirmation";
    case "project_confirmation":
      return "Project Confirmation";
    default:
      return "Document";
  }
}
// ========== [D-274 / #631] PER-ENVELOPE EVENT NOTIFICATION — RETIRED, NO REPLACEMENT ==========
// buildEventNotification() embedded a per-envelope DocuSign Connect webhook
// subscription directly on each envelope (D-211 P18 U5), specifically so the
// platform-fee path was self-healing and independent of the DocuSign
// account's manual, easy-to-misconfigure "Include Data" dashboard toggle
// (an empty toggle was the original "0 fees ever" root cause).
//
// BoldSign has NO per-request equivalent. Confirmed against the live
// OpenAPI spec (api.boldsign.com/swagger/v1/swagger.json — grepped in full
// for "webhook" across every SendForSign-reachable schema): every webhook
// hit in the spec describes the PAYLOAD BoldSign sends, never a per-send
// callback-URL override field. BoldSign webhooks are configured ONCE,
// account-wide, in the BoldSign dashboard (Settings -> Webhooks). This is a
// real, unavoidable manual step, NOT something this Edge Function can
// provision — see the D-274 build report on issue #631 for the exact
// cutover checklist item (register
// https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/docusign-webhook as
// a BoldSign webhook, subscribed to at least the Completed/Declined/Revoked
// events, and copy its per-webhook signing secret into
// BOLDSIGN_WEBHOOK_HMAC_SECRET). Unlike the DocuSign toggle this replaces,
// there is no equivalent "silently empty" failure mode to defend against
// here — it either is or isn't configured, and if it isn't, EVERY BoldSign
// envelope this function sends will simply never notify the platform at
// all (a broader failure than a DocuSign misconfiguration would have been,
// which is exactly why this is called out as a hard cutover prerequisite,
// not an optional nice-to-have).
// ========== AUTO-POPULATE FIELDS FROM DB ==========
async function autoPopulateFields(supabase, claimId, contractorId, signerName, signerEmail, documentType) {
  const { data: claimData } = await supabase.from("claims").select("*").eq("id", claimId).single();
  const { data: contractorData } = await supabase.from("contractors").select("*").eq("id", contractorId).single();
  const { data: bidData } = await supabase.from("quotes").select("*").eq("claim_id", claimId).eq("contractor_id", contractorId).single();
  const homeownerProfile = await getHomeownerName(supabase, claimId);
  // ========== [#1314 / Part B, 2026-08-27] PHANTOM COLUMN READS FIXED ==========
  // Nine reads in this function targeted columns that DO NOT EXIST. Each one
  // silently yielded undefined -> "". Verified against the live schema on
  // yeszghaspzwwstvsrioa (information_schema.columns), not inferred:
  //
  //   bidData.amount                -> quotes.total_price
  //   bidData.brand                 -> inside quotes.scope_summary (JSON string)
  //   bidData.estimated_start_date  -> inside quotes.scope_summary (JSON string)
  //   bidData.warranty_years        -> quotes.workmanship_warranty_years
  //   claimData.material_product    -> no such column; the material is the bid's
  //                                    brand (scope_summary) or quotes.material_selection
  //   claimData.address_line1/_city/_state/_zip -> claims has only property_address;
  //                                    city/state/zip live on profiles
  //   claimData.phone               -> no such column; profiles.phone
  //
  // These were harmless only while the output was discarded (the D-274 tab
  // builder was retired). #1314's point stands: the moment anyone restores
  // prefill they wire seven blank fields and blame BoldSign. Fixed now so that
  // does not happen.
  //
  // The homeowner's phone and city/state/zip come from `profiles`, which is
  // where the homeowner's own address actually lives.
  let homeownerProfileRow = null;
  if (claimData?.user_id) {
    const { data: hp } = await supabase
      .from("profiles")
      .select("phone, address_street, address_city, address_state, address_zip")
      .eq("id", claimData.user_id)
      .maybeSingle();
    homeownerProfileRow = hp ?? null;
  }
  // quotes.scope_summary is a JSON *string* carrying the retail bid facts that
  // have no columns of their own. Parsed defensively -- a malformed value must
  // not take down envelope creation.
  let scopeSummaryObj = null;
  if (bidData?.scope_summary) {
    try {
      scopeSummaryObj = typeof bidData.scope_summary === "string"
        ? JSON.parse(bidData.scope_summary)
        : bidData.scope_summary;
    } catch (_e) {
      console.warn("autoPopulateFields: quotes.scope_summary is not valid JSON (non-fatal)");
    }
  }
  const fields = {};
  if (claimData) {
    fields.customer_name = homeownerProfile.fullName;
    fields.customer_address = claimData.property_address || "";
    fields.customer_city_zip = [
      homeownerProfileRow?.address_city,
      [homeownerProfileRow?.address_state, homeownerProfileRow?.address_zip].filter(Boolean).join(" "),
    ].filter(Boolean).join(", ");
    fields.customer_phone = homeownerProfileRow?.phone || "";
    fields.customer_email = signerEmail || "";
    // #514: claims has no `insurance_carrier` column — read carrier_name
    // (written by parse-loss-sheet), with the legacy name as a fallback.
    fields.insurance_company = claimData.carrier_name || claimData.insurance_carrier || "";
    fields.claim_number = claimData.claim_number || "";
    fields.deductible = claimData.deductible_amount ? `$${Number(claimData.deductible_amount).toLocaleString()}` : "";
    fields.contract_date = new Date().toLocaleDateString("en-US");
    fields.job_description = claimData.damage_type ? `Roof ${claimData.damage_type}` : "Roof Replacement";
    // No claims.material_product column exists. The material on a bid is the
    // brand the contractor quoted.
    fields.material_type = scopeSummaryObj?.brand || bidData?.material_selection || claimData.material_category || "";
  }
  if (bidData) {
    // quotes.total_price, not quotes.amount -- total_price is the number the
    // homeowner accepted and the number the platform fee is charged against.
    fields.contract_price = bidData.total_price != null ? `$${Number(bidData.total_price).toLocaleString()}` : "";
    fields.warranty_years = bidData.workmanship_warranty_years ? `${bidData.workmanship_warranty_years} years` : "";
    fields.estimated_start = scopeSummaryObj?.estimated_start_date || "";
    fields.decking_per_sheet = bidData.decking_price_per_sheet ? `$${bidData.decking_price_per_sheet}` : "";
    fields.full_redeck_price = bidData.full_redeck_price ? `$${Number(bidData.full_redeck_price).toLocaleString()}` : "";
  }
  if (contractorData) {
    fields.contractor_name = contractorData.company_name || "";
    fields.contractor_phone = contractorData.phone || "";
    fields.contractor_email = contractorData.email || "";
    fields.contractor_address = contractorData.address_line1 ? `${contractorData.address_line1}, ${contractorData.address_city || ""}, ${contractorData.address_state || ""} ${contractorData.address_zip || ""}` : "";
    fields.contractor_license = "";
    const { data: licenseData } = await supabase.from("contractor_licenses").select("license_number, municipality").eq("contractor_id", contractorData.id).limit(1);
    if (licenseData && licenseData.length > 0) {
      fields.contractor_license = `${licenseData[0].license_number} (${licenseData[0].municipality})`;
    }
  }
  if (documentType === "project_confirmation" && claimData?.project_confirmation) {
    const pc = claimData.project_confirmation;
    Object.assign(fields, {
      shingle_manufacturer: pc.shingleManufacturer || "",
      shingle_type: pc.shingleType || "",
      shingle_color: pc.shingleColor || "",
      drip_edge_color: pc.dripEdgeColor || "",
      skylights: pc.skylightsAction ? `${pc.skylightsAction} (${pc.skylightCount || 0})` : "",
      satellite: pc.satelliteDish || "",
      valley_type: pc.valleyType || "",
      gutter_guards: pc.gutterGuards || "",
      num_structures: pc.numStructures || "",
      structure_names: pc.structureNames || "",
      bad_decking: pc.badDeckingExpected || "",
      work_not_done: pc.workNotBeingDone || "",
      non_recoverable: pc.nonRecoverableDepreciation != null ? `$${Number(pc.nonRecoverableDepreciation).toLocaleString()}` : "",
      project_notes: pc.homeownerNotes || ""
    });
  }
  return {
    fields,
    claimData,
    contractorData,
    bidData
  };
}
// ========== HANDLER: CONTRACTOR SIGN (new — Step A) ==========
async function handleContractorSign(supabase, requestBody, corsHeaders) {
  const { claim_id, contractor_id, signer, fields: providedFields, return_url, quote_id } = requestBody;
  // gh-1400: never mint while a live envelope exists for this quote. The entry
  // point already resolved it. Re-entering the page must return the contractor
  // to the document they are partway through -- not create a second one, strand
  // the first, and spend another unit of plan quota doing it.
  if (requestBody.resolved_envelope_id) {
    console.log(`contractor_sign: resuming existing document ${requestBody.resolved_envelope_id} (no mint)`);
    return await issueContractorSignLink(supabase, {
      claim_id,
      envelopeId: requestBody.resolved_envelope_id,
      signer,
      return_url,
      corsHeaders,
      resumed: true
    });
  }
  let autoFields = providedFields || {};
  let claimData = null;
  let contractorData = null;
  let bidData = null;
  if (!providedFields || Object.keys(providedFields).length === 0) {
    const result = await autoPopulateFields(supabase, claim_id, contractor_id, signer.name, signer.email, "contractor_sign");
    autoFields = result.fields;
    claimData = result.claimData;
    contractorData = result.contractorData;
    bidData = result.bidData;
  } else {
    const { data: c } = await supabase.from("contractors").select("*").eq("id", contractor_id).single();
    contractorData = c;
    const { data: cl } = await supabase.from("claims").select("*").eq("id", claim_id).single();
    claimData = cl;
    const { data: bd } = await supabase.from("quotes").select("*").eq("claim_id", claim_id).eq("contractor_id", contractor_id).maybeSingle();
    bidData = bd;
  }
  const trades = claimData?.trades || [];
  const trade = trades.length ? trades[0].toLowerCase() : "roofing";
  // Canonicalize claim funding to the template vocabulary. claims.funding_type
  // is 'insurance' | 'cash' — the old code compared raw 'cash' against slot
  // labels like 'Retail'/'Insurance (full replacement)', so the primary match
  // NEVER hit and the trade-only fallback could attach the wrong contract type
  // (insurance agreement on a retail job). (E2E walk fix 2026-07-07.)
  const rawClaimFunding = String(claimData?.funding_type || claimData?.job_type || "insurance").toLowerCase();
  const fundingType = rawClaimFunding.includes("insurance") ? "insurance" : "retail";
  const normalizeSlotFunding = (f)=>{
    const s = String(f || "").toLowerCase();
    if (s.includes("insurance")) return "insurance";
    if (s.includes("retail") || s.includes("cash")) return "retail";
    return s;
  };
  const templates = contractorData?.contract_templates || [];
  let matchingTemplate = templates.find((t)=>t.trade && t.trade.toLowerCase() === trade && t.funding_type && normalizeSlotFunding(t.funding_type) === fundingType);
  if (!matchingTemplate) {
    matchingTemplate = templates.find((t)=>t.trade && t.trade.toLowerCase() === trade);
  }
  if (!matchingTemplate && contractorData?.contract_pdf_url) {
    matchingTemplate = {
      file_url: contractorData.contract_pdf_url
    };
  }
  let templateBase64;
  if (matchingTemplate?.path) {
    // Real contract_templates entries carry the storage location under `path`
    // (e.g. "<contractor_id>/<trade>/<funding>.pdf"), NOT `file_url`. Resolve the
    // matched template directly from the contractor-templates bucket using that
    // path. Production values are bucket-relative; defensively strip a leading
    // "contractor-templates/" prefix in case an entry is ever stored fully-qualified.
    const storagePath = String(matchingTemplate.path).replace(/^contractor-templates\//, "");
    console.log(`contractor_sign template: resolving from contractor-templates/${storagePath}`);
    const { data: blob, error } = await supabase.storage.from("contractor-templates").download(storagePath);
    if (error) throw new Error(`Template download error (${storagePath}): ${error.message}`);
    const ab = await blob.arrayBuffer();
    const templateBytes = new Uint8Array(ab);
    if (templateBytes.length > PDF_MAX_BYTES) {
      throw new DocumentTooLargeError(storagePath, templateBytes.length);
    }
    templateBase64 = base64EncodeBinary(templateBytes);
  } else if (matchingTemplate?.file_url && matchingTemplate.file_url.includes("contractor-templates")) {
    const pathMatch = matchingTemplate.file_url.match(/contractor-templates\/(.+)$/);
    if (pathMatch) {
      const storagePath = decodeURIComponent(pathMatch[1]);
      const { data: blob, error } = await supabase.storage.from("contractor-templates").download(storagePath);
      if (error) throw new Error(`Template download error: ${error.message}`);
      const ab = await blob.arrayBuffer();
      const templateBytes = new Uint8Array(ab);
      if (templateBytes.length > PDF_MAX_BYTES) {
        throw new DocumentTooLargeError(storagePath, templateBytes.length);
      }
      templateBase64 = base64EncodeBinary(templateBytes);
    } else {
      templateBase64 = await fetchTemplateFromUrl(matchingTemplate.file_url);
    }
  } else if (matchingTemplate?.file_url) {
    templateBase64 = await fetchTemplateFromUrl(matchingTemplate.file_url);
  } else {
    templateBase64 = await getTemplateFromStorage(supabase, contractor_id, "contract");
  }
  const contractDate = new Date().toLocaleDateString("en-US");
  const contractorName = contractorData?.company_name || signer.name || "Contractor";
  // Resolve homeowner identity from profiles before PDF generation.
  // autoFields.customer_name is set from signer.name (contractor) in autoPopulateFields,
  // so it must NOT be used as the homeowner name — doing so causes UNKNOWN_ENVELOPE_RECIPIENT
  // when handleHomeownerSign tries to create the recipient view (PFW canary 2026-05-20).
  const resolvedHomeowner = await getHomeownerName(supabase, claim_id);
  let homeownerEmail = resolvedHomeowner.email || "homeowner@placeholder.otterquote.com";
  let homeownerFullName = resolvedHomeowner.fullName || "Homeowner";
  if (homeownerFullName === contractorName || homeownerFullName.trim().length === 0) {
    console.error(`[create-docusign-envelope] homeowner name mismatch: homeownerFullName="${homeownerFullName}", ` + `contractorName="${contractorName}", claim_id=${claim_id} — falling back to "Homeowner"`);
    homeownerFullName = "Homeowner";
  }
  const homeownerName = homeownerFullName;
  // [D-274 / #631] homeownerSignerIndex=2 — this flow (handleContractorSign)
  // always sends contractor as signer 1, homeowner as signer 2 (see the
  // signers[] array built below).
  // [C1 2026-08-27, Dustin-directed] The compliance addendum (Document 3) is
  // retired -- see the tombstone above generateRetailScopeOfWorkPdf.
  //
  // The Scope of Work is no longer gated on `isRetail`. Dustin: "I think we do
  // Exhibit A on all jobs." Two reasons it has to be unconditional now:
  //   - it is the only document in the envelope carrying the REQUIRED
  //     otterquote_acknowledgment field, so gating it would make D-269's
  //     ack-verify fail closed on every insurance-funded contract; and
  //   - the measurements, scope and disclaimers are just as true on an
  //     insurance job.
  // For ACV/RCV jobs the scope basis is the insurer's own estimate, already
  // parsed onto claims.parsed_line_items by parse-loss-sheet.
  let scopeOfWorkBase64 = null;
  {
    try {
      // If the Hover report has not yet been parsed into claims.hover_measurements
      // but a source report PDF is on file, invoke parse-hover-measurements first
      // so the line-item Scope of Work is built from real measurements. Non-fatal:
      // any failure just means the SOW falls back to whatever fetchHoverMeasurements
      // can find (or renders without the Hover measurement block).
      if (!claimData?.hover_measurements && claimData?.measurements_filename) {
        try {
          const parseUrl = `${Deno.env.get("SUPABASE_URL") ?? "https://yeszghaspzwwstvsrioa.supabase.co"}/functions/v1/parse-hover-measurements`;
          const parseResp = await fetch(parseUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${getServiceRoleKey()}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              claim_id
            })
          });
          if (parseResp.ok) {
            const parseJson = await parseResp.json().catch(() => null);
            console.log(`parse-hover-measurements(claim ${claim_id}): ok=${parseJson?.ok ?? "?"}`);
          } else {
            console.warn(`parse-hover-measurements returned HTTP ${parseResp.status} for claim ${claim_id}`);
          }
        } catch (parseErr) {
          console.warn("parse-hover-measurements invocation failed (non-fatal):", parseErr);
        }
      }
      // fetchHoverMeasurements re-reads claims.hover_measurements fresh, so it
      // picks up whatever parse-hover-measurements just wrote.
      const measurements = await fetchHoverMeasurements(supabase, claim_id);
      // Retail bid facts (brand, estimated start date) live in the
      // quotes.scope_summary JSON STRING — quotes has no brand /
      // estimated_start_date / amount columns. Parse it defensively. The contract
      // price is quotes.total_price; trades come from claims.trades.
      let bidBrand = null;
      let estimatedStartDate = null;
      if (bidData?.scope_summary) {
        try {
          const parsedScope = typeof bidData.scope_summary === "string" ? JSON.parse(bidData.scope_summary) : bidData.scope_summary;
          bidBrand = parsedScope?.brand ?? null;
          estimatedStartDate = parsedScope?.estimated_start_date ?? null;
        } catch (scopeErr) {
          console.warn("Failed to parse quotes.scope_summary JSON (non-fatal):", scopeErr);
        }
      }
      const contractPrice = bidData?.total_price ?? null;
      const sowTrades = (Array.isArray(claimData?.trades) && claimData.trades.length) ? claimData.trades : [
        trade
      ];
      scopeOfWorkBase64 = generateRetailScopeOfWorkPdf({
        homeownerName,
        contractorName,
        propertyAddress: claimData?.property_address || autoFields.customer_address || "",
        claimId: claim_id,
        trades: sowTrades,
        contractPrice,
        estimatedStartDate,
        valueAdds: bidData?.value_adds ?? null,
        bidBrand,
        deckingPricePerSheet: bidData?.decking_price_per_sheet ?? null,
        fullRedeckPrice: bidData?.full_redeck_price ?? null,
        // [C2 2026-08-27] Guarded: never attribute unverified prose to the
        // contractor. See contractorAuthoredMessage() for the mechanism.
        messageToHomeowner: contractorAuthoredMessage(bidData),
        homeownerNotes: claimData?.homeowner_notes ?? null,
        projectConfirmation: claimData?.project_confirmation ?? null,
        measurements,
        contractDate,
        fundingType,
        // [C4 2026-08-27] The contractor's own priced slope bands. Absent today
        // for every contractor -- `contractors.pitch_bands` is a Tier 3A
        // migration drafted but NOT applied (see
        // supabase/migrations_drafts/c4_contractor_pitch_bands*). Until it
        // lands this resolves to undefined and bucketByBands falls back to the
        // Xactimate-aligned 7/12 threshold, which is the documented behaviour,
        // not a silent default.
        pitchBands: contractorData?.pitch_bands?.bands ?? null,
        twoStoryAdder: contractorData?.pitch_bands?.two_story_adder ?? null,
        // [Part 2 2026-08-28] The insurer's own estimate, for the `insurance`
        // Exhibit A shape. parse-loss-sheet writes all five of these; no new
        // parser is needed. Every one is nullable and a retail claim carries
        // none of them, which is exactly how resolveMeasurementShape /
        // insurerScopeRows decide the shape.
        insurance: {
          parsedLineItems: claimData?.parsed_line_items ?? null,
          scopeSummary: claimData?.contractor_scope_summary ?? null,
          rcv: claimData?.rcv_amount ?? null,
          acv: claimData?.acv_amount ?? null,
          deductible: claimData?.deductible_amount ?? null,
          carrier: claimData?.parsed_line_items?.carrier_name ?? null,
          format: claimData?.parsed_line_items?.format_detected ?? null,
          pricingDatabase: claimData?.parsed_line_items?.pricing_database ?? null
        },
        // [Part 2 item 4 2026-08-28] The WARRANTIES section read va.warranties,
        // which contractor-bid-form.html sets to a literal null. Live source is
        // quotes.warranty_snapshot (TEXT) + quotes.workmanship_warranty_years.
        warrantySnapshot: bidData?.warranty_snapshot ?? null,
        workmanshipWarrantyYears: bidData?.workmanship_warranty_years ?? null
      });
      console.log(`Retail Scope of Work PDF generated for claim ${claim_id}`);
    } catch (sowErr) {
      console.error("Retail SOW PDF generation failed (non-fatal, continuing without SOW):", sowErr);
      scopeOfWorkBase64 = null;
    }
  }
  const docLabel = getDocumentLabel("contractor_sign");
  const files = [
    `data:application/pdf;base64,${templateBase64}`,
    ...scopeOfWorkBase64 ? [`data:application/pdf;base64,${scopeOfWorkBase64}`] : []
  ];
  const sendBody = {
    title: `${docLabel} — Otter Quotes (Job #${claim_id.slice(-8).toUpperCase()})`,
    files,
    // gh-1244: BoldSign's Signers[].Id must be a GUID -- confirmed live via
    // the sandbox E2E run ("The field Id is invalid" from /v1/document/send
    // for both signers when this was the string literal "contractor_1").
    // DocuSign's recipientId accepted arbitrary strings; BoldSign does not.
    signers: [
      {
        id: crypto.randomUUID(),
        name: signer.name,
        emailAddress: signer.email,
        signerOrder: 1,
        signerType: "Signer"
      },
      {
        id: crypto.randomUUID(),
        name: homeownerFullName,
        emailAddress: homeownerEmail,
        signerOrder: 2,
        signerType: "Signer"
      }
    ],
    enableSigningOrder: true,
    enableEmbeddedSigning: true,
    // [D-274 / #631] BoldSign auto-discovers every {{...}} Text Tag across
    // ALL documents in `files` when this is true — see the signature/
    // initial/acknowledgment tags baked into generateComplianceAddendumPdf,
    // generateRetailScopeOfWorkPdf, and (per the v3 D-199 manifest) whatever
    // the contractor typed into their own uploaded template.
    useTextTags: true,
    isSandbox: Deno.env.get("BOLDSIGN_SANDBOX") === "true",
    metaData: {
      claim_id,
      document_type: "contractor_sign"
    }
  };
  console.log("Creating BoldSign document (contractor_sign)");
  const sendResponse = await fetch(`${BOLDSIGN_API_BASE}/v1/document/send`, {
    method: "POST",
    headers: boldSignHeaders({
      "Content-Type": "application/json"
    }),
    body: JSON.stringify(sendBody)
  });
  if (!sendResponse.ok) {
    const errorData = await sendResponse.text();
    console.error("BoldSign document send failed:", errorData);
    throw new Error(`Failed to create document: ${sendResponse.status} ${errorData}`);
  }
  const sendData = await sendResponse.json();
  const envelopeId = sendData.documentId;
  if (!envelopeId) throw new Error("No documentId returned from BoldSign");
  console.log(`Document created (contractor_sign): ${envelopeId}`);
  // gh-1400: persist the pointer BEFORE handing out a signing link. The old
  // order asked BoldSign for the link first and only recorded the envelope id
  // afterwards, so any failure in between left a real, paid-for document that
  // no later page entry could find -- the next entry would mint again and the
  // first became unreachable. That is exactly how 32e83466 was stranded.
  // Recording first makes the resume lookup authoritative even on a partial
  // failure: the signer retries and lands back on the same document.
  const quoteUpdateFilter = quote_id ? supabase.from("quotes").update({
    docusign_envelope_id: envelopeId
  }).eq("id", quote_id) : supabase.from("quotes").update({
    docusign_envelope_id: envelopeId
  }).eq("claim_id", claim_id).eq("contractor_id", contractor_id);
  const { error: quoteUpdateError } = await quoteUpdateFilter;
  if (quoteUpdateError) {
    console.error("Failed to update quote with envelope ID:", quoteUpdateError);
  }
  await supabase.from("claims").update({
    contract_sent_at: new Date().toISOString(),
    docusign_envelope_id: envelopeId
  }).eq("id", claim_id);
  return await issueContractorSignLink(supabase, {
    claim_id,
    envelopeId,
    signer,
    return_url,
    corsHeaders,
    resumed: false
  });
}
// ========== HANDLER: HOMEOWNER SIGN (new — Step C) ==========
async function handleHomeownerSign(supabase, requestBody, corsHeaders) {
  const { claim_id, contractor_id, signer, return_url, quote_id } = requestBody;
  let envelopeId = null;
  if (quote_id) {
    const { data: quoteData } = await supabase.from("quotes").select("docusign_envelope_id, contractor_signed_at").eq("id", quote_id).single();
    envelopeId = quoteData?.docusign_envelope_id;
  }
  if (!envelopeId) {
    const { data: quoteData } = await supabase.from("quotes").select("docusign_envelope_id, contractor_signed_at").eq("claim_id", claim_id).eq("contractor_id", contractor_id).not("docusign_envelope_id", "is", null).order("created_at", {
      ascending: false
    }).limit(1).single();
    envelopeId = quoteData?.docusign_envelope_id;
  }
  if (!envelopeId) {
    throw new Error("No existing BoldSign document found for this quote. The contractor must sign first.");
  }
  // gh-1293: contract-signing.html now errors instead of silently defaulting
  // to homeowner when role= is missing — carry it through the return URL.
  const defaultReturnUrl = return_url || `https://otterquote.com/contract-signing.html?claim_id=${claim_id}&role=homeowner&signed=true`;
  console.log(`Generating homeowner signing URL for document ${envelopeId}`);
  // gh-1244: envelopeId here is an existing, already-created document (read
  // from quotes.docusign_envelope_id), so this wait is normally a no-op --
  // kept for consistency across all three call sites and as a defensive
  // guard if this is ever called moments after the contractor's own send.
  await waitForBoldSignDocumentReady(envelopeId);
  // gh-1244: camelCase param names -- see the matching fix + comment in
  // handleContractorSign above.
  const signLinkResponse = await fetch(
    `${BOLDSIGN_API_BASE}/v1/document/getEmbeddedSignLink?` + new URLSearchParams({
      documentId: envelopeId,
      signerEmail: signer.email,
      redirectUrl: defaultReturnUrl
    }),
    {
      headers: boldSignHeaders()
    }
  );
  if (!signLinkResponse.ok) {
    const errorData = await signLinkResponse.text();
    console.error("Homeowner signing URL generation failed:", errorData);
    throw new Error(`Failed to generate homeowner signing URL: ${signLinkResponse.status} ${errorData}`);
  }
  const signLinkData = await signLinkResponse.json();
  const signingUrl = signLinkData.signLink;
  if (!signingUrl) throw new Error("No signLink returned from BoldSign getEmbeddedSignLink");
  console.log("Homeowner signing URL generated successfully");
  return new Response(JSON.stringify({
    success: true,
    envelope_id: envelopeId,
    signing_url: signingUrl,
    status: "sent",
    document_type: "homeowner_sign",
    signer_email: signer.email
  }), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
// ========== HANDLER: LEGACY CONTRACT / COLOR / PROJECT CONFIRMATION ==========
async function handleLegacyFlow(supabase, requestBody, corsHeaders) {
  const { claim_id, document_type, contractor_id, signer, fields: providedFields, return_url } = requestBody;
  let autoFields = providedFields || {};
  let claimData = null;
  let contractorData = null;
  if (!providedFields || Object.keys(providedFields).length === 0) {
    const result = await autoPopulateFields(supabase, claim_id, contractor_id, signer.name, signer.email, document_type);
    autoFields = result.fields;
    claimData = result.claimData;
    contractorData = result.contractorData;
  } else {
    if (document_type === "project_confirmation") {
      // [#522 fix, carried into D-274] claims.selected_trades is a ghost
      // column — the real column is claims.trades. The old select() below
      // silently returned undefined for every row, so `trade` always fell
      // through to the "roofing" default regardless of the claim's actual
      // trade(s). Fixed here since this exact function is already being
      // touched for the BoldSign rewrite; see the #522 comment on issue
      // #522 for the full note (not fixed inside #522 itself per the D-274
      // build brief's instruction not to silently absorb that issue's scope).
      const { data: fetchedClaim } = await supabase.from("claims").select("project_confirmation, property_address, trades, funding_type, job_type").eq("id", claim_id).single();
      claimData = fetchedClaim;
      const { data: fetchedContractor } = await supabase.from("contractors").select("color_confirmation_template, company_name, email").eq("id", contractor_id).single();
      contractorData = fetchedContractor;
    }
  }
  let templateBase64;
  if (document_type === "project_confirmation") {
    const templateContractor = contractorData || await (async ()=>{
      const { data } = await supabase.from("contractors").select("color_confirmation_template, company_name").eq("id", contractor_id).single();
      return data;
    })();
    // [#522 fix, carried into D-274] claims.trades, not the ghost column
    // claims.selected_trades — see the comment above.
    const trade = (claimData?.trades?.[0] || autoFields?.trade_type)?.toLowerCase() || "roofing";
    const rawFunding = (claimData?.funding_type || claimData?.job_type || autoFields?.funding_type || "").toLowerCase();
    const fundingType = rawFunding.includes("insurance") ? "insurance" : "retail";
    const slot = selectPcTemplateSlot(templateContractor?.color_confirmation_template, trade, fundingType);
    if (!slot) {
      console.warn(`[D-161] No project confirmation template found for contractor ${contractor_id} ` + `(trade=${trade}, fundingType=${fundingType}). Omitting PC document from envelope.`);
      throw new Error("No project confirmation template on file for this trade and funding type. " + "The contractor must upload a Project Confirmation Template in their profile before this document can be created.");
    }
    templateBase64 = await getPcTemplateFromStorage(supabase, slot.file_url);
  } else {
    templateBase64 = await getTemplateFromStorage(supabase, contractor_id, document_type);
  }
  let contractorEmail = autoFields.contractor_email || "contractor@example.com";
  let contractorName = autoFields.contractor_name || "Contractor";
  const docLabel = getDocumentLabel(document_type);
  const files = [
    `data:application/pdf;base64,${templateBase64}`
  ];
  // [C1 2026-08-27] The `contract` document_type used to append the IC 24-5-11
  // compliance addendum here. That addendum is retired (see the tombstone above
  // generateRetailScopeOfWorkPdf). Nothing is appended in its place: this legacy
  // flow sends the contractor's own uploaded template and nothing else.
  //
  // Verified 2026-08-27 before removing it: NO caller anywhere in the codebase
  // sends document_type "contract". The live values are "contractor_sign"
  // (contractor-bid-form.html:5928, react-app contractor/sign page) and
  // "homeowner_sign" (contract-signing.html:1617, react-app contract-signing).
  // This branch was unreachable, so its removal changes no live envelope.
  // [D-274 / #631] No textTabs/homeownerTabs/contractorTabs equivalent —
  // see the "TAB-BUILDER FUNCTIONS RETIRED" comment above buildTextTabs's
  // old location for the full explanation. This legacy flow's own
  // contractor-uploaded template (getTemplateFromStorage, a DIFFERENT
  // storage convention from the D-199-manifest-validated contractor_sign
  // templates) has the SAME auto-fill/lock gap as the contractor_sign flow.
  const sendBody = {
    title: `${docLabel} — Otter Quotes (Job #${claim_id.slice(-8).toUpperCase()})`,
    files,
    // gh-1244: BoldSign's Signers[].Id must be a GUID, not a string label --
    // see the matching fix + comment in handleContractorSign above.
    signers: [
      {
        id: crypto.randomUUID(),
        name: signer.name,
        emailAddress: signer.email,
        signerOrder: 1,
        signerType: "Signer"
      },
      {
        id: crypto.randomUUID(),
        name: contractorName,
        emailAddress: contractorEmail,
        signerOrder: 2,
        signerType: "Signer"
      }
    ],
    enableSigningOrder: true,
    enableEmbeddedSigning: true,
    useTextTags: true,
    isSandbox: Deno.env.get("BOLDSIGN_SANDBOX") === "true",
    metaData: {
      claim_id,
      document_type
    }
  };
  console.log(`Creating BoldSign document (legacy: ${document_type})`);
  const sendResponse = await fetch(`${BOLDSIGN_API_BASE}/v1/document/send`, {
    method: "POST",
    headers: boldSignHeaders({
      "Content-Type": "application/json"
    }),
    body: JSON.stringify(sendBody)
  });
  if (!sendResponse.ok) {
    const errorData = await sendResponse.text();
    console.error("BoldSign document send failed:", errorData);
    throw new Error(`Failed to create document: ${sendResponse.status} ${errorData}`);
  }
  const sendData = await sendResponse.json();
  const envelopeId = sendData.documentId;
  if (!envelopeId) throw new Error("No documentId returned from BoldSign");
  console.log(`Document created (${document_type}): ${envelopeId}`);
  await sendGA4Event("envelope_sent", {
    document_type,
    envelope_id: envelopeId,
    claim_id
  });
  // gh-1244: bounded wait for BoldSign's async document creation to settle
  // before asking for a signing link -- see waitForBoldSignDocumentReady().
  await waitForBoldSignDocumentReady(envelopeId);
  const defaultReturnUrl = document_type === "project_confirmation" ? `https://otterquote.com/project-confirmation.html?claim_id=${claim_id}&signed=true` : "https://otterquote.com/contract-signing.html?signed=true";
  const signingReturnUrl = return_url || defaultReturnUrl;
  // gh-1244: camelCase param names -- see the matching fix + comment in
  // handleContractorSign above.
  const signLinkResponse = await fetch(
    `${BOLDSIGN_API_BASE}/v1/document/getEmbeddedSignLink?` + new URLSearchParams({
      documentId: envelopeId,
      signerEmail: signer.email,
      redirectUrl: signingReturnUrl
    }),
    {
      headers: boldSignHeaders()
    }
  );
  if (!signLinkResponse.ok) {
    const errorData = await signLinkResponse.text();
    throw new Error(`Failed to generate signing URL: ${signLinkResponse.status} ${errorData}`);
  }
  const signLinkData = await signLinkResponse.json();
  const signingUrl = signLinkData.signLink;
  if (!signingUrl) throw new Error("No signLink returned from BoldSign getEmbeddedSignLink");
  const updateData = {
    contract_sent_at: new Date().toISOString()
  };
  if (document_type === "contract") {
    updateData.docusign_envelope_id = envelopeId;
  } else if (document_type === "color_confirmation") {
    updateData.color_confirmation_envelope_id = envelopeId;
  } else if (document_type === "project_confirmation") {
    updateData.project_confirmation_envelope_id = envelopeId;
  }
  const { error: updateError } = await supabase.from("claims").update(updateData).eq("id", claim_id);
  if (updateError) {
    console.error("Failed to update claim:", updateError);
  }
  return new Response(JSON.stringify({
    success: true,
    envelope_id: envelopeId,
    signing_url: signingUrl,
    status: "sent",
    document_type,
    signer_email: signer.email
  }), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
// ========== MAIN HANDLER ==========
// ========== gh-1400: OPERATION SPLIT + HONEST RATE-LIMIT SURFACE ==========
// This endpoint has always done two jobs with wildly different costs, on one
// budget:
//
//   MINT   POST /v1/document/send. Creates a real BoldSign document. Costs
//          money and burns plan quota. Strict budget. Fails CLOSED.
//   RESUME GET /v1/document/getEmbeddedSignLink for a document that already
//          exists and that the authenticated caller is already a party to.
//          Costs nothing. It is also the ONLY way any signer ever reaches the
//          document, because enableEmbeddedSigning:true suppresses BoldSign's
//          invitation emails. Generous budget. Fails OPEN.
//
// Before gh-1400 both ran on the mint key, whose caller_id is the CLAIM_ID --
// so the budget was per claim, and a contractor who opened their contract and
// came back to it was locked out of their own signature for an hour behind
// "Edge Function returned a non-2xx status code".
const RATE_KEY_MINT = FUNCTION_NAME;
const RATE_KEY_RESUME = `${FUNCTION_NAME}:sign-link`;
function rateLimitKeyFor(operation: any) {
  return operation === "resume" ? RATE_KEY_RESUME : RATE_KEY_MINT;
}
// The whole defect in one function. Only the two signing document types can
// resume; the legacy one-shot documents (contract / color_confirmation /
// project_confirmation) have no resume semantics and always mint. A signing
// type with an envelope id already on its quote is ALWAYS a resume -- there is
// no condition under which we mint a second document for the same quote.
function resolveOperation(documentType: any, existingEnvelopeId: any) {
  if (documentType !== "contractor_sign" && documentType !== "homeowner_sign") return "mint";
  return existingEnvelopeId ? "resume" : "mint";
}
// check_rate_limit() denies by default when no rate_limit_config row exists.
// That default has produced this exact outage four times now (mark-job-complete,
// send-message-notification, send-partner-status-email, and this function). The
// RESUME key is brand new, so if its row is missing at deploy time the fetch
// path would 429 100% of the time -- the very failure this change exists to
// remove. Minting stays fail-closed; resuming spends nothing, so it fails open
// and says so loudly in the logs.
function isMissingConfigDenial(result: any) {
  return typeof result?.reason === "string" && result.reason.startsWith("No rate limit config found for function:");
}
// The 429 the signer sees must name a time they can act on. check_rate_limit()
// returns which ceiling was hit only in prose, and returns no reset instant at
// all, so we recover the window from the reason and compute the reset from the
// oldest still-counted call.
function resolveRateLimitWindow(reason: any) {
  const r = String(reason || "").toLowerCase();
  if (r.includes("hourly limit")) return "hour";
  if (r.includes("daily limit")) return "day";
  if (r.includes("monthly limit") || r.includes("budget cap")) return "month";
  return null;
}
// Mirrors Postgres interval arithmetic: '1 hour' and '1 day' are exact, and
// '1 month' is a calendar month that clamps rather than rolling over (Jan 31 +
// 1 month is Feb 28, not Mar 3).
function computeRetryAt(oldestCalledAt: any, window: any) {
  if (!oldestCalledAt || !window) return null;
  const t = Date.parse(oldestCalledAt);
  if (Number.isNaN(t)) return null;
  if (window === "hour") return new Date(t + 3600000).toISOString();
  if (window === "day") return new Date(t + 86400000).toISOString();
  if (window !== "month") return null;
  const d = new Date(t);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString();
}
// Start of the window check_rate_limit() is counting over, mirroring its
// interval arithmetic exactly. Deliberately not widened: a lookback wider than
// the real window would surface an older call and compute a retry_at that is
// too EARLY, sending the signer back into another 429.
function windowStartIso(window: any, now: any) {
  const d = new Date(now);
  if (window === "hour") return new Date(d.getTime() - 3600000).toISOString();
  if (window === "day") return new Date(d.getTime() - 86400000).toISOString();
  if (window !== "month") return null;
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString();
}
// The reset instant, recovered from the oldest call still inside the exhausted
// window. Matches check_rate_limit()'s own counting predicate: same key, same
// caller bucket, not blocked, inside the window. Only ever runs on the 429
// branch, so it costs nothing on the happy path.
async function computeRetryAtForCaller(supabase: any, rateKey: any, callerId: any, window: any) {
  const since = windowStartIso(window, Date.now());
  if (!since) return null;
  let q = supabase.from("rate_limits").select("called_at").eq("function_name", rateKey).eq("blocked", false).gt("called_at", since).order("called_at", {
    ascending: true
  }).limit(1);
  q = callerId ? q.eq("caller_id", callerId) : q.is("caller_id", null);
  const { data, error } = await q.maybeSingle();
  if (error || !data?.called_at) return null;
  return computeRetryAt(data.called_at, window);
}
// The sentence a signer actually reads. Kept here rather than on the page so
// there is one source of truth and it is covered by tests; contract-signing.html
// re-renders the clock time in the signer's own timezone and falls back to this
// string verbatim when it cannot.
function buildRateLimitMessage(window: any, retryAt: any, timeZone: any) {
  const opened = window === "hour" ? "You have opened this contract several times in the last hour." : window === "day" ? "You have opened this contract several times today." : window === "month" ? "This contract has been opened many times this month." : "This contract has been opened too many times recently.";
  const when = retryAt ? new Date(retryAt) : null;
  if (!when || Number.isNaN(when.getTime())) {
    return `${opened} Please try again a little later.`;
  }
  const opts: any = window === "hour" ? {
    hour: "numeric",
    minute: "2-digit"
  } : {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  };
  if (timeZone) opts.timeZone = timeZone;
  const stamp = window === "hour" ? when.toLocaleTimeString("en-US", opts) : when.toLocaleString("en-US", opts);
  return `${opened} Please try again at ${stamp}.`;
}
// Resolve the envelope this quote already has, if any. Same lookup the
// homeowner path has always used -- by quote_id first, then the newest quote on
// (claim_id, contractor_id) that carries one. maybeSingle() rather than
// single(): "no rows" is an ordinary answer here, not an error.
async function findExistingEnvelopeId(supabase: any, { quote_id, claim_id, contractor_id }: any) {
  if (quote_id) {
    const { data } = await supabase.from("quotes").select("docusign_envelope_id").eq("id", quote_id).maybeSingle();
    if (data?.docusign_envelope_id) return data.docusign_envelope_id;
  }
  if (!claim_id || !contractor_id) return null;
  const { data } = await supabase.from("quotes").select("docusign_envelope_id").eq("claim_id", claim_id).eq("contractor_id", contractor_id).not("docusign_envelope_id", "is", null).order("created_at", {
    ascending: false
  }).limit(1).maybeSingle();
  return data?.docusign_envelope_id || null;
}
// Issue an embedded signing link for a contractor on an existing document.
// Shared by the mint path (right after /v1/document/send) and the resume path
// (which reaches it without touching /v1/document/send at all).
async function issueContractorSignLink(supabase: any, { claim_id, envelopeId, signer, return_url, corsHeaders, resumed }: any) {
  const defaultReturnUrl = return_url || `https://otterquote.com/contractor-bid-form.html?claim_id=${claim_id}&signed=contractor`;
  // gh-1244: bounded wait for BoldSign's async document creation to settle
  // before asking for a signing link -- see waitForBoldSignDocumentReady().
  // On the resume path the document is long since settled and this is a no-op.
  await waitForBoldSignDocumentReady(envelopeId);
  // gh-1244: BoldSign's documented query params are camelCase (documentId,
  // signerEmail, redirectUrl), matching the official API docs.
  const signLinkResponse = await fetch(`${BOLDSIGN_API_BASE}/v1/document/getEmbeddedSignLink?` + new URLSearchParams({
    documentId: envelopeId,
    signerEmail: signer.email,
    redirectUrl: defaultReturnUrl
  }), {
    headers: boldSignHeaders()
  });
  if (!signLinkResponse.ok) {
    const errorData = await signLinkResponse.text();
    throw new Error(`Failed to generate contractor signing URL: ${signLinkResponse.status} ${errorData}`);
  }
  const signLinkData = await signLinkResponse.json();
  const signingUrl = signLinkData.signLink;
  if (!signingUrl) throw new Error("No signLink returned from BoldSign getEmbeddedSignLink");
  return new Response(JSON.stringify({
    success: true,
    envelope_id: envelopeId,
    signing_url: signingUrl,
    status: "sent",
    document_type: "contractor_sign",
    signer_email: signer.email,
    resumed: resumed === true
  }), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
serve(async (req)=>{
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = getServiceRoleKey();
  const supabase = createClient(supabaseUrl, supabaseKey);
  // ===== AUTH (86e1v6nnh) =====
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({
      error: "Unauthorized"
    }), {
      status: 401,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  const jwtToken = authHeader.slice(7);
  const { data: { user: caller }, error: authErr } = await supabase.auth.getUser(jwtToken);
  if (authErr || !caller) {
    return new Response(JSON.stringify({
      error: "Unauthorized: invalid token"
    }), {
      status: 401,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  const callerId = caller.id;
  try {
    const requestBody = await req.json();
    const { claim_id, document_type, contractor_id } = requestBody;
    if (!claim_id || !document_type || !contractor_id) {
      return new Response(JSON.stringify({
        error: "Missing required fields",
        required: [
          "claim_id",
          "document_type",
          "contractor_id"
        ]
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    const validDocTypes = [
      "contract",
      "contractor_sign",
      "homeowner_sign",
      "color_confirmation",
      "project_confirmation"
    ];
    if (!validDocTypes.includes(document_type)) {
      return new Response(JSON.stringify({
        error: `document_type must be one of: ${validDocTypes.join(", ")}`
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    // ===== CALLER AUTHORIZATION + SERVER-SIDE SIGNER IDENTITY (86e1v6nnh) =====
    // Derive signer name/email from authenticated identity — never trust the request body.
    let verifiedSigner;
    if (document_type === "contractor_sign") {
      // Caller must be the contractor for contractor_id.
      const { data: contractorRow, error: cErr } = await supabase.from("contractors").select("id, email, company_name, contact_name, user_id").eq("id", contractor_id).eq("user_id", callerId).maybeSingle();
      if (cErr || !contractorRow) {
        return new Response(JSON.stringify({
          error: "Forbidden: caller is not the contractor for this contractor_id"
        }), {
          status: 403,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        });
      }
      verifiedSigner = {
        email: contractorRow.email || "",
        name: contractorRow.company_name || contractorRow.contact_name || "Contractor"
      };
      if (!verifiedSigner.email) {
        return new Response(JSON.stringify({
          error: "Contractor profile has no email on file"
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        });
      }
    } else {
      // homeowner_sign / contract / color_confirmation / project_confirmation:
      // Caller must own the claim.
      const { data: claimRow, error: claimErr } = await supabase.from("claims").select("user_id").eq("id", claim_id).single();
      if (claimErr || !claimRow || claimRow.user_id !== callerId) {
        return new Response(JSON.stringify({
          error: "Forbidden: caller does not own this claim"
        }), {
          status: 403,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        });
      }
      // Derive homeowner identity from profiles.
      const { data: profileRow } = await supabase.from("profiles").select("full_name, email").eq("id", callerId).single();
      verifiedSigner = {
        email: profileRow?.email || caller.email || "",
        name: profileRow?.full_name || ""
      };
      if (!verifiedSigner.email) {
        return new Response(JSON.stringify({
          error: "Could not resolve homeowner email from profile"
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        });
      }
    }
    // Replace request-body signer with server-derived identity.
    requestBody.signer = verifiedSigner;
    // ===== gh-1400: resolve the OPERATION before spending any budget =====
    // homeowner_sign has never minted -- it has always resumed the document the
    // quote already points at. contractor_sign minted unconditionally, which is
    // why re-entering the page produced a SECOND BoldSign document and orphaned
    // the first (32e83466 on claim 82f5dff4). Both now resolve identically: if
    // the quote already carries an envelope id, this is a resume.
    //
    // "Explicitly voided" is expressed as quotes.docusign_envelope_id = NULL.
    // Clearing the pointer is what re-enables minting; nothing else does.
    let resolvedEnvelopeId = null;
    if (document_type === "homeowner_sign" || document_type === "contractor_sign") {
      resolvedEnvelopeId = await findExistingEnvelopeId(supabase, {
        quote_id: requestBody.quote_id,
        claim_id,
        contractor_id
      });
    }
    const operation = resolveOperation(document_type, resolvedEnvelopeId);
    // Server-derived, overwritten unconditionally -- never caller-supplied.
    requestBody.resolved_envelope_id = resolvedEnvelopeId;
    requestBody.operation = operation;
    {
      const rateKey = rateLimitKeyFor(operation);
      const { data: rateLimitResult, error: rlError } = await supabase.rpc("check_rate_limit", {
        p_function_name: rateKey,
        p_caller_id: claim_id || null
      });
      if (rlError) {
        console.error(`Rate limit check failed [${rateKey}]:`, rlError);
        // Minting is fail-closed: if the budget cannot be verified we do not
        // spend money. Resuming is fail-open: it spends nothing, and refusing a
        // signer entry to their own executed-but-unsigned contract is precisely
        // the outage this change exists to remove.
        if (operation === "mint") {
          return new Response(JSON.stringify({
            error: "Rate limit check failed. Refusing to create envelope for safety.",
            detail: rlError.message
          }), {
            status: 503,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json"
            }
          });
        }
        console.warn(`RATE LIMIT UNAVAILABLE [${rateKey}]: allowing resume, no vendor cost.`);
      } else if (!rateLimitResult?.allowed && operation === "resume" && isMissingConfigDenial(rateLimitResult)) {
        console.error(`RATE LIMIT CONFIG MISSING [${rateKey}]: allowing resume anyway. Insert the rate_limit_config row for this key -- see gh-1400.`);
      } else if (!rateLimitResult?.allowed) {
        const limitWindow = resolveRateLimitWindow(rateLimitResult?.reason);
        const retryAt = await computeRetryAtForCaller(supabase, rateKey, claim_id || null, limitWindow);
        console.warn(`RATE LIMITED [${rateKey}] op=${operation}: ${rateLimitResult?.reason} retry_at=${retryAt}`);
        return new Response(JSON.stringify({
          error: "Rate limit exceeded",
          reason: rateLimitResult?.reason,
          counts: rateLimitResult?.counts,
          operation,
          window: limitWindow,
          retry_at: retryAt,
          message: buildRateLimitMessage(limitWindow, retryAt, "UTC")
        }), {
          status: 429,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        });
      }
    }
    // [D-274 / #631] No token-acquisition step — BoldSign auth is a plain
    // API key, checked lazily by getBoldSignApiKey() the first time a
    // handler actually calls out to BoldSign (so a request that fails
    // earlier — bad input, auth, rate limit — never even touches the
    // secret). This replaces the DocuSign JWT-grant token fetch that used
    // to happen unconditionally here for every request.
    if (!Deno.env.get("BOLDSIGN_API")) {
      throw new Error("BoldSign credentials not configured. Set BOLDSIGN_API.");
    }
    switch(document_type){
      case "contractor_sign":
        return await handleContractorSign(supabase, requestBody, corsHeaders);
      case "homeowner_sign":
        return await handleHomeownerSign(supabase, requestBody, corsHeaders);
      case "contract":
      case "color_confirmation":
      case "project_confirmation":
        return await handleLegacyFlow(supabase, requestBody, corsHeaders);
      default:
        throw new Error(`Unhandled document type: ${document_type}`);
    }
  } catch (error) {
    console.error("create-docusign-envelope error:", error);
    if (error instanceof DocumentTooLargeError) {
      return new Response(JSON.stringify({
        error: error.code,
        message: error.message
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    const message = error instanceof Error ? error.message : "An unexpected error occurred";
    return new Response(JSON.stringify({
      error: message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
});
