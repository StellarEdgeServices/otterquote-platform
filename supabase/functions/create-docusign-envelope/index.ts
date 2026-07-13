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
let cachedToken = null;
// ========== JWT GENERATION & BASE64URL UTILITIES ==========
function base64urlEncode(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(str) {
  const padded = str + "=".repeat((4 - str.length % 4) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return new Uint8Array(binary.split("").map((c)=>c.charCodeAt(0)));
}
// ASN.1 DER helper for PKCS#1 -> PKCS#8 wrapping
function encodeAsn1TLV(tag, content) {
  const len = content.length;
  let header;
  if (len < 128) {
    header = new Uint8Array([
      tag,
      len
    ]);
  } else if (len < 256) {
    header = new Uint8Array([
      tag,
      0x81,
      len
    ]);
  } else {
    header = new Uint8Array([
      tag,
      0x82,
      len >> 8 & 0xff,
      len & 0xff
    ]);
  }
  const out = new Uint8Array(header.length + len);
  out.set(header, 0);
  out.set(content, header.length);
  return out;
}
function wrapPkcs1InPkcs8(pkcs1Der) {
  // AlgorithmIdentifier SEQUENCE { OID rsaEncryption, NULL }
  const algId = new Uint8Array([
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00
  ]);
  const version = new Uint8Array([
    0x02,
    0x01,
    0x00
  ]);
  const octetString = encodeAsn1TLV(0x04, pkcs1Der);
  const inner = new Uint8Array(version.length + algId.length + octetString.length);
  inner.set(version, 0);
  inner.set(algId, version.length);
  inner.set(octetString, version.length + algId.length);
  return encodeAsn1TLV(0x30, inner);
}
async function importRsaPrivateKey(pemBase64) {
  const b64 = pemBase64.replace(/-----BEGIN[^-]*-----/g, "").replace(/-----END[^-]*-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c)=>c.charCodeAt(0));
  const algo = {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256"
  };
  // Try PKCS#8 first; fall back to wrapping PKCS#1 (SP #5 — DocuSign key is PKCS#1 format)
  try {
    return await crypto.subtle.importKey("pkcs8", der, algo, false, [
      "sign"
    ]);
  } catch  {
    return await crypto.subtle.importKey("pkcs8", wrapPkcs1InPkcs8(der), algo, false, [
      "sign"
    ]);
  }
}
async function createJwtAssertion(integrationKey, userId, baseUrl) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600;
  const aud = baseUrl.includes("demo") || baseUrl.includes("account-d") ? "account-d.docusign.com" : "account.docusign.com";
  const payload = {
    iss: integrationKey,
    sub: userId,
    aud,
    iat: now,
    exp,
    scope: "signature impersonation"
  };
  const header = {
    alg: "RS256",
    typ: "JWT"
  };
  const headerEncoded = base64urlEncode(JSON.stringify(header));
  const payloadEncoded = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${headerEncoded}.${payloadEncoded}`;
  const rsaPrivateKeyB64 = Deno.env.get("DOCUSIGN_RSA_PRIVATE_KEY");
  if (!rsaPrivateKeyB64) {
    throw new Error("DOCUSIGN_RSA_PRIVATE_KEY not configured. Please set this environment variable with a base64-encoded RSA private key in PEM format.");
  }
  const cryptoKey = await importRsaPrivateKey(rsaPrivateKeyB64);
  const signatureBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
  const signatureEncoded = base64urlEncode(new Uint8Array(signatureBuffer));
  return `${signingInput}.${signatureEncoded}`;
}
// ========== TOKEN MANAGEMENT ==========
async function getAccessToken(baseUrl) {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 300000) {
    console.log("Using cached DocuSign access token");
    return cachedToken;
  }
  console.log("Fetching new DocuSign access token via JWT grant flow");
  const integrationKey = Deno.env.get("DOCUSIGN_INTEGRATION_KEY");
  const userId = Deno.env.get("DOCUSIGN_USER_ID");
  if (!integrationKey || !userId) {
    throw new Error("DocuSign JWT auth not configured. Set DOCUSIGN_INTEGRATION_KEY and DOCUSIGN_USER_ID.");
  }
  const jwtAssertion = await createJwtAssertion(integrationKey, userId, baseUrl);
  const oauthHost = baseUrl.includes("demo") || baseUrl.includes("account-d") ? "https://account-d.docusign.com" : "https://account.docusign.com";
  const tokenResponse = await fetch(`${oauthHost}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwtAssertion}`
  });
  if (!tokenResponse.ok) {
    const errorData = await tokenResponse.text();
    console.error("DocuSign token request failed:", errorData);
    throw new Error(`DocuSign token request failed: ${tokenResponse.status} ${errorData}`);
  }
  const tokenData = await tokenResponse.json();
  const accessToken = tokenData.access_token;
  if (!accessToken) {
    throw new Error("No access_token in DocuSign response");
  }
  console.log("Fetching DocuSign account info via /oauth/userinfo");
  const userInfoResponse = await fetch(`${oauthHost}/oauth/userinfo`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!userInfoResponse.ok) {
    const errText = await userInfoResponse.text();
    throw new Error(`DocuSign userinfo request failed: ${userInfoResponse.status} ${errText}`);
  }
  const userInfo = await userInfoResponse.json();
  const account = userInfo.accounts?.find((a)=>a.is_default) || userInfo.accounts?.[0];
  if (!account?.account_id) {
    throw new Error(`Could not determine DocuSign account ID from userinfo: ${JSON.stringify(userInfo)}`);
  }
  const resolvedBaseUri = account.base_uri || baseUrl;
  console.log(`DocuSign account ID: ${account.account_id}, base_uri: ${resolvedBaseUri}`);
  cachedToken = {
    accessToken,
    accountId: account.account_id,
    baseUri: resolvedBaseUri,
    expiresAt: now + 3600000 - 300000
  };
  return cachedToken;
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
// ========== IC 24-5-11 COMPLIANCE ADDENDUM PDF ==========
function generateComplianceAddendumPdf(contractorName, homeownerName, contractDate) {
  const lines = [];
  const objects = [];
  let currentOffset = 0;
  function write(s) {
    lines.push(s);
    currentOffset += s.length + 1;
  }
  function startObject(num) {
    objects[num] = {
      offset: currentOffset
    };
    write(`${num} 0 obj`);
  }
  const signDate = new Date(contractDate || new Date().toISOString());
  let businessDays = 0;
  const cancelDate = new Date(signDate);
  while(businessDays < 3){
    cancelDate.setDate(cancelDate.getDate() + 1);
    const dow = cancelDate.getDay();
    if (dow !== 0 && dow !== 6) businessDays++;
  }
  const cancelDateStr = cancelDate.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric"
  });
  const contentLines = [];
  function addText(x, y, fontSize, font, text) {
    const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    contentLines.push(`BT /${font} ${fontSize} Tf ${x} ${y} Td (${escaped}) Tj ET`);
  }
  function addWrappedText(x, startY, fontSize, font, text, maxWidth) {
    const charWidth = fontSize * 0.5;
    const maxChars = Math.floor(maxWidth / charWidth);
    const words = text.split(" ");
    let currentLine = "";
    let y = startY;
    const lineSpacing = fontSize * 1.4;
    for (const word of words){
      if (currentLine.length + word.length + 1 > maxChars) {
        addText(x, y, fontSize, font, currentLine.trim());
        y -= lineSpacing;
        currentLine = word + " ";
      } else {
        currentLine += word + " ";
      }
    }
    if (currentLine.trim()) {
      addText(x, y, fontSize, font, currentLine.trim());
      y -= lineSpacing;
    }
    return y;
  }
  let y = 750;
  addText(50, y, 14, "F2", "INDIANA HOME IMPROVEMENT CONTRACT ACT ADDENDUM");
  y -= 20;
  addText(50, y, 10, "F1", `IC 24-5-11 Compliance Addendum — Contract Date: ${contractDate || new Date().toLocaleDateString("en-US")}`);
  y -= 10;
  contentLines.push(`50 ${y} m 562 ${y} l S`);
  y -= 20;
  addText(50, y, 12, "F2", "STATEMENT OF RIGHT TO CANCEL");
  y -= 20;
  const statementText = `You may cancel this contract at any time before midnight on the third business day after the later of the following: (A) The date this contract is signed by you and ${contractorName}. (B) If applicable, the date you receive written notification from your insurance company of a final determination as to whether all or any part of your claim or this contract is a covered loss under your insurance policy. See attached notice of cancellation form for an explanation of this right.`;
  y = addWrappedText(50, y, 10, "F2", statementText, 512);
  y -= 15;
  contentLines.push(`50 ${y + 5} m 562 ${y + 5} l S`);
  y -= 15;
  addText(50, y, 12, "F2", "NOTICE OF CANCELLATION");
  y -= 20;
  addText(50, y, 10, "F2", `Contract Date: ${contractDate || "_______________"}`);
  y -= 16;
  y = addWrappedText(50, y, 10, "F2", `You may CANCEL this transaction, without any penalty or obligation, within THREE (3) BUSINESS DAYS from the above date, or if applicable, within three (3) business days from the date you receive written notification from your insurance company of a final determination as to whether all or any part of your claim or this contract is a covered loss under your insurance policy.`, 512);
  y -= 10;
  y = addWrappedText(50, y, 10, "F2", `If you cancel, any property traded in, any payments made by you under the contract, and any negotiable instrument executed by you will be returned within TEN (10) BUSINESS DAYS following receipt by the contractor of your cancellation notice, and any security interest arising out of the transaction will be cancelled.`, 512);
  y -= 10;
  y = addWrappedText(50, y, 10, "F2", `If you cancel, you must make available to the contractor at your residence, in substantially as good condition as when received, any goods delivered to you under this contract. Or you may, if you wish, comply with the instructions of the contractor regarding the return shipment of the goods at the contractor's expense and risk.`, 512);
  y -= 10;
  y = addWrappedText(50, y, 10, "F1", `To cancel this transaction, mail, deliver, or email a signed and dated copy of this cancellation notice, or any other written notice to:`, 512);
  y -= 5;
  addText(70, y, 10, "F2", contractorName);
  y -= 14;
  addText(70, y, 10, "F1", "(Contractor name and contact information as provided in this contract)");
  y -= 20;
  addText(50, y, 10, "F2", "I HEREBY CANCEL THIS TRANSACTION.");
  y -= 25;
  addText(50, y, 10, "F1", "Homeowner Signature: ___________________________________    Date: ________________");
  y -= 20;
  addText(50, y, 10, "F1", `Homeowner Name (printed): ${homeownerName}`);
  y -= 30;
  contentLines.push(`50 ${y + 5} m 562 ${y + 5} l S`);
  y -= 15;
  addText(50, y, 12, "F2", "PLATFORM DISCLOSURE");
  y -= 20;
  y = addWrappedText(50, y, 10, "F1", `Otter Quotes is a technology platform that facilitates connections between homeowners and contractors. Otter Quotes is NOT a party to this contract and assumes no liability for work performed under this agreement. This contract is between the homeowner and the contractor named above.`, 512);
  y -= 10;
  addText(50, y, 10, "F1", `Down payment may not exceed $1,000 or 10% of contract price, whichever is less (IC 24-5-11-12).`);
  y -= 30;
  addText(50, y, 8, "F1", "This addendum is generated by Otter Quotes to comply with Indiana Code IC 24-5-11 (Home Improvement Contract Act).");
  y -= 12;
  addText(50, y, 8, "F1", `Generated: ${new Date().toISOString()}`);
  const contentStream = contentLines.join("\n");
  const contentBytes = new TextEncoder().encode(contentStream);
  const pdfLines = [];
  const pdfObjects = [];
  let byteOffset = 0;
  function pdfWrite(s) {
    pdfLines.push(s);
    byteOffset += s.length + 1;
  }
  function pdfStartObj(n) {
    pdfObjects[n] = byteOffset;
    pdfWrite(`${n} 0 obj`);
  }
  pdfWrite("%PDF-1.4");
  pdfStartObj(1);
  pdfWrite("<< /Type /Catalog /Pages 2 0 R >>");
  pdfWrite("endobj");
  pdfStartObj(2);
  pdfWrite("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  pdfWrite("endobj");
  pdfStartObj(3);
  pdfWrite("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>");
  pdfWrite("endobj");
  pdfStartObj(4);
  pdfWrite(`<< /Length ${contentStream.length} >>`);
  pdfWrite("stream");
  pdfWrite(contentStream);
  pdfWrite("endstream");
  pdfWrite("endobj");
  pdfStartObj(5);
  pdfWrite("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pdfWrite("endobj");
  pdfStartObj(6);
  pdfWrite("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  pdfWrite("endobj");
  const xrefOffset = byteOffset;
  pdfWrite("xref");
  pdfWrite(`0 7`);
  pdfWrite("0000000000 65535 f ");
  for(let i = 1; i <= 6; i++){
    pdfWrite(String(pdfObjects[i]).padStart(10, "0") + " 00000 n ");
  }
  pdfWrite("trailer");
  pdfWrite(`<< /Size 7 /Root 1 0 R >>`);
  pdfWrite("startxref");
  pdfWrite(String(xrefOffset));
  pdfWrite("%%EOF");
  const pdfContent = pdfLines.join("\n");
  const pdfBytes = new TextEncoder().encode(pdfContent);
  return base64EncodeBinary(pdfBytes);
}
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
  const { homeownerName, contractorName, propertyAddress, claimId, trades, contractPrice, estimatedStartDate, valueAdds, bidBrand, deckingPricePerSheet, fullRedeckPrice, messageToHomeowner, homeownerNotes, projectConfirmation, measurements, contractDate } = params;
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
  // [D-225 Phase 2B / D-186] Render text in a chosen non-stroking gray (1.0 = white =
  // invisible on white paper). Used to embed DocuSign anchor strings invisibly.
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
  addText(LEFT_X, y, 9, "F1", `Prepared by Otter Quotes on behalf of ${contractorName}`);
  y -= 10;
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
  addText(160, y, 10, "F1", "Retail / Homeowner-Financed");
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
    const deckingTxt = (deckingPricePerSheet != null) ? `${fmt$(deckingPricePerSheet)}/sheet` : "per bid";
    const redeckTxt = (fullRedeckPrice != null) ? fmt$(fullRedeckPrice) : "per bid";
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
      { num: 13, item: "Decking replacement allowance", qty: "as req'd", unit: "SHEET", basis: "-", notes: `${deckingTxt}; full re-deck ${redeckTxt}` },
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
      const ventDesc = va.ventilation.ridge_vent_included ? "Ridge Vent - Included" : va.ventilation.ridge_vent_oop ? `Ridge Vent - OOP ${fmt$(va.ventilation.ridge_vent_oop)}` : null;
      if (ventDesc) {
        ensure(14);
        addText(60, y, 10, "F2", "Ventilation:");
        addText(160, y, 10, "F1", ventDesc);
        y -= 14;
      }
    }
    if (deckingPricePerSheet) {
      const redeckTxt2 = fullRedeckPrice ? `${fmt$(deckingPricePerSheet)}/sheet if needed; Full redeck: ${fmt$(fullRedeckPrice)}` : `${fmt$(deckingPricePerSheet)}/sheet if needed`;
      ensure(14);
      addText(60, y, 10, "F2", "Decking:");
      y = addWrappedText(160, y, 10, "F1", redeckTxt2, 380);
    }
    if (va.chimney_flashing?.option && va.chimney_flashing.option !== "na") {
      const cfMap = { reuse: "Reuse existing", replace: "Replace - Included", replace_oop: `Replace OOP ${fmt$(va.chimney_flashing.oop_price)}` };
      ensure(14);
      addText(60, y, 10, "F2", "Chimney Flashing:");
      addText(160, y, 10, "F1", cfMap[va.chimney_flashing.option] || String(va.chimney_flashing.option));
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
  const slc = va?.secondLayerContingency;
  if (hasRoofing && slc) {
    const slcAmount = slc.method === "flat_fee" && slc.flatFeeAlternative != null ? slc.flatFeeAlternative : slc.pricePerSquare;
    if (slcAmount != null) {
      const slcPhrase = slc.method === "flat_fee" ? "flat fee" : "per square";
      const slcDisclaimer = `If the existing roof is found to contain more than one layer of shingles, the contract price will increase by ${fmt$(slcAmount)} ${slcPhrase}. ` + `Customer will be notified before work proceeds and has the right to accept the change order or cancel the Agreement per the Change Order Disclaimer.`;
      ensure(28);
      addText(LEFT_X, y, 11, "F2", "SECOND-LAYER TEAR-OFF CONTINGENCY");
      y -= 14;
      y = addWrappedText(60, y, 10, "F1", slcDisclaimer, 480);
      y -= 8;
    }
  }
  if (hasGutters) {
    ensure(20);
    addText(LEFT_X, y, 11, "F2", "GUTTERS");
    y -= 14;
    if (va.gutters?.option) {
      const go = va.gutters.option;
      let gutterDesc = String(go);
      if (go === "5inch_included" || go === "5inch") gutterDesc = '5" Gutters - Included';
      else if (go === "6inch_included" || go === "6inch") gutterDesc = '6" Gutters - Included';
      else if (go.includes("5inch") && go.includes("additional")) gutterDesc = `5" Gutters - OOP ${fmt$(va.gutters.additional_cost_5inch)}`;
      else if (go.includes("6inch") && go.includes("additional")) gutterDesc = `6" Gutters - OOP ${fmt$(va.gutters.additional_cost_6inch)}`;
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
        const parts = [];
        if (gg.mesh_oop) parts.push(`Mesh OOP ${fmt$(gg.mesh_oop)}`);
        if (gg.screw_in_oop) parts.push(`Screw-in OOP ${fmt$(gg.screw_in_oop)}`);
        ensure(14);
        addText(60, y, 10, "F2", "Gutter Guards:");
        addText(160, y, 10, "F1", parts.join("; "));
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
  // [D-225 Phase 2B / D-186] Dual-party initials anchor row. The visible labels
  // (Contractor / Homeowner) sit beside blank underscores; the /ContractorInitial/
  // and /HomeownerInitial/ anchor strings are drawn in white at the same x so they
  // are invisible on paper but findable by DocuSign's anchor parser.
  ensure(46);
  y -= 18;
  hLine(y + 4);
  y -= 16;
  addText(LEFT_X, y, 10, "F2", "Initials:");
  addText(115, y, 10, "F1", "Contractor:");
  addText(180, y, 10, "F1", "_________");
  addTextColored(180, y, 10, "F1", "/ContractorInitial/", 1.0);
  addText(320, y, 10, "F1", "Homeowner:");
  addText(390, y, 10, "F1", "_________");
  addTextColored(390, y, 10, "F1", "/HomeownerInitial/", 1.0);
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

function buildTextTabs(fields, documentId, documentType) {
  const fieldAnchors = {
    customer_name: "Name",
    customer_address: "Address:",
    customer_city_zip: "City/Zip:",
    customer_phone: "Phone",
    customer_email: "Email:",
    insurance_company: "Insurance Co",
    claim_number: "Claim #",
    deductible: "DEDUCTIBLE:",
    contract_date: "Date:",
    job_description: "Description:",
    material_type: "Material:",
    contract_price: "Contract Price:",
    warranty_years: "Warranty:",
    estimated_start: "Start Date:",
    decking_per_sheet: "Decking/Sheet:",
    full_redeck_price: "Full Redeck:",
    contractor_name: "Contractor:",
    contractor_phone: "Contractor Phone:",
    contractor_email: "Contractor Email:",
    contractor_address: "Contractor Address:",
    contractor_license: "License #:",
    shingle_manufacturer: "Single Manufacture",
    shingle_type: "Shingle Type:",
    shingle_color: "Shingle Color:",
    drip_edge_color: "Drip Edge Color:",
    vents: "Vents",
    satellite: "Satellite",
    skylights: "Skylights",
    num_structures: "Structures:",
    structure_names: "Structure Names:",
    valley_type: "Valley Type:",
    gutter_guards: "Gutter Guards:",
    bad_decking: "Bad Decking:",
    work_not_done: "Work Not Done:",
    non_recoverable: "Non-Recoverable Dep:",
    project_notes: "Project Notes:"
  };
  const tabs = [];
  for (const [fieldName, fieldValue] of Object.entries(fields)){
    const anchor = fieldAnchors[fieldName];
    if (!anchor) {
      continue;
    }
    // [2026-07-09 alignment fix] Per-field anchorXOffset, measured from the standard
    // OtterQuote retail/insurance template geometry (label left-edge -> blank left-edge).
    // The prior single 8px offset landed the value ON the label ("NameGregory Paulsen"):
    // DocuSign positions the value at the LEFT edge of the matched anchor string, not the
    // END, so the offset must span the full label width to reach the underscore blank.
    // Anchor STRINGS are unchanged (a label that lacks a colon, e.g. "Name", must keep its
    // exact deployed string or the value would stop matching and vanish). Offsets are capped
    // well under the page width: max here is 66px, so even an anchor that also recurs in the
    // right-margin prose (historic INVALID_USER_OFFSET risk at ~515px) lands at <=581 < 612.
    const anchorXOffsets = {
      customer_name: "30",
      customer_address: "42",
      customer_city_zip: "40",
      customer_phone: "32",
      customer_email: "32",
      contract_price: "66",
      estimated_start: "48",
      job_description: "54",
      material_type: "40",
      decking_per_sheet: "66"
    };
    tabs.push({
      anchorString: anchor,
      anchorUnits: "pixels",
      anchorXOffset: anchorXOffsets[fieldName] ?? "8",
      anchorYOffset: "-5",
      value: String(fieldValue),
      locked: "true",
      font: "helvetica",
      fontSize: "size10",
      documentId
    });
  }
  return tabs;
}
function buildSignerTabs(documentId, signerType) {
  const signAnchor = signerType === "homeowner" ? "Customer" : "Contractor";
  const dateAnchor = `${signAnchor}_Date`;
  return {
    signHereTabs: [
      {
        anchorString: `/${signAnchor}/`,
        anchorUnits: "pixels",
        anchorXOffset: "0",
        anchorYOffset: "0",
        documentId
      }
    ],
    dateSignedTabs: [
      {
        anchorString: `/${dateAnchor}/`,
        anchorUnits: "pixels",
        anchorXOffset: "0",
        anchorYOffset: "0",
        documentId
      }
    ]
  };
}
// [D-225 Phase 2B / D-186] SOW initials tab builder. Binds /ContractorInitial/ or
// /HomeownerInitial/ initialHere tab on the generated retail Exhibit A (documentId = sowDocId).
// Routing order is inherited from the parent envelope: contractor recipient is order 1,
// homeowner recipient is order 2 — consistent with D-152 + D-186.
function buildSowInitialTabs(sowDocId, signerType) {
  const anchor = signerType === "homeowner" ? "/HomeownerInitial/" : "/ContractorInitial/";
  return {
    initialHereTabs: [
      {
        anchorString: anchor,
        anchorAllowWhiteSpaceInCharacters: "true",
        anchorUnits: "pixels",
        anchorXOffset: "0",
        anchorYOffset: "-2",
        documentId: sowDocId
      }
    ]
  };
}
// ========== ADDENDUM SIGNER TABS ==========
function buildAddendumTabs(documentId) {
  return {
    // D-123: signHere tab replaces prior checkboxTab for otterquote_acknowledgment.
    // checkboxTab with required: "true" is unreliable in DocuSign embedded signing --
    // the "Finish" button can fire before required-checkbox validation triggers.
    // signHere is the only tab type DocuSign reliably enforces before completion.
    // Approved: Dustin Stohler, 2026-05-25, task 86e1frafj.
    signHereTabs: [
      // Optional sign on the Notice of Cancellation (homeowner only)
      {
        anchorString: "I HEREBY CANCEL THIS TRANSACTION",
        anchorUnits: "pixels",
        anchorXOffset: "0",
        anchorYOffset: "20",
        tabLabel: "cancellation_acknowledgment_signature",
        optional: "true",
        documentId
      },
      // D-123 platform disclosure acknowledgment -- homeowner signs to confirm
      // OtterQuote is not a party to the homeowner-contractor agreement.
      // D-269 (#550): explicitly required (DocuSign default, stated for the
      // audit trail) -- docusign-webhook backstops this at completion.
      {
        anchorString: "PLATFORM DISCLOSURE",
        anchorUnits: "pixels",
        anchorXOffset: "0",
        anchorYOffset: "180",
        tabLabel: "otterquote_acknowledgment",
        optional: "false",
        documentId
      }
    ]
  };
}
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
// ========== PER-ENVELOPE EVENT NOTIFICATION (D-211 P18 U5) ==========
// Embeds the DocuSign Connect completion subscription directly on each envelope so the
// platform-fee path (docusign-webhook -> create-payment-intent) is in-repo and self-healing,
// independent of the account-level Connect config 21822232 and its manual "Include Data"
// toggle (an empty toggle was the 0-fees-ever root cause).
//
// includeHMAC:"true" is REQUIRED. Per-envelope eventNotification deliveries are otherwise
// unsigned, and docusign-webhook enforces HMAC fail-closed (DOCUSIGN_REQUIRE_SIGNATURE=true) —
// an unsigned delivery would 401. With includeHMAC the message is signed with the account's
// configured Connect HMAC key (the same secret docusign-webhook reads as
// DOCUSIGN_CONNECT_HMAC_KEY), so verification passes.
//
// eventData mirrors the account "Include Data = recipients" so docusign-webhook's parser sees
// data.envelopeSummary/recipients. Completed-only; documents are not included.
function buildEventNotification() {
  const webhookUrl = `${Deno.env.get("SUPABASE_URL") ?? "https://yeszghaspzwwstvsrioa.supabase.co"}/functions/v1/docusign-webhook`;
  return {
    url: webhookUrl,
    requireAcknowledgment: "true",
    includeHMAC: "true",
    loggingEnabled: "true",
    includeDocuments: "false",
    envelopeEvents: [
      {
        envelopeEventStatusCode: "completed"
      }
    ],
    eventData: {
      version: "restv2.1",
      format: "json",
      includeData: [
        "recipients"
      ]
    }
  };
}
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
async function handleContractorSign(supabase, requestBody, tokenInfo, corsHeaders) {
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
  const addendumBase64 = generateComplianceAddendumPdf(contractorName, homeownerName, contractDate);
  const isRetail = fundingType !== "insurance";
  let scopeOfWorkBase64 = null;
  if (isRetail) {
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
              Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}`,
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
        messageToHomeowner: bidData?.message_to_homeowner ?? bidData?.contractor_message ?? null,
        homeownerNotes: claimData?.homeowner_notes ?? null,
        projectConfirmation: claimData?.project_confirmation ?? null,
        measurements,
        contractDate
      });
      console.log(`Retail Scope of Work PDF generated for claim ${claim_id}`);
    } catch (sowErr) {
      console.error("Retail SOW PDF generation failed (non-fatal, continuing without SOW):", sowErr);
      scopeOfWorkBase64 = null;
    }
  }
  const { accessToken, accountId, baseUri } = tokenInfo;
  const documentId = "1";
  const sowDocId = "2";
  const addendumDocId = isRetail && scopeOfWorkBase64 ? "3" : "2";
  const textTabs = buildTextTabs(autoFields, documentId, "contractor_sign");
  const contractorTabs = buildSignerTabs(documentId, "contractor");
  const docLabel = getDocumentLabel("contractor_sign");
  const envelopeDefinition = {
    emailSubject: `${docLabel} — Otter Quotes (Job #${claim_id.slice(-8).toUpperCase()})`,
    documents: [
      {
        documentBase64: templateBase64,
        name: docLabel,
        fileExtension: "pdf",
        documentId
      },
      ...scopeOfWorkBase64 ? [
        {
          documentBase64: scopeOfWorkBase64,
          name: "Scope of Work",
          fileExtension: "pdf",
          documentId: sowDocId
        }
      ] : [],
      {
        documentBase64: addendumBase64,
        name: "IC 24-5-11 Compliance Addendum",
        fileExtension: "pdf",
        documentId: addendumDocId
      }
    ],
    recipients: {
      signers: [
        {
          email: signer.email,
          name: signer.name,
          recipientId: "1",
          routingOrder: "1",
          clientUserId: "contractor_1",
          tabs: {
            textTabs,
            ...contractorTabs,
            // [D-225 Phase 2B / D-186] Contractor initial on the generated retail Exhibit A.
            // Bound only when isRetail AND SOW generation succeeded (scopeOfWorkBase64 truthy);
            // insurance envelopes have no Exhibit A per D-201, so no initials.
            ...scopeOfWorkBase64 ? buildSowInitialTabs(sowDocId, "contractor") : {}
          }
        },
        {
          email: homeownerEmail,
          name: homeownerFullName,
          recipientId: "2",
          routingOrder: "2",
          clientUserId: "homeowner_1",
          tabs: {
            ...buildSignerTabs(documentId, "homeowner"),
            ...buildAddendumTabs(addendumDocId),
            // [D-225 Phase 2B / D-186] Homeowner initial on the generated retail Exhibit A.
            ...scopeOfWorkBase64 ? buildSowInitialTabs(sowDocId, "homeowner") : {}
          }
        }
      ]
    },
    status: "sent",
    // [D-211 P18 U5] In-repo, self-healing fee-path completion subscription. See buildEventNotification.
    eventNotification: buildEventNotification()
  };
  console.log("Creating DocuSign envelope (contractor_sign)");
  const envelopeResponse = await fetch(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(envelopeDefinition)
  });
  if (!envelopeResponse.ok) {
    const errorData = await envelopeResponse.text();
    console.error("DocuSign envelope creation failed:", errorData);
    throw new Error(`Failed to create envelope: ${envelopeResponse.status} ${errorData}`);
  }
  const envelopeData = await envelopeResponse.json();
  const envelopeId = envelopeData.envelopeId;
  if (!envelopeId) throw new Error("No envelopeId returned from DocuSign");
  console.log(`Envelope created (contractor_sign): ${envelopeId}`);
  const defaultReturnUrl = return_url || `https://otterquote.com/contractor-bid-form.html?claim_id=${claim_id}&signed=contractor`;
  const recipientViewResponse = await fetch(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}/views/recipient`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      returnUrl: defaultReturnUrl,
      authenticationMethod: "none",
      email: signer.email,
      userName: signer.name,
      clientUserId: "contractor_1"
    })
  });
  if (!recipientViewResponse.ok) {
    const errorData = await recipientViewResponse.text();
    throw new Error(`Failed to generate contractor signing URL: ${recipientViewResponse.status} ${errorData}`);
  }
  const recipientViewData = await recipientViewResponse.json();
  const signingUrl = recipientViewData.url;
  if (!signingUrl) throw new Error("No URL returned from DocuSign recipient view endpoint");
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
async function handleHomeownerSign(supabase, requestBody, tokenInfo, corsHeaders) {
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
    throw new Error("No existing DocuSign envelope found for this quote. The contractor must sign first.");
  }
  const { accessToken, accountId, baseUri } = tokenInfo;
  const defaultReturnUrl = return_url || `https://otterquote.com/contract-signing.html?claim_id=${claim_id}&signed=true`;
  console.log(`Generating homeowner signing URL for envelope ${envelopeId}`);
  const recipientViewResponse = await fetch(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}/views/recipient`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      returnUrl: defaultReturnUrl,
      authenticationMethod: "none",
      email: signer.email,
      userName: signer.name,
      clientUserId: "homeowner_1"
    })
  });
  if (!recipientViewResponse.ok) {
    const errorData = await recipientViewResponse.text();
    console.error("Homeowner signing URL generation failed:", errorData);
    throw new Error(`Failed to generate homeowner signing URL: ${recipientViewResponse.status} ${errorData}`);
  }
  const recipientViewData = await recipientViewResponse.json();
  const signingUrl = recipientViewData.url;
  if (!signingUrl) throw new Error("No URL returned from DocuSign recipient view endpoint");
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
async function handleLegacyFlow(supabase, requestBody, tokenInfo, corsHeaders) {
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
      const { data: fetchedClaim } = await supabase.from("claims").select("project_confirmation, property_address, selected_trades, funding_type, job_type").eq("id", claim_id).single();
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
    const trade = (claimData?.selected_trades?.[0] || autoFields?.trade_type)?.toLowerCase() || "roofing";
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
  const { accessToken, accountId, baseUri } = tokenInfo;
  const documentId = "1";
  const textTabs = buildTextTabs(autoFields, documentId, document_type);
  const homeownerTabs = buildSignerTabs(documentId, "homeowner");
  const contractorTabs = buildSignerTabs(documentId, "contractor");
  let contractorEmail = autoFields.contractor_email || "contractor@example.com";
  let contractorName = autoFields.contractor_name || "Contractor";
  const docLabel = getDocumentLabel(document_type);
  const documents = [
    {
      documentBase64: templateBase64,
      name: docLabel,
      fileExtension: "pdf",
      documentId
    }
  ];
  if (document_type === "contract") {
    const contractDate = new Date().toLocaleDateString("en-US");
    const addendumBase64 = generateComplianceAddendumPdf(contractorName, autoFields.customer_name || signer.name || "Homeowner", contractDate);
    documents.push({
      documentBase64: addendumBase64,
      name: "IC 24-5-11 Compliance Addendum",
      fileExtension: "pdf",
      documentId: "2"
    });
  }
  const envelopeDefinition = {
    emailSubject: `${docLabel} — Otter Quotes (Job #${claim_id.slice(-8).toUpperCase()})`,
    documents,
    recipients: {
      signers: [
        {
          email: signer.email,
          name: signer.name,
          recipientId: "1",
          routingOrder: "1",
          clientUserId: "homeowner_1",
          tabs: {
            textTabs,
            ...homeownerTabs,
            ...document_type === "contract" ? buildAddendumTabs("2") : {}
          }
        },
        {
          email: contractorEmail,
          name: contractorName,
          recipientId: "2",
          routingOrder: "2",
          clientUserId: "contractor_1",
          tabs: {
            ...contractorTabs
          }
        }
      ]
    },
    status: "sent",
    // [D-211 P18 U5] In-repo, self-healing fee-path completion subscription. See buildEventNotification.
    eventNotification: buildEventNotification()
  };
  console.log(`Creating DocuSign envelope (legacy: ${document_type})`);
  const envelopeResponse = await fetch(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(envelopeDefinition)
  });
  if (!envelopeResponse.ok) {
    const errorData = await envelopeResponse.text();
    console.error("DocuSign envelope creation failed:", errorData);
    throw new Error(`Failed to create envelope: ${envelopeResponse.status} ${errorData}`);
  }
  const envelopeData = await envelopeResponse.json();
  const envelopeId = envelopeData.envelopeId;
  if (!envelopeId) throw new Error("No envelopeId returned from DocuSign");
  console.log(`Envelope created (${document_type}): ${envelopeId}`);
  await sendGA4Event("envelope_sent", {
    document_type,
    envelope_id: envelopeId,
    claim_id
  });
  const defaultReturnUrl = document_type === "project_confirmation" ? `https://otterquote.com/project-confirmation.html?claim_id=${claim_id}&signed=true` : "https://otterquote.com/contract-signing.html?signed=true";
  const signingReturnUrl = return_url || defaultReturnUrl;
  const recipientViewResponse = await fetch(`${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}/views/recipient`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      returnUrl: signingReturnUrl,
      authenticationMethod: "none",
      email: signer.email,
      userName: signer.name,
      clientUserId: "homeowner_1"
    })
  });
  if (!recipientViewResponse.ok) {
    const errorData = await recipientViewResponse.text();
    throw new Error(`Failed to generate signing URL: ${recipientViewResponse.status} ${errorData}`);
  }
  const recipientViewData = await recipientViewResponse.json();
  const signingUrl = recipientViewData.url;
  if (!signingUrl) throw new Error("No URL returned from DocuSign recipient view endpoint");
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
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
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
    const REST_API_BASE = Deno.env.get("DOCUSIGN_BASE_URI") || Deno.env.get("DOCUSIGN_BASE_URL") || "https://demo.docusign.net";
    const INTEGRATION_KEY = Deno.env.get("DOCUSIGN_INTEGRATION_KEY");
    if (!INTEGRATION_KEY) {
      throw new Error("DocuSign credentials not configured. Set DOCUSIGN_INTEGRATION_KEY.");
    }
    console.log("Acquiring DocuSign access token");
    const tokenInfo = await getAccessToken(REST_API_BASE);
    switch(document_type){
      case "contractor_sign":
        return await handleContractorSign(supabase, requestBody, tokenInfo, corsHeaders);
      case "homeowner_sign":
        return await handleHomeownerSign(supabase, requestBody, tokenInfo, corsHeaders);
      case "contract":
      case "color_confirmation":
      case "project_confirmation":
        return await handleLegacyFlow(supabase, requestBody, tokenInfo, corsHeaders);
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
