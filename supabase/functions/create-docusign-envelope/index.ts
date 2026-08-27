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
  const raw = bidData.message_to_homeowner ?? bidData.contractor_message ?? null;
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
          predominantPitch: hm.predominant_pitch ?? null
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

// ========== RETAIL SCOPE OF WORK PDF ==========
function generateRetailScopeOfWorkPdf(params) {
  const { homeownerName, contractorName, propertyAddress, claimId, trades, contractPrice, estimatedStartDate, valueAdds, bidBrand, deckingPricePerSheet, fullRedeckPrice, messageToHomeowner, homeownerNotes, projectConfirmation, measurements, contractDate, fundingType } = params;
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
      .replace(/ /g, " ");
    s = s.replace(/[^\x20-\x7E]/g, "");
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
  // ===== MEASUREMENT SUMMARY (from Hover) + LINE-ITEM SCOPE (roofing) =====
  const m = measurements || {};
  const r0 = (n) => (n == null || Number.isNaN(Number(n))) ? null : Math.round(Number(n));
  const sq = (m.squares != null && !Number.isNaN(Number(m.squares)))
    ? Number(m.squares)
    : (m.roofAreaSf != null ? Math.round((Number(m.roofAreaSf) / 100) * 10) / 10 : null);
  const roofAreaSf = (m.roofAreaSf != null) ? Number(m.roofAreaSf) : (sq != null ? Math.round(sq * 100) : null);
  const rh = r0(m.ridgeHipLf), vv = r0(m.valleyLf), rk = r0(m.rakeLf), ev = r0(m.eaveLf),
        drip = r0(m.dripEdgeLf), st = r0(m.stepFlashingLf), fl = r0(m.flashingLf);
  const hasRoofMeasurements = !!(m && (m.roofAreaSf != null || m.squares != null || m.ridgeHipLf != null ||
    m.valleyLf != null || m.rakeLf != null || m.eaveLf != null || m.dripEdgeLf != null ||
    m.stepFlashingLf != null || m.flashingLf != null));
  if (hasRoofing && hasRoofMeasurements) {
    ensure(34);
    addText(LEFT_X, y, 12, "F2", "MEASUREMENT SUMMARY (from Hover)");
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
    sumRow("Ridges / Hips:", m.ridgeHipLf != null ? `${m.ridgeHipLf} LF` : null);
    sumRow("Valleys:", m.valleyLf != null ? `${m.valleyLf} LF` : null);
    sumRow("Eaves:", m.eaveLf != null ? `${m.eaveLf} LF` : null);
    sumRow("Rakes:", m.rakeLf != null ? `${m.rakeLf} LF` : null);
    sumRow("Drip edge / perimeter:", m.dripEdgeLf != null ? `${m.dripEdgeLf} LF` : null);
    sumRow("Step flashing:", m.stepFlashingLf != null ? `${m.stepFlashingLf} LF` : null);
    sumRow("Headwall / apron flashing:", m.flashingLf != null ? `${m.flashingLf} LF` : null);
    sumRow("Predominant pitch:", m.predominantPitch || null);
    y -= 6;
    hLine(y);
    y -= 16;
    // ---- LINE-ITEM SCOPE table (quantities only; no unit prices) ----
    addText(LEFT_X, y, 12, "F2", "LINE-ITEM SCOPE");
    y -= 8;
    addText(LEFT_X, y, 8, "F1", "Quantities derived from Hover aerial measurements. Field-verified items confirmed on site. No unit pricing shown.");
    y -= 14;
    const colNum = 50, colItem = 66, colQty = 246, colUnit = 286, colBasis = 330, colNotes = 448;
    const itemMaxChars = 44, notesMaxChars = 28;
    const drawTableHeader = () => {
      ensure(18);
      addText(colNum, y, 8, "F2", "#");
      addText(colItem, y, 8, "F2", "Work Item");
      addText(colQty, y, 8, "F2", "Qty");
      addText(colUnit, y, 8, "F2", "Unit");
      addText(colBasis, y, 8, "F2", "Hover Basis");
      addText(colNotes, y, 8, "F2", "Notes");
      y -= 3;
      hLine(y);
      y -= 11;
    };
    const qtyStr = (val) => (val == null ? "per bid" : String(val));
    const areaWaste = (sq != null) ? Math.ceil(sq * 1.1) : null; // area items + 10% waste (SQ)
    const iceWater = (vv != null && ev != null) ? (vv + ev) : null;   // valleys + eaves
    const starter = (ev != null && rk != null) ? (ev + rk) : null;    // eaves + rakes
    const rows = [
      { num: 1, item: "Tear off & dispose existing roofing (all layers)", qty: qtyStr(areaWaste), unit: "SQ", basis: "Roof area +10%", notes: "Haul-off included" },
      { num: 2, item: `Architectural laminate shingles - ${bidBrand || "per bid"}`, qty: qtyStr(areaWaste), unit: "SQ", basis: "Roof area +10%", notes: "Per mfr. spec" },
      { num: 3, item: "Synthetic underlayment", qty: qtyStr(areaWaste), unit: "SQ", basis: "Roof area +10%", notes: "Full coverage" },
      { num: 4, item: "Ice & water shield - valleys + eaves", qty: qtyStr(iceWater), unit: "LF", basis: `Valleys ${vv != null ? vv : "?"} + eaves ${ev != null ? ev : "?"}`, notes: "Code / leak-prone areas" },
      { num: 5, item: "Starter course", qty: qtyStr(starter), unit: "LF", basis: `Eaves ${ev != null ? ev : "?"} + rakes ${rk != null ? rk : "?"}`, notes: "Eaves & rakes" },
      { num: 6, item: "Hip & ridge cap shingles", qty: qtyStr(rh), unit: "LF", basis: `Ridges/Hips ${rh != null ? rh : "?"}`, notes: "Matching profile" },
      { num: 7, item: "Drip edge", qty: qtyStr(drip), unit: "LF", basis: `Perimeter ${drip != null ? drip : "?"}`, notes: "Eaves & rakes" },
      { num: 8, item: "Closed-cut valley", qty: qtyStr(vv), unit: "LF", basis: `Valleys ${vv != null ? vv : "?"}`, notes: "Per mfr." },
      { num: 9, item: "Step flashing (roof-to-wall)", qty: qtyStr(st), unit: "LF", basis: `Step flashing ${st != null ? st : "?"}`, notes: "Replace" },
      { num: 10, item: "Headwall / apron flashing", qty: qtyStr(fl), unit: "LF", basis: `Flashing ${fl != null ? fl : "?"}`, notes: "Replace" },
      { num: 11, item: "Pipe boots / penetration flashings", qty: "field", unit: "EA", basis: "Field-verified", notes: "Count confirmed on site" },
      { num: 12, item: "Roof/exhaust vents", qty: "field", unit: "EA", basis: "Field-verified", notes: "Reset or replace" },
      // [C3 2026-08-27] Rates removed -- decking and full re-deck are stated once,
      // in CONTINGENCIES AND CONDITIONAL PRICING, each beside its trigger.
      { num: 13, item: "Decking replacement allowance", qty: "as req'd", unit: "SHEET", basis: "-", notes: "See Contingencies" },
    ];
    drawTableHeader();
    const lineH = 10;
    for (const row of rows) {
      const itemLines = wrapToLines(row.item, itemMaxChars);
      const noteLines = wrapToLines(row.notes, notesMaxChars);
      const nLines = Math.max(1, itemLines.length, noteLines.length);
      const rowH = nLines * lineH + 2;
      const pagesBefore = pages.length;
      ensure(rowH);
      if (pages.length > pagesBefore) { drawTableHeader(); }
      const topY = y;
      addText(colNum, topY, 8, "F1", String(row.num));
      itemLines.forEach((ln, k) => addText(colItem, topY - k * lineH, 8, "F1", ln));
      addText(colQty, topY, 8, "F1", row.qty);
      addText(colUnit, topY, 8, "F1", row.unit);
      addText(colBasis, topY, 8, "F1", row.basis);
      noteLines.forEach((ln, k) => addText(colNotes, topY - k * lineH, 8, "F1", ln));
      y = topY - rowH;
    }
    y -= 4;
    hLine(y);
    y -= 16;
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
    addText(60, y, 10, "F1", "Scope per contractor bid and Hover design specifications.");
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
  if (Array.isArray(va.warranties) && va.warranties.length > 0) {
    ensure(28);
    hLine(y + 4);
    y -= 12;
    addText(LEFT_X, y, 12, "F2", "WARRANTIES");
    y -= 14;
    for (const w of va.warranties) {
      if (!w.name) continue;
      ensure(24);
      addText(60, y, 10, "F2", w.name);
      y -= 12;
      if (w.material_defects?.years) { addText(70, y, 9, "F1", `Material Defects: ${w.material_defects.years} yrs`); y -= 11; }
      if (w.labor?.years) { addText(70, y, 9, "F1", `Labor: ${w.labor.years} yrs`); y -= 11; }
      if (w.wind_damage?.years) { addText(70, y, 9, "F1", `Wind: ${w.wind_damage.years} yrs`); y -= 11; }
      if (w.hail_damage?.years) { addText(70, y, 9, "F1", `Hail: ${w.hail_damage.years} yrs`); y -= 11; }
      y -= 4;
    }
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
    if (rows.length > 0) {
      ensure(40);
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
  const fields = {};
  if (claimData) {
    fields.customer_name = homeownerProfile.fullName;
    fields.customer_address = claimData.property_address || claimData.address_line1 || "";
    fields.customer_city_zip = `${claimData.address_city || ""}, ${claimData.address_state || ""} ${claimData.address_zip || ""}`.trim();
    fields.customer_phone = claimData.phone || "";
    fields.customer_email = signerEmail || "";
    // #514: claims has no `insurance_carrier` column — read carrier_name
    // (written by parse-loss-sheet), with the legacy name as a fallback.
    fields.insurance_company = claimData.carrier_name || claimData.insurance_carrier || "";
    fields.claim_number = claimData.claim_number || "";
    fields.deductible = claimData.deductible_amount ? `$${Number(claimData.deductible_amount).toLocaleString()}` : "";
    fields.contract_date = new Date().toLocaleDateString("en-US");
    fields.job_description = claimData.damage_type ? `Roof ${claimData.damage_type}` : "Roof Replacement";
    fields.material_type = claimData.material_product || bidData?.brand || "";
  }
  if (bidData) {
    fields.contract_price = bidData.amount ? `$${Number(bidData.amount).toLocaleString()}` : "";
    fields.warranty_years = bidData.warranty_years ? `${bidData.warranty_years} years` : "";
    fields.estimated_start = bidData.estimated_start_date || "";
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
        fundingType
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
  // gh-1244: bounded wait for BoldSign's async document creation to settle
  // before asking for a signing link -- see waitForBoldSignDocumentReady().
  await waitForBoldSignDocumentReady(envelopeId);
  const defaultReturnUrl = return_url || `https://otterquote.com/contractor-bid-form.html?claim_id=${claim_id}&signed=contractor`;
  // gh-1244: BoldSign's documented query params are camelCase (documentId,
  // signerEmail, redirectUrl), matching the official API docs. Fixed
  // regardless of whether it's the full explanation for the "Invalid
  // Document ID" 403 seen in the sandbox E2E run -- see gh-1244 comments for
  // the open investigation (BOLDSIGN_SANDBOX confirmed unset; document
  // creation confirmed succeeding with a real documentId moments before this
  // call rejects that same ID).
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
    throw new Error(`Failed to generate contractor signing URL: ${signLinkResponse.status} ${errorData}`);
  }
  const signLinkData = await signLinkResponse.json();
  const signingUrl = signLinkData.signLink;
  if (!signingUrl) throw new Error("No signLink returned from BoldSign getEmbeddedSignLink");
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
  return new Response(JSON.stringify({
    success: true,
    envelope_id: envelopeId,
    signing_url: signingUrl,
    status: "sent",
    document_type: "contractor_sign",
    signer_email: signer.email
  }), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
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
    if (document_type !== "homeowner_sign") {
      const { data: rateLimitResult, error: rlError } = await supabase.rpc("check_rate_limit", {
        p_function_name: FUNCTION_NAME,
        p_caller_id: claim_id || null
      });
      if (rlError) {
        console.error("Rate limit check failed:", rlError);
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
      if (!rateLimitResult?.allowed) {
        console.warn(`RATE LIMITED [${FUNCTION_NAME}]: ${rateLimitResult?.reason}`);
        return new Response(JSON.stringify({
          error: "Rate limit exceeded",
          reason: rateLimitResult?.reason,
          counts: rateLimitResult?.counts
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
