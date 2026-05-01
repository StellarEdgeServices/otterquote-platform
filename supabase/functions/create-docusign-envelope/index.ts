/**
 * OtterQuote Edge Function: create-docusign-envelope
 * Creates DocuSign envelopes for the contract signing flow.
 *
 * SIGNING ORDER (IC 24-5-11-11 compliance):
 *   1. Once a homeowner selects a contractor, the contract is distributed to both parties
 *   2. Contractor signs FIRST (after homeowner selection)
 *   3. Homeowner signs SECOND
 *
 * Supported document_type values:
 *   - "contractor_sign"          — Creates envelope with contractor as sole signer (Step A)
 *   - "homeowner_sign"           — Adds homeowner to existing envelope as next signer (Step C)
 *   - "contract" (DEPRECATED)    — Legacy flow, kept for backward compatibility
 *   - "color_confirmation"       — Color confirmation signing
 *   - "project_confirmation"     — Project confirmation signing
 *
 * IC 24-5-11 Compliance Addendum:
 *   Every contract envelope includes a programmatically generated addendum PDF as the
 *   LAST document. This addendum contains:
 *   - Verbatim Statement of Right to Cancel (IC 24-5-11-10.6)
 *   - Notice of Cancellation form (10-point boldface equivalent)
 *   - Homeowner acknowledgment that OtterQuote is not a party
 *
 * Environment variables:
 *   DOCUSIGN_INTEGRATION_KEY
 *   DOCUSIGN_USER_ID
 *   DOCUSIGN_API_ACCOUNT_ID (fallback: DOCUSIGN_ACCOUNT_ID)
 *   DOCUSIGN_RSA_PRIVATE_KEY (base64 encoded PKCS8 DER)
 *   DOCUSIGN_BASE_URI (REST API base, e.g. https://demo.docusign.net for sandbox)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.104.0";

const FUNCTION_NAME = "create-docusign-envelope";

// CORS tightened Apr 15, 2026 (Session 195): sensitive function (contract
// envelope creation + DocuSign signing URL generation) — origin allowlisted
// instead of wildcard. Matches the Session 181 pattern applied to send-sms,
// send-adjuster-email, create-payment-intent, create-setup-intent,
// admin-contractor-action, and switch-contractor.
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
];

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

// ========== TOKEN CACHE ==========
interface CachedToken {
  accessToken: string;
  accountId: string;
  baseUri: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

// ========== JWT GENERATION & BASE64URL UTILITIES ==========
function base64urlEncode(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const binary = String.fromCharCode(...bytes);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return new Uint8Array(binary.split("").map((c) => c.charCodeAt(0)));
}

// ── PKCS#1 → PKCS#8 ASN.1 wrapping helpers ──
// DOCUSIGN_RSA_PRIVATE_KEY is stored as PKCS#1 (BEGIN RSA PRIVATE KEY).
// crypto.subtle.importKey("pkcs8", ...) requires PKCS#8 format.
// These helpers wrap the PKCS#1 DER bytes in a PKCS#8 envelope.
function _derEncodeLength(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  if (len < 0x100) return new Uint8Array([0x81, len]);
  return new Uint8Array([0x82, (len >> 8) & 0xff, len & 0xff]);
}
function _derSequence(data: Uint8Array): Uint8Array {
  const lb = _derEncodeLength(data.length);
  const r = new Uint8Array(1 + lb.length + data.length);
  r[0] = 0x30; r.set(lb, 1); r.set(data, 1 + lb.length); return r;
}
function _derOctetString(data: Uint8Array): Uint8Array {
  const lb = _derEncodeLength(data.length);
  const r = new Uint8Array(1 + lb.length + data.length);
  r[0] = 0x04; r.set(lb, 1); r.set(data, 1 + lb.length); return r;
}
function wrapPkcs1InPkcs8(pkcs1Der: Uint8Array): Uint8Array {
  // RSA algorithm identifier: OID 1.2.840.113549.1.1.1 + NULL
  const rsaOid = new Uint8Array([0x06,0x09,0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x01,0x01,0x05,0x00]);
  const algIdSeq = _derSequence(rsaOid);
  const version = new Uint8Array([0x02, 0x01, 0x00]); // INTEGER 0
  const octet = _derOctetString(pkcs1Der);
  const inner = new Uint8Array(version.length + algIdSeq.length + octet.length);
  inner.set(version); inner.set(algIdSeq, version.length); inner.set(octet, version.length + algIdSeq.length);
  return _derSequence(inner);
}

async function importRsaPrivateKey(pemBase64: string): Promise<CryptoKey> {
  // The secret may be stored as:
  //   (a) a raw base64-encoded DER key (no PEM headers), or
  //   (b) a full PEM string with -----BEGIN/END PRIVATE KEY----- headers
  //       (possibly as a single line with no real newlines, or with \n newlines).
  //   (c) PKCS#1 format (-----BEGIN RSA PRIVATE KEY-----) which must be wrapped
  //       in a PKCS#8 envelope before passing to crypto.subtle.importKey.
  // Strategy: use a regex to extract the base64 body between PEM delimiters.
  // If no PEM delimiters exist, treat the whole value as raw base64 DER.
  const isPkcs1 = pemBase64.includes("BEGIN RSA PRIVATE KEY");
  let b64 = pemBase64.trim();
  if (b64.includes("-----BEGIN")) {
    // Regex captures everything between the header and footer, regardless of
    // whether newlines are real \n or whether the whole thing is on one line.
    const match = b64.match(/-----BEGIN[^-]+-----([A-Za-z0-9+/=\s]+)-----END[^-]+-----/);
    if (match) {
      b64 = match[1];
    } else {
      // Fallback: strip any -----...------ blocks and take what's left.
      b64 = b64.replace(/-----[^-]+-----/g, "");
    }
  }
  // Strip all remaining whitespace (newlines, spaces, carriage returns).
  b64 = b64.replace(/\s+/g, "");

  const pemBinary = atob(b64);
  let pemBytes = new Uint8Array(pemBinary.split("").map((c) => c.charCodeAt(0)));

  // If the key is PKCS#1 (RSA PRIVATE KEY), wrap it in a PKCS#8 envelope
  // so that crypto.subtle.importKey("pkcs8", ...) can parse it correctly.
  if (isPkcs1) {
    pemBytes = wrapPkcs1InPkcs8(pemBytes);
  }

  return await crypto.subtle.importKey(
    "pkcs8",
    pemBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function createJwtAssertion(
  integrationKey: string,
  userId: string,
  baseUrl: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600; // 1 hour

  // Determine audience based on baseUrl (sandbox vs production)
  const aud = baseUrl.includes("demo") || baseUrl.includes("account-d")
    ? "account-d.docusign.com"
    : "account.docusign.com";

  const payload = {
    iss: integrationKey,
    sub: userId,
    aud,
    iat: now,
    exp,
    scope: "signature impersonation",
  };

  const header = { alg: "RS256", typ: "JWT" };
  const headerEncoded = base64urlEncode(JSON.stringify(header));
  const payloadEncoded = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${headerEncoded}.${payloadEncoded}`;

  const rsaPrivateKeyB64 = Deno.env.get("DOCUSIGN_RSA_PRIVATE_KEY");
  if (!rsaPrivateKeyB64) {
    throw new Error(
      "DOCUSIGN_RSA_PRIVATE_KEY not configured. Please set this environment variable with a base64-encoded RSA private key in PEM format."
    );
  }

  const cryptoKey = await importRsaPrivateKey(rsaPrivateKeyB64);
  const signatureBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const signatureEncoded = base64urlEncode(new Uint8Array(signatureBuffer));

  return `${signingInput}.${signatureEncoded}`;
}

// ========== TOKEN MANAGEMENT ==========
async function getAccessToken(baseUrl: string): Promise<CachedToken> {
  const now = Date.now();

  // Return cached token if valid (with 5-minute buffer)
  if (cachedToken && cachedToken.expiresAt > now + 300000) {
    console.log("Using cached DocuSign access token");
    return cachedToken;
  }

  console.log("Fetching new DocuSign access token via JWT grant flow");

  const integrationKey = Deno.env.get("DOCUSIGN_INTEGRATION_KEY");
  const userId = Deno.env.get("DOCUSIGN_USER_ID");

  if (!integrationKey || !userId) {
    throw new Error(
      "DocuSign JWT auth not configured. Set DOCUSIGN_INTEGRATION_KEY and DOCUSIGN_USER_ID."
    );
  }

  const jwtAssertion = await createJwtAssertion(integrationKey, userId, baseUrl);

  // Determine OAuth endpoint based on baseUrl
  const oauthHost = baseUrl.includes("demo") || baseUrl.includes("account-d")
    ? "https://account-d.docusign.com"
    : "https://account.docusign.com";

  const tokenResponse = await fetch(`${oauthHost}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwtAssertion}`,
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

  // Fetch account info from /oauth/userinfo to get the correct account ID and base URI.
  console.log("Fetching DocuSign account info via /oauth/userinfo");
  const userInfoResponse = await fetch(`${oauthHost}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!userInfoResponse.ok) {
    const errText = await userInfoResponse.text();
    throw new Error(`DocuSign userinfo request failed: ${userInfoResponse.status} ${errText}`);
  }

  const userInfo = await userInfoResponse.json();
  const account = userInfo.accounts?.find((a: any) => a.is_default) || userInfo.accounts?.[0];

  if (!account?.account_id) {
    throw new Error(`Could not determine DocuSign account ID from userinfo: ${JSON.stringify(userInfo)}`);
  }

  // base_uri from userinfo is the REST API base (e.g. https://demo.docusign.net)
  const resolvedBaseUri = account.base_uri || baseUrl;
  console.log(`DocuSign account ID: ${account.account_id}, base_uri: ${resolvedBaseUri}`);

  // Cache token (valid for 1 hour, cache with 5-minute buffer)
  cachedToken = {
    accessToken,
    accountId: account.account_id,
    baseUri: resolvedBaseUri,
    expiresAt: now + 3600000 - 300000,
  };

  return cachedToken;
}

// ========== PDF RETRIEVAL ==========
async function getTemplateFromStorage(
  supabase: any,
  contractorId: string,
  documentType: string
): Promise<string> {
  const bucketName = "contractor-templates";
  const filePath = `${contractorId}/${documentType}.pdf`;

  try {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .download(filePath);

    if (error) {
      throw new Error(`Storage error: ${error.message}`);
    }

    if (!data) {
      throw new Error("No data returned from storage");
    }

    // Convert blob to base64
    const arrayBuffer = await data.arrayBuffer();
    const base64 = base64EncodeBinary(new Uint8Array(arrayBuffer));
    return base64;
  } catch (err) {
    throw new Error(
      `Failed to retrieve template PDF (${bucketName}/${filePath}): ${err.message}`
    );
  }
}

/**
 * Fetch a PDF template from a public Supabase Storage URL.
 * Used for project_confirmation templates whose paths include timestamps
 * (e.g. {contractorId}/project_confirmation_template_{timestamp}.pdf).
 */
async function fetchTemplateFromUrl(url: string): Promise<string> {
  console.log(`Fetching template PDF from URL: ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch template from URL (${response.status} ${response.statusText}): ${url}`
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  return base64EncodeBinary(new Uint8Array(arrayBuffer));
}

/**
 * Fetch a PC template from Supabase Storage using a bare path.
 * Handles both bare paths (stored post-D-161) and full public URLs
 * (stored pre-migration — extracts path via regex for backward compat).
 *
 * D-161: contractor-templates bucket is private; public URLs 404.
 * All new uploads store only the path.
 */
async function getPcTemplateFromStorage(supabase: any, fileUrl: string): Promise<string> {
  // Resolve bare path vs full URL (backward compat for pre-migration data)
  let storagePath: string;
  const pathMatch = fileUrl.match(/contractor-templates\/(.+?)(\?|$)/);
  if (pathMatch) {
    storagePath = decodeURIComponent(pathMatch[1]);
  } else {
    // Assume it's already a bare path (post-migration uploads)
    storagePath = fileUrl;
  }

  console.log(`Fetching PC template from storage: contractor-templates/${storagePath}`);
  const { data, error } = await supabase.storage
    .from("contractor-templates")
    .download(storagePath);

  if (error) {
    throw new Error(`PC template storage error (${storagePath}): ${error.message}`);
  }
  if (!data) {
    throw new Error(`No data returned from storage for PC template: ${storagePath}`);
  }

  const arrayBuffer = await data.arrayBuffer();
  return base64EncodeBinary(new Uint8Array(arrayBuffer));
}

/**
 * Select the best PC template slot from the contractor's color_confirmation_template JSONB.
 * D-161 slot key format: "{trade}/{funding_type}" (lowercase, e.g. "roofing/insurance").
 *
 * Selection order:
 *   1. Exact match on trade + funding_type
 *   2. Fallback to roofing/insurance
 *   3. If neither exists, returns null (caller must handle gracefully)
 */
function selectPcTemplateSlot(
  pcTemplateJsonb: Record<string, any> | null | undefined,
  trade: string,
  fundingType: string
): { file_url: string; uploaded_at: string } | null {
  if (!pcTemplateJsonb || typeof pcTemplateJsonb !== "object") return null;

  const primaryKey  = `${trade.toLowerCase()}/${fundingType.toLowerCase()}`;
  const fallbackKey = "roofing/insurance";

  const primary  = pcTemplateJsonb[primaryKey];
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

function base64EncodeBinary(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ========== IC 24-5-11 COMPLIANCE ADDENDUM PDF ==========
/**
 * Generates a PDF addendum containing Indiana Home Improvement Contract Act
 * compliance language. This addendum is attached as the LAST document in every
 * contract envelope.
 *
 * Contents:
 * 1. Statement of Right to Cancel (IC 24-5-11-10.6 — verbatim)
 * 2. Notice of Cancellation form (IC 24-5-11-10.6(b) — 10pt boldface)
 * 3. Homeowner acknowledgment that OtterQuote is not a party (D-123)
 *
 * Uses a minimal PDF generator (no external libraries) to produce a valid PDF
 * with the required legal text.
 */
function generateComplianceAddendumPdf(contractorName: string, homeownerName: string, contractDate: string): string {
  // Minimal PDF generator — builds a valid PDF 1.4 document with text content
  const lines: string[] = [];
  const objects: { offset: number }[] = [];
  let currentOffset = 0;

  function write(s: string) {
    lines.push(s);
    currentOffset += s.length + 1; // +1 for newline
  }

  function startObject(num: number) {
    objects[num] = { offset: currentOffset };
    write(`${num} 0 obj`);
  }

  // Calculate cancellation deadline (3rd business day after signing)
  const signDate = new Date(contractDate || new Date().toISOString());
  let businessDays = 0;
  const cancelDate = new Date(signDate);
  while (businessDays < 3) {
    cancelDate.setDate(cancelDate.getDate() + 1);
    const dow = cancelDate.getDay();
    if (dow !== 0 && dow !== 6) businessDays++;
  }
  const cancelDateStr = cancelDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  // Build PDF content stream with compliance text
  // Using standard PDF text operators: BT (begin text), ET (end text), Tf (font), Td (move), Tj (show text)
  const contentLines: string[] = [];

  function addText(x: number, y: number, fontSize: number, font: string, text: string) {
    // Escape special PDF characters
    const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    contentLines.push(`BT /${font} ${fontSize} Tf ${x} ${y} Td (${escaped}) Tj ET`);
  }

  function addWrappedText(x: number, startY: number, fontSize: number, font: string, text: string, maxWidth: number): number {
    // Approximate character width: fontSize * 0.5 for Helvetica
    const charWidth = fontSize * 0.5;
    const maxChars = Math.floor(maxWidth / charWidth);
    const words = text.split(" ");
    let currentLine = "";
    let y = startY;
    const lineSpacing = fontSize * 1.4;

    for (const word of words) {
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

  // Page 1: Statement of Right to Cancel + Notice of Cancellation
  let y = 750;

  // Title
  addText(50, y, 14, "F2", "INDIANA HOME IMPROVEMENT CONTRACT ACT ADDENDUM");
  y -= 20;
  addText(50, y, 10, "F1", `IC 24-5-11 Compliance Addendum — Contract Date: ${contractDate || new Date().toLocaleDateString("en-US")}`);
  y -= 10;

  // Horizontal rule
  contentLines.push(`50 ${y} m 562 ${y} l S`);
  y -= 20;

  // Section 1: Statement of Right to Cancel
  addText(50, y, 12, "F2", "STATEMENT OF RIGHT TO CANCEL");
  y -= 20;

  const statementText = `You may cancel this contract at any time before midnight on the third business day after the later of the following: (A) The date this contract is signed by you and ${contractorName}. (B) If applicable, the date you receive written notification from your insurance company of a final determination as to whether all or any part of your claim or this contract is a covered loss under your insurance policy. See attached notice of cancellation form for an explanation of this right.`;

  y = addWrappedText(50, y, 10, "F2", statementText, 512);
  y -= 15;

  // Horizontal rule
  contentLines.push(`50 ${y + 5} m 562 ${y + 5} l S`);
  y -= 15;

  // Section 2: Notice of Cancellation
  addText(50, y, 12, "F2", "NOTICE OF CANCELLATION");
  y -= 20;

  addText(50, y, 10, "F2", `Contract Date: ${contractDate || "_______________"}`);
  y -= 16;

  y = addWrappedText(50, y, 10, "F2",
    `You may CANCEL this transaction, without any penalty or obligation, within THREE (3) BUSINESS DAYS from the above date, or if applicable, within three (3) business days from the date you receive written notification from your insurance company of a final determination as to whether all or any part of your claim or this contract is a covered loss under your insurance policy.`,
    512);
  y -= 10;

  y = addWrappedText(50, y, 10, "F2",
    `If you cancel, any property traded in, any payments made by you under the contract, and any negotiable instrument executed by you will be returned within TEN (10) BUSINESS DAYS following receipt by the contractor of your cancellation notice, and any security interest arising out of the transaction will be cancelled.`,
    512);
  y -= 10;

  y = addWrappedText(50, y, 10, "F2",
    `If you cancel, you must make available to the contractor at your residence, in substantially as good condition as when received, any goods delivered to you under this contract. Or you may, if you wish, comply with the instructions of the contractor regarding the return shipment of the goods at the contractor's expense and risk.`,
    512);
  y -= 10;

  y = addWrappedText(50, y, 10, "F1",
    `To cancel this transaction, mail, deliver, or email a signed and dated copy of this cancellation notice, or any other written notice to:`,
    512);
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

  // Horizontal rule
  contentLines.push(`50 ${y + 5} m 562 ${y + 5} l S`);
  y -= 15;

  // Section 3: OtterQuote Disclaimer (D-123)
  addText(50, y, 12, "F2", "PLATFORM DISCLOSURE");
  y -= 20;

  y = addWrappedText(50, y, 10, "F1",
    `OtterQuote is a technology platform that facilitates connections between homeowners and contractors. OtterQuote is NOT a party to this contract and assumes no liability for work performed under this agreement. This contract is between the homeowner and the contractor named above.`,
    512);
  y -= 10;

  addText(50, y, 10, "F1", `Down payment may not exceed $1,000 or 10% of contract price, whichever is less (IC 24-5-11-12).`);
  y -= 30;

  addText(50, y, 8, "F1", "This addendum is generated by OtterQuote to comply with Indiana Code IC 24-5-11 (Home Improvement Contract Act).");
  y -= 12;
  addText(50, y, 8, "F1", `Generated: ${new Date().toISOString()}`);

  // Assemble PDF content stream
  const contentStream = contentLines.join("\n");
  const contentBytes = new TextEncoder().encode(contentStream);

  // Build the PDF structure
  const pdfLines: string[] = [];
  const pdfObjects: number[] = [];
  let byteOffset = 0;

  function pdfWrite(s: string) {
    pdfLines.push(s);
    byteOffset += s.length + 1;
  }

  function pdfStartObj(n: number) {
    pdfObjects[n] = byteOffset;
    pdfWrite(`${n} 0 obj`);
  }

  pdfWrite("%PDF-1.4");

  // Object 1: Catalog
  pdfStartObj(1);
  pdfWrite("<< /Type /Catalog /Pages 2 0 R >>");
  pdfWrite("endobj");

  // Object 2: Pages
  pdfStartObj(2);
  pdfWrite("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  pdfWrite("endobj");

  // Object 3: Page
  pdfStartObj(3);
  pdfWrite("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>");
  pdfWrite("endobj");

  // Object 4: Content stream
  pdfStartObj(4);
  pdfWrite(`<< /Length ${contentStream.length} >>`);
  pdfWrite("stream");
  pdfWrite(contentStream);
  pdfWrite("endstream");
  pdfWrite("endobj");

  // Object 5: Font (Helvetica — regular)
  pdfStartObj(5);
  pdfWrite("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pdfWrite("endobj");

  // Object 6: Font (Helvetica-Bold — for required boldface sections)
  pdfStartObj(6);
  pdfWrite("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  pdfWrite("endobj");

  // Cross-reference table
  const xrefOffset = byteOffset;
  pdfWrite("xref");
  pdfWrite(`0 7`);
  pdfWrite("0000000000 65535 f ");
  for (let i = 1; i <= 6; i++) {
    pdfWrite(String(pdfObjects[i]).padStart(10, "0") + " 00000 n ");
  }

  // Trailer
  pdfWrite("trailer");
  pdfWrite(`<< /Size 7 /Root 1 0 R >>`);
  pdfWrite("startxref");
  pdfWrite(String(xrefOffset));
  pdfWrite("%%EOF");

  // Encode to base64
  const pdfContent = pdfLines.join("\n");
  const pdfBytes = new TextEncoder().encode(pdfContent);
  return base64EncodeBinary(pdfBytes);
}

// ========== HOVER MEASUREMENTS FETCH ==========
/**
 * Fetches key measurement data from hover_orders for use in the Scope of Work PDF.
 * Returns a normalized measurement object with common fields, or null if unavailable.
 * Never throws — any error produces null so the SOW still generates without measurements.
 */
async function fetchHoverMeasurements(supabase: any, claimId: string): Promise<{
  roofSqFt: number | null;
  wallSqFt: number | null;
  perimeterFt: number | null;
  pitch: string | null;
} | null> {
  try {
    const { data: order } = await supabase
      .from("hover_orders")
      .select("hover_job_id, measurements_json")
      .eq("claim_id", claimId)
      .eq("status", "complete")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!order?.measurements_json) return null;

    const mj = order.measurements_json;

    // Roof area — try multiple Hover API response shapes
    const roofSqFtRaw =
      mj?.structures?.[0]?.areas?.roof ??
      mj?.total_sq_ft ??
      mj?.total_area_sq_ft ??
      mj?.roof_area_sq_ft ??
      mj?.measurements?.total_area ??
      null;

    // Wall area (for siding)
    const wallSqFtRaw =
      mj?.structures?.[0]?.areas?.wall ??
      mj?.wall_area_sq_ft ??
      mj?.measurements?.wall_area ??
      null;

    // Perimeter / eaves linear footage (for gutters)
    const perimeterFtRaw =
      mj?.structures?.[0]?.eaves ??
      mj?.eaves_length ??
      mj?.perimeter_ft ??
      mj?.measurements?.perimeter ??
      null;

    // Primary pitch
    const pitchRaw =
      mj?.structures?.[0]?.pitch ??
      mj?.primary_pitch ??
      mj?.pitch ??
      null;

    if (!roofSqFtRaw && !wallSqFtRaw && !perimeterFtRaw) return null;

    return {
      roofSqFt: roofSqFtRaw ? Math.round(Number(roofSqFtRaw)) : null,
      wallSqFt: wallSqFtRaw ? Math.round(Number(wallSqFtRaw)) : null,
      perimeterFt: perimeterFtRaw ? Math.round(Number(perimeterFtRaw)) : null,
      pitch: pitchRaw ? String(pitchRaw) : null,
    };
  } catch (err) {
    console.warn("fetchHoverMeasurements: non-fatal error:", err);
    return null;
  }
}

// ========== RETAIL SCOPE OF WORK PDF ==========
/**
 * Generates a Scope of Work PDF for retail (non-insurance) jobs.
 * Attached as document 2 in the DocuSign envelope when fundingType !== 'insurance'.
 * For insurance jobs, the loss sheet serves as the scope reference instead.
 *
 * Content:
 *   1. Project header (address, parties, date)
 *   2. Contract summary (trades, price, start date)
 *   3. Hover aerial measurements (if available — graceful fallback if not)
 *   4. Trade-specific scope details (from value_adds JSONB on the winning quote)
 *   5. Warranty details (from value_adds.warranties)
 *   6. Project confirmation answers (if claim.project_confirmation is populated)
 *   7. Notes and platform disclosure
 *
 * Uses the same raw PDF 1.4 operator pattern as generateComplianceAddendumPdf —
 * no external libraries, no Deno.read, no filesystem access.
 */
function generateRetailScopeOfWorkPdf(params: {
  homeownerName: string;
  contractorName: string;
  propertyAddress: string;
  claimId: string;
  trades: string[];
  contractPrice: number | null;
  estimatedStartDate: string | null;
  valueAdds: any;
  bidBrand: string | null;
  deckingPricePerSheet: number | null;
  fullRedeckPrice: number | null;
  messageToHomeowner: string | null;
  homeownerNotes: string | null;
  projectConfirmation: any;
  measurements: { roofSqFt: number | null; wallSqFt: number | null; perimeterFt: number | null; pitch: string | null } | null;
  contractDate: string;
  warrantyDisplayString: string | null;
  warrantySnapshot: string | null;
  workmanshipWarrantyYears: number | null;
  materialSelection: any;
}): string {
  const {
    homeownerName, contractorName, propertyAddress, claimId,
    trades, contractPrice, estimatedStartDate, valueAdds,
    bidBrand, deckingPricePerSheet, fullRedeckPrice,
    messageToHomeowner, homeownerNotes, projectConfirmation,
    measurements, contractDate,
    warrantyDisplayString, warrantySnapshot, workmanshipWarrantyYears, materialSelection,
  } = params;

  const va = valueAdds || {};
  const pc = projectConfirmation || null;

  const pdfLines: string[] = [];
  const pdfObjects: number[] = [];
  let byteOffset = 0;

  function pdfWrite(s: string) {
    pdfLines.push(s);
    byteOffset += s.length + 1;
  }
  function pdfStartObj(n: number) {
    pdfObjects[n] = byteOffset;
    pdfWrite(`${n} 0 obj`);
  }

  // ── esc() with ClickUp Bug 8 NFC normalization + WinAnsi transliteration ──
  function esc(text: string): string {
    const s = String(text || "").normalize("NFC");
    const winAnsiMap: Record<string, string> = {
      "‘": "'", "’": "'",
      "“": '"', "”": '"',
      "–": "-", "—": "—",
      "…": "...",
      " ": " ",
    };
    let out = "";
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      if (cp > 0x7F && winAnsiMap[ch] != null) out += winAnsiMap[ch];
      else if (cp > 0xFF) out += "?";
      else out += ch;
    }
    return out
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  }

  // ── Multi-page accumulator (D-200 §9 dual-party initials per page) ──
  const pages: string[][] = [[]];
  let curPage = 0;
  let y = 750;
  const PAGE_BOTTOM_RESERVE = 90;

  function addText(x: number, yPos: number, fontSize: number, font: string, text: string) {
    pages[curPage].push(`BT /${font} ${fontSize} Tf ${x} ${yPos} Td (${esc(text)}) Tj ET`);
  }
  function hLine(yPos: number) {
    pages[curPage].push(`50 ${yPos} m 562 ${yPos} l S`);
  }
  function emitInitialFooter() {
    const fy = 36;
    pages[curPage].push(`BT /F1 8 Tf 50 ${fy + 12} Td (Contractor initials: /ContractorInitial/) Tj ET`);
    pages[curPage].push(`BT /F1 8 Tf 330 ${fy + 12} Td (Homeowner initials: /HomeownerInitial/) Tj ET`);
  }
  function newPage() {
    emitInitialFooter();
    pages.push([]);
    curPage++;
    y = 750;
  }
  function ensureRoom(needed: number) {
    if (y - needed < PAGE_BOTTOM_RESERVE) newPage();
  }
  function addWrappedText(x: number, startY: number, fontSize: number, font: string, text: string, maxWidth: number): number {
    const charWidth = fontSize * 0.5;
    const maxChars = Math.floor(maxWidth / charWidth);
    const words = String(text || "").split(" ");
    let line = "";
    let yp = startY;
    const ls = fontSize * 1.4;
    for (const word of words) {
      if (line.length + word.length + 1 > maxChars) {
        if (yp - ls < PAGE_BOTTOM_RESERVE) { newPage(); yp = y; }
        addText(x, yp, fontSize, font, line.trim());
        yp -= ls;
        line = word + " ";
      } else {
        line += word + " ";
      }
    }
    if (line.trim()) {
      if (yp - ls < PAGE_BOTTOM_RESERVE) { newPage(); yp = y; }
      addText(x, yp, fontSize, font, line.trim());
      yp -= ls;
    }
    y = yp;
    return yp;
  }
  function fmt$(val: number | null | undefined): string {
    if (val == null) return "TBD";
    return "$" + Number(val).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ── Bug 1: EXHIBIT A — SCOPE OF WORK title ──
  addText(50, y, 16, "F2", "EXHIBIT A — SCOPE OF WORK");
  y -= 18;
  addText(50, y, 9, "F1", `Prepared by OtterQuote on behalf of ${esc(contractorName)}`);
  y -= 10;
  hLine(y); y -= 16;

  // Project info
  addText(50, y, 10, "F2", "PROJECT:");    addText(160, y, 10, "F1", esc(propertyAddress)); y -= 14;
  addText(50, y, 10, "F2", "HOMEOWNER:");  addText(160, y, 10, "F1", esc(homeownerName));   y -= 14;
  addText(50, y, 10, "F2", "CONTRACTOR:"); addText(160, y, 10, "F1", esc(contractorName));  y -= 14;
  addText(50, y, 10, "F2", "DATE:");       addText(160, y, 10, "F1", esc(contractDate));    y -= 14;
  addText(50, y, 10, "F2", "JOB REF:");    addText(160, y, 10, "F1", claimId.slice(0, 8).toUpperCase()); y -= 20;
  hLine(y); y -= 16;

  // ── Bug 2: D-186 (amended by D-203) measurement disclaimer — verbatim ──
  ensureRoom(110);
  addText(50, y, 11, "F2", "MEASUREMENT DISCLAIMER"); y -= 14;
  const D203_DISCLAIMER =
    "The measurements contained in this Statement of Work were provided to Contractor on behalf of Customer. " +
    "Both parties have relied upon the accuracy of this information in negotiating the terms of this Agreement. " +
    "Prior to starting the work set forth in this agreement, either party shall have the right to perform his or her own measurements " +
    "of the items listed in this statement of work. If any measurement in this statement of work is off by more than 10%, either party shall have the right to: " +
    "(1) negotiate a change order to be signed by both parties prior to starting the work; " +
    "(2) cancel the Agreement; or " +
    "(3) proceed under the terms set forth in the Agreement.";
  y = addWrappedText(50, y, 9, "F1", D203_DISCLAIMER, 512);
  y -= 6; hLine(y); y -= 16;

  // ── Bug 8: D-200 §3 Material Selection block ──
  ensureRoom(140);
  addText(50, y, 12, "F2", "MATERIAL SELECTION"); y -= 16;
  const ms = (materialSelection ?? null) as any;
  const MAT_CATEGORIES = [
    "Shingles", "Underlayment", "Hip & Ridge Cap", "Starter Strip",
    "Drip Edge", "Ice & Water Shield", "Ridge Vent", "Pipe Boots",
  ];
  for (const cat of MAT_CATEGORIES) {
    ensureRoom(14);
    const row = ms?.[cat] || null;
    let line: string;
    if (row && (row.brand || row.product_line || row.type || row.color)) {
      const parts = [row.brand, row.product_line, row.type, row.color].filter(Boolean);
      line = parts.join(" — ");
    } else {
      line = "Generic";
    }
    addText(60, y, 10, "F2", `${cat}:`); addText(200, y, 10, "F1", esc(line)); y -= 13;
  }
  y -= 6; hLine(y); y -= 16;

  // Contract summary
  ensureRoom(80);
  addText(50, y, 12, "F2", "CONTRACT SUMMARY"); y -= 16;
  const tradeLabel = (trades || []).map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(", ") || "See below";
  addText(50, y, 10, "F2", "Trade(s):");        addText(160, y, 10, "F1", esc(tradeLabel)); y -= 14;
  addText(50, y, 10, "F2", "Financing:");       addText(160, y, 10, "F1", "Retail / Homeowner-Financed"); y -= 14;
  addText(50, y, 10, "F2", "Contract Price:");  addText(160, y, 10, "F1", contractPrice ? fmt$(contractPrice) : "Per contractor agreement"); y -= 14;
  addText(50, y, 10, "F2", "Est. Start:");      addText(160, y, 10, "F1", esc(estimatedStartDate || "To be scheduled")); y -= 20;
  hLine(y); y -= 16;

  // Hover measurements
  if (measurements && (measurements.roofSqFt || measurements.wallSqFt || measurements.perimeterFt)) {
    ensureRoom(90);
    addText(50, y, 12, "F2", "HOVER AERIAL MEASUREMENTS"); y -= 16;
    if (measurements.roofSqFt) {
      addText(50, y, 10, "F2", "Roof Area:");
      addText(160, y, 10, "F1", `${measurements.roofSqFt.toLocaleString()} sq ft (${(measurements.roofSqFt / 100).toFixed(1)} squares)`);
      y -= 14;
    }
    if (measurements.wallSqFt) {
      addText(50, y, 10, "F2", "Wall Area:");
      addText(160, y, 10, "F1", `${measurements.wallSqFt.toLocaleString()} sq ft (${(measurements.wallSqFt / 100).toFixed(1)} squares)`);
      y -= 14;
    }
    if (measurements.perimeterFt) {
      addText(50, y, 10, "F2", "Perimeter:");
      addText(160, y, 10, "F1", `${measurements.perimeterFt.toLocaleString()} linear ft`);
      y -= 14;
    }
    if (measurements.pitch) {
      addText(50, y, 10, "F2", "Primary Pitch:");
      addText(160, y, 10, "F1", esc(measurements.pitch));
      y -= 14;
    }
    y -= 6; hLine(y); y -= 16;
  }

  // Scope of work details by trade
  ensureRoom(40);
  addText(50, y, 12, "F2", "SCOPE OF WORK DETAILS"); y -= 16;
  const hasRoofing = (trades || []).some(t => t.toLowerCase().includes("roof"));
  const hasSiding  = (trades || []).some(t => t.toLowerCase().includes("siding"));
  const hasGutters = (trades || []).some(t => t.toLowerCase().includes("gutter"));
  const hasWindows = (trades || []).some(t => t.toLowerCase().includes("window"));

  if (hasRoofing) {
    ensureRoom(60);
    addText(50, y, 11, "F2", "ROOFING"); y -= 14;
    if (bidBrand) {
      addText(60, y, 10, "F2", "Materials:"); addText(160, y, 10, "F1", esc(bidBrand)); y -= 14;
    }
    if (pc?.shingleManufacturer || pc?.shingleColor) {
      const shingleStr = [pc.shingleManufacturer, pc.shingleColor].filter(Boolean).join(" — ");
      addText(60, y, 10, "F2", "Shingle:"); addText(160, y, 10, "F1", esc(shingleStr)); y -= 14;
    }
    if (pc?.dripEdgeColor) {
      addText(60, y, 10, "F2", "Drip Edge Color:"); addText(160, y, 10, "F1", esc(pc.dripEdgeColor)); y -= 14;
    }
    if (va.underlayment?.type) {
      addText(60, y, 10, "F2", "Underlayment:");
      addText(160, y, 10, "F1", va.underlayment.type === "synthetic" ? "Synthetic" : "Felt");
      y -= 14;
    }
    if (va.starter_strip) {
      const ssMap: Record<string, string> = { rakes: "Rakes only", eaves: "Eaves only", rakes_and_eaves: "Rakes and Eaves", neither: "None" };
      addText(60, y, 10, "F2", "Starter Strip:"); addText(160, y, 10, "F1", ssMap[va.starter_strip] || esc(va.starter_strip)); y -= 14;
    }
    if (va.ventilation) {
      const ventDesc = va.ventilation.ridge_vent_included
        ? "Ridge Vent — Included"
        : va.ventilation.ridge_vent_oop
        ? `Ridge Vent — OOP ${fmt$(va.ventilation.ridge_vent_oop)}`
        : null;
      if (ventDesc) { addText(60, y, 10, "F2", "Ventilation:"); addText(160, y, 10, "F1", ventDesc); y -= 14; }
    }
    if (deckingPricePerSheet) {
      const redeckTxt = fullRedeckPrice
        ? `${fmt$(deckingPricePerSheet)}/sheet if needed; Full redeck: ${fmt$(fullRedeckPrice)}`
        : `${fmt$(deckingPricePerSheet)}/sheet if needed`;
      addText(60, y, 10, "F2", "Decking:");
      y = addWrappedText(160, y, 10, "F1", redeckTxt, 380);
    }
    if (va.chimney_flashing?.option && va.chimney_flashing.option !== "na") {
      const cfMap: Record<string, string> = { reuse: "Reuse existing", replace: "Replace — Included", replace_oop: `Replace OOP ${fmt$(va.chimney_flashing.oop_price)}` };
      addText(60, y, 10, "F2", "Chimney Flashing:"); addText(160, y, 10, "F1", cfMap[va.chimney_flashing.option] || esc(va.chimney_flashing.option)); y -= 14;
    }
    if (va.skylights && va.skylights !== "na") {
      addText(60, y, 10, "F2", "Skylights:"); addText(160, y, 10, "F1", va.skylights === "reflash" ? "Reflash" : "Replace"); y -= 14;
    }
    if (pc?.valleyType) {
      addText(60, y, 10, "F2", "Valleys:"); addText(160, y, 10, "F1", pc.valleyType === "closed" ? "Closed Cut" : "Open / Metal"); y -= 14;
    }
    if (pc?.gutterGuards) {
      addText(60, y, 10, "F2", "Gutter Guards:"); addText(160, y, 10, "F1", esc(pc.gutterGuards)); y -= 14;
    }
    if (pc?.satelliteDish && pc.satelliteDish !== "NONE") {
      const satMap: Record<string, string> = { "REMOVE-TRASH": "Remove & discard", "REMOVE-RESET": "Remove & reset after install" };
      addText(60, y, 10, "F2", "Satellite Dish:"); addText(160, y, 10, "F1", satMap[pc.satelliteDish] || esc(pc.satelliteDish)); y -= 14;
    }
    y -= 8;
  }

  // Second-Layer Tear-Off Contingency
  const slc = va?.secondLayerContingency;
  if (hasRoofing && slc) {
    const slcAmount = (slc.method === "flat_fee" && slc.flatFeeAlternative != null)
      ? slc.flatFeeAlternative
      : slc.pricePerSquare;
    if (slcAmount != null) {
      ensureRoom(60);
      const slcPhrase = slc.method === "flat_fee" ? "flat fee" : "per square";
      const slcDisclaimer =
        `If the existing roof is found to contain more than one layer of shingles, the contract price will increase by ${fmt$(slcAmount)} ${slcPhrase}. ` +
        `Customer will be notified before work proceeds and has the right to accept the change order or cancel the Agreement per the Change Order Disclaimer.`;
      addText(50, y, 11, "F2", "SECOND-LAYER TEAR-OFF CONTINGENCY"); y -= 14;
      y = addWrappedText(60, y, 10, "F1", slcDisclaimer, 480);
      y -= 8;
    }
  }

  if (hasGutters) {
    ensureRoom(60);
    addText(50, y, 11, "F2", "GUTTERS"); y -= 14;
    if (va.gutters?.option) {
      const go = va.gutters.option;
      let gutterDesc = esc(go);
      if (go === "5inch_included" || go === "5inch") gutterDesc = '5" Gutters — Included';
      else if (go === "6inch_included" || go === "6inch") gutterDesc = '6" Gutters — Included';
      else if (go.includes("5inch") && go.includes("additional")) gutterDesc = `5" Gutters — OOP ${fmt$(va.gutters.additional_cost_5inch)}`;
      else if (go.includes("6inch") && go.includes("additional")) gutterDesc = `6" Gutters — OOP ${fmt$(va.gutters.additional_cost_6inch)}`;
      else if (go === "none") gutterDesc = "No gutter work included";
      addText(60, y, 10, "F2", "Gutters:"); addText(160, y, 10, "F1", gutterDesc); y -= 14;
    }
    if (va.gutter_guards) {
      const gg = va.gutter_guards;
      if (gg.pricing_on_request) {
        addText(60, y, 10, "F2", "Gutter Guards:"); addText(160, y, 10, "F1", "Available — pricing on request"); y -= 14;
      } else if (gg.mesh_oop || gg.screw_in_oop) {
        const parts: string[] = [];
        if (gg.mesh_oop) parts.push(`Mesh OOP ${fmt$(gg.mesh_oop)}`);
        if (gg.screw_in_oop) parts.push(`Screw-in OOP ${fmt$(gg.screw_in_oop)}`);
        addText(60, y, 10, "F2", "Gutter Guards:"); addText(160, y, 10, "F1", parts.join("; ")); y -= 14;
      }
    }
    y -= 8;
  }

  if (hasSiding) {
    ensureRoom(45);
    addText(50, y, 11, "F2", "SIDING"); y -= 14;
    addText(60, y, 10, "F1", "Scope per contractor bid and Hover design specifications."); y -= 14;
    if (measurements?.wallSqFt) {
      addText(60, y, 10, "F2", "Wall Area:"); addText(160, y, 10, "F1", `${(measurements.wallSqFt / 100).toFixed(1)} squares`); y -= 14;
    }
    y -= 8;
  }

  if (hasWindows) {
    ensureRoom(40);
    addText(50, y, 11, "F2", "WINDOWS"); y -= 14;
    addText(60, y, 10, "F1", "Scope per contractor bid."); y -= 14;
    y -= 8;
  }

  // ── Bug 8: D-200 §7 Manufacturer × Tier Warranty Block ──
  ensureRoom(80);
  hLine(y + 4); y -= 12;
  addText(50, y, 12, "F2", "WARRANTY"); y -= 16;
  const wDisplay = warrantySnapshot || warrantyDisplayString || null;
  if (wDisplay) {
    addText(60, y, 10, "F2", "Manufacturer's Warranty:"); y -= 12;
    y = addWrappedText(70, y, 9, "F1", wDisplay, 480); y -= 4;
  } else {
    addText(60, y, 10, "F2", "Manufacturer's Warranty:");
    addText(220, y, 10, "F1", "Generic"); y -= 14;
  }
  ensureRoom(20);
  addText(60, y, 10, "F2", "Workmanship Warranty:");
  addText(220, y, 10, "F1", workmanshipWarrantyYears != null ? `${workmanshipWarrantyYears} years` : "TBD"); y -= 14;
  y -= 4;

  // Notes
  const hasNotes = homeownerNotes || messageToHomeowner || va.other_offers ||
                   (pc?.workNotBeingDone) || (pc?.homeownerNotes);
  if (hasNotes) {
    ensureRoom(40);
    hLine(y + 4); y -= 12;
    addText(50, y, 12, "F2", "NOTES"); y -= 14;
    if (homeownerNotes) {
      ensureRoom(20);
      addText(50, y, 10, "F2", "Homeowner Notes:"); y -= 12;
      y = addWrappedText(60, y, 9, "F1", homeownerNotes, 500); y -= 4;
    }
    if (messageToHomeowner) {
      ensureRoom(20);
      addText(50, y, 10, "F2", "Message from Contractor:"); y -= 12;
      y = addWrappedText(60, y, 9, "F1", messageToHomeowner, 500); y -= 4;
    }
    if (va.other_offers) {
      ensureRoom(20);
      addText(50, y, 10, "F2", "Special Offers:"); y -= 12;
      y = addWrappedText(60, y, 9, "F1", va.other_offers, 500); y -= 4;
    }
    if (pc?.workNotBeingDone) {
      ensureRoom(20);
      addText(50, y, 10, "F2", "Exclusions:"); y -= 12;
      y = addWrappedText(60, y, 9, "F1", pc.workNotBeingDone, 500); y -= 4;
    }
    if (pc?.homeownerNotes) {
      ensureRoom(20);
      addText(50, y, 10, "F2", "Project Notes:"); y -= 12;
      y = addWrappedText(60, y, 9, "F1", pc.homeownerNotes, 500);
    }
  }

  // Footer disclosure
  ensureRoom(40);
  y -= 12; hLine(y + 4); y -= 12;
  y = addWrappedText(50, y, 8, "F1",
    "This Scope of Work is a reference document generated by OtterQuote. The contractor's signed agreement is the binding contract. Scope details are based on the contractor's bid submission and may be supplemented by on-site assessment.",
    512);
  addText(50, y, 8, "F1", `Generated by OtterQuote on ${esc(contractDate)} — Job Ref ${claimId.slice(0, 8).toUpperCase()}`);

  // Finalize last page with initial-anchor footer
  emitInitialFooter();

  // ── Multi-page PDF assembly ──
  const N = pages.length;
  pdfWrite("%PDF-1.4");

  pdfStartObj(1);
  pdfWrite("<< /Type /Catalog /Pages 2 0 R >>");
  pdfWrite("endobj");

  const f1Id = 3 + N * 2;
  const f2Id = 4 + N * 2;
  const pageObjIds: string[] = [];
  for (let i = 0; i < N; i++) pageObjIds.push(`${3 + i * 2} 0 R`);

  pdfStartObj(2);
  pdfWrite(`<< /Type /Pages /Kids [${pageObjIds.join(" ")}] /Count ${N} >>`);
  pdfWrite("endobj");

  for (let i = 0; i < N; i++) {
    const pageObjId = 3 + i * 2;
    const contentObjId = 4 + i * 2;
    pdfStartObj(pageObjId);
    pdfWrite(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjId} 0 R /Resources << /Font << /F1 ${f1Id} 0 R /F2 ${f2Id} 0 R >> >> >>`);
    pdfWrite("endobj");
    const contentStream = pages[i].join("\n");
    pdfStartObj(contentObjId);
    pdfWrite(`<< /Length ${contentStream.length} >>`);
    pdfWrite("stream");
    pdfWrite(contentStream);
    pdfWrite("endstream");
    pdfWrite("endobj");
  }

  pdfStartObj(f1Id);
  pdfWrite("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pdfWrite("endobj");
  pdfStartObj(f2Id);
  pdfWrite("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  pdfWrite("endobj");

  const totalObjs = 2 + 2 * N + 2;
  const xrefOffset = byteOffset;
  pdfWrite("xref");
  pdfWrite(`0 ${totalObjs + 1}`);
  pdfWrite("0000000000 65535 f ");
  for (let i = 1; i <= totalObjs; i++) {
    pdfWrite(String(pdfObjects[i]).padStart(10, "0") + " 00000 n ");
  }
  pdfWrite("trailer");
  pdfWrite(`<< /Size ${totalObjs + 1} /Root 1 0 R >>`);
  pdfWrite("startxref");
  pdfWrite(String(xrefOffset));
  pdfWrite("%%EOF");

  return base64EncodeBinary(new TextEncoder().encode(pdfLines.join("\n")));
}

// ========== TAB BUILDERS ==========
interface TextTab {
  anchorString: string;
  anchorUnits: string;
  anchorXOffset: string;
  anchorYOffset: string;
  value: string;
  locked: string;
  font: string;
  fontSize: string;
  documentId: string;
}

interface SignHereTab {
  anchorString: string;
  anchorUnits: string;
  anchorXOffset: string;
  anchorYOffset: string;
  documentId: string;
}

interface DateSignedTab {
  anchorString: string;
  anchorUnits: string;
  anchorXOffset: string;
  anchorYOffset: string;
  documentId: string;
}

interface TextTabFields {
  [key: string]: string;
}

function buildTextTabs(
  fields: TextTabFields,
  documentId: string,
  documentType: string
): TextTab[] {
  // Mapping of field names to anchor strings found in contractor PDFs
  const fieldAnchors: { [key: string]: string } = {
    // Homeowner / property fields
    customer_name: "Name",
    customer_address: "Address:",
    customer_city_zip: "City/Zip:",
    customer_phone: "Phone",
    customer_email: "Email:",
    // Insurance fields
    insurance_company: "Insurance Co",
    claim_number: "Claim #",
    deductible: "DEDUCTIBLE:",
    // Contract / job fields
    contract_date: "Date:",
    job_description: "Description:",
    material_type: "Material:",
    contract_price: "Contract Price:",
    // Bug 4 (D-199 v2 + D-202): split single Warranty: anchor into two
    manufacturer_warranty: "Manufacturer's Warranty:",
    workmanship_warranty: "Workmanship Warranty:",
    estimated_start: "Start Date:",
    decking_per_sheet: "Decking/Sheet:",
    full_redeck_price: "Full Redeck:",
    // Bug 5 (D-199 v2 siding): material commitment + sheathing contingency
    siding_product: "Siding Product:",
    wall_substrate: "Wall Substrate:",
    // Bug 6 (D-199 v2 gutters): scope measurement + spec
    linear_feet: "Linear Feet:",
    gutter_size: "Gutter Size:",
    downspout_count: "Downspout Count:",
    // Bug 7 (D-199 v2 windows): manufacturer + count
    window_manufacturer: "Window Manufacturer:",
    window_count: "Window Count:",
    // Contractor fields
    contractor_name: "Contractor:",
    contractor_phone: "Contractor Phone:",
    contractor_email: "Contractor Email:",
    contractor_address: "Contractor Address:",
    contractor_license: "License #:",
    // Color / project confirmation fields
    shingle_manufacturer: "Single Manufacture",
    shingle_type: "Shingle Type:",
    shingle_color: "Shingle Color:",
    drip_edge_color: "Drip Edge Color:",
    vents: "Vents",
    satellite: "Satellite",
    skylights: "Skylights",
    // Project confirmation extended fields
    num_structures: "Structures:",
    structure_names: "Structure Names:",
    valley_type: "Valley Type:",
    gutter_guards: "Gutter Guards:",
    bad_decking: "Bad Decking:",
    work_not_done: "Work Not Done:",
    non_recoverable: "Non-Recoverable Dep:",
    project_notes: "Project Notes:",
  };

  const tabs: TextTab[] = [];

  for (const [fieldName, fieldValue] of Object.entries(fields)) {
    const anchor = fieldAnchors[fieldName];
    if (!anchor) {
      // Skip unmapped fields
      continue;
    }

    tabs.push({
      anchorString: anchor,
      anchorUnits: "pixels",
      anchorXOffset: "150",
      anchorYOffset: "-5",
      value: String(fieldValue),
      locked: "true",
      font: "helvetica",
      fontSize: "size10",
      documentId,
    });
  }

  return tabs;
}

function buildSowInitialTabs(documentId: string, signerType: "homeowner" | "contractor") {
  // D-200 §9 dual-party initials on retail Exhibit A SOW.
  // /ContractorInitial/ and /HomeownerInitial/ anchor strings emitted per page
  // in generateRetailScopeOfWorkPdf footer block.
  const anchor = signerType === "homeowner" ? "/HomeownerInitial/" : "/ContractorInitial/";
  return {
    initialHereTabs: [{
      anchorString: anchor,
      anchorUnits: "pixels",
      anchorXOffset: "0",
      anchorYOffset: "0",
      anchorMatchWholeWord: "true",
      anchorIgnoreIfNotPresent: "false",
      documentId,
    }],
  };
}

function buildSignerTabs(documentId: string, signerType: "homeowner" | "contractor") {
  const signAnchor = signerType === "homeowner" ? "Customer" : "Contractor";
  const dateAnchor = `${signAnchor}_Date`;

  return {
    signHereTabs: [
      {
        anchorString: `/${signAnchor}/`,
        anchorUnits: "pixels",
        anchorXOffset: "0",
        anchorYOffset: "0",
        documentId,
      } as SignHereTab,
    ],
    dateSignedTabs: [
      {
        anchorString: `/${dateAnchor}/`,
        anchorUnits: "pixels",
        anchorXOffset: "0",
        anchorYOffset: "0",
        documentId,
      } as DateSignedTab,
    ],
  };
}

// ========== ADDENDUM SIGNER TABS ==========
// These are positioned on the compliance addendum (document 2) for the homeowner's
// acknowledgment checkbox and signature on the cancellation notice
function buildAddendumTabs(documentId: string) {
  return {
    // Checkbox for D-123 acknowledgment
    checkboxTabs: [
      {
        anchorString: "PLATFORM DISCLOSURE",
        anchorUnits: "pixels",
        anchorXOffset: "0",
        anchorYOffset: "180",
        tabLabel: "otterquote_acknowledgment",
        name: "I understand I am signing a contract directly with the contractor named above. OtterQuote is not a party to this agreement.",
        required: "true",
        documentId,
      },
    ],
    // Sign on the Notice of Cancellation (homeowner only — this signature is on the addendum)
    signHereTabs: [
      {
        anchorString: "I HEREBY CANCEL THIS TRANSACTION",
        anchorUnits: "pixels",
        anchorXOffset: "0",
        anchorYOffset: "20",
        tabLabel: "cancellation_acknowledgment_signature",
        optional: "true",
        documentId,
      },
    ],
  };
}

// ========== DOCUMENT LABEL HELPERS ==========
function getDocumentLabel(documentType: string): string {
  switch (documentType) {
    case "contract":
    case "contractor_sign":
    case "homeowner_sign":
      return "Repair Contract";
    case "color_confirmation": return "Color Confirmation";
    case "project_confirmation": return "Project Confirmation";
    default: return "Document";
  }
}

// ========== AUTO-POPULATE FIELDS FROM DB ==========
async function autoPopulateFields(
  supabase: any,
  claimId: string,
  contractorId: string,
  signerName: string,
  signerEmail: string,
  documentType: string
): Promise<{ fields: TextTabFields; claimData: any; contractorData: any; bidData: any }> {
  const { data: claimData } = await supabase
    .from("claims")
    .select("*")
    .eq("id", claimId)
    .single();

  const { data: contractorData } = await supabase
    .from("contractors")
    .select("*")
    .eq("id", contractorId)
    .single();

  const { data: bidData } = await supabase
    .from("quotes")
    .select("*")
    .eq("claim_id", claimId)
    .eq("contractor_id", contractorId)
    .single();

  const fields: TextTabFields = {};

  if (claimData) {
    // Homeowner info
    fields.customer_name = signerName || "";
    fields.customer_address = claimData.property_address || claimData.address_line1 || "";
    fields.customer_city_zip = `${claimData.address_city || ""}, ${claimData.address_state || ""} ${claimData.address_zip || ""}`.trim();
    fields.customer_phone = claimData.phone || "";
    fields.customer_email = signerEmail || "";
    // Insurance info
    fields.insurance_company = claimData.insurance_carrier || "";
    fields.claim_number = claimData.claim_number || "";
    fields.deductible = claimData.deductible_amount ? `$${Number(claimData.deductible_amount).toLocaleString()}` : "";
    // Job info
    fields.contract_date = new Date().toLocaleDateString("en-US");
    fields.job_description = claimData.damage_type ? `Roof ${claimData.damage_type}` : "Roof Replacement";
    fields.material_type = claimData.material_product || bidData?.brand || "";
  }

  // D-202 — warranty_options.display_string lookup (Bug 9)
  let warrantyDisplayString: string | null = null;
  if (bidData?.warranty_option_id) {
    const { data: wo } = await supabase
      .from("warranty_options")
      .select("display_string")
      .eq("id", bidData.warranty_option_id)
      .maybeSingle();
    warrantyDisplayString = bidData?.warranty_snapshot || wo?.display_string || null;
  } else if (bidData?.warranty_snapshot) {
    warrantyDisplayString = bidData.warranty_snapshot;
  }

  if (bidData) {
    fields.contract_price = bidData.amount ? `$${Number(bidData.amount).toLocaleString()}` : "";
    // Bug 4: split warranty anchors
    fields.manufacturer_warranty = warrantyDisplayString || "";
    fields.workmanship_warranty = bidData.workmanship_warranty_years != null
      ? `${bidData.workmanship_warranty_years} years`
      : (bidData.warranty_years ? `${bidData.warranty_years} years` : "");
    fields.estimated_start = bidData.estimated_start_date || "";
    fields.decking_per_sheet = bidData.decking_price_per_sheet ? `$${bidData.decking_price_per_sheet}` : "";
    fields.full_redeck_price = bidData.full_redeck_price ? `$${Number(bidData.full_redeck_price).toLocaleString()}` : "";

    // Bugs 5-7: D-199 v2 siding / gutters / windows anchors from value_adds
    const va = bidData.value_adds || {};
    fields.siding_product = va.siding?.product || va.siding?.brand || "";
    fields.wall_substrate = va.siding?.wall_substrate_price_per_sheet
      ? `$${va.siding.wall_substrate_price_per_sheet}/sheet`
      : "";
    fields.linear_feet = va.gutters?.linear_feet != null ? String(va.gutters.linear_feet) : "";
    fields.gutter_size = va.gutters?.size || va.gutters?.gutter_size || "";
    fields.downspout_count = va.gutters?.downspout_count != null ? String(va.gutters.downspout_count) : "";
    fields.window_manufacturer = va.windows?.manufacturer || "";
    fields.window_count = va.windows?.count != null ? String(va.windows.count) : "";
  }

  if (contractorData) {
    fields.contractor_name = contractorData.company_name || "";
    fields.contractor_phone = contractorData.phone || "";
    fields.contractor_email = contractorData.email || "";
    fields.contractor_address = contractorData.address_line1
      ? `${contractorData.address_line1}, ${contractorData.address_city || ""}, ${contractorData.address_state || ""} ${contractorData.address_zip || ""}`
      : "";
    fields.contractor_license = "";

    // Get contractor license info
    const { data: licenseData } = await supabase
      .from("contractor_licenses")
      .select("license_number, municipality")
      .eq("contractor_id", contractorData.id)
      .limit(1);
    if (licenseData && licenseData.length > 0) {
      fields.contractor_license = `${licenseData[0].license_number} (${licenseData[0].municipality})`;
    }
  }

  // Project Confirmation: merge scope/material fields from project_confirmation JSONB
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
      project_notes: pc.homeownerNotes || "",
    });
  }

  return { fields, claimData, contractorData, bidData, warrantyDisplayString };
}

// ========== HANDLER: CONTRACTOR SIGN (new — Step A) ==========
async function handleContractorSign(
  supabase: any,
  requestBody: any,
  tokenInfo: CachedToken,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const { claim_id, contractor_id, signer, fields: providedFields, return_url, quote_id } = requestBody;

  // Auto-populate fields if not provided
  let autoFields = providedFields || {};
  let claimData: any = null;
  let contractorData: any = null;
  let bidData: any = null;

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
    // Fetch bid data for SOW generation — needed even when caller provides their own fields
    const { data: bd } = await supabase
      .from("quotes")
      .select("*")
      .eq("claim_id", claim_id)
      .eq("contractor_id", contractor_id)
      .maybeSingle();
    bidData = bd;
  }

  // Fetch contractor's contract template from storage
  // Determine trade + funding type to select the right template
  const trades = claimData?.selected_trades || [];
  const trade = trades.length ? trades[0].toLowerCase() : "roofing";
  let fundingType = "insurance";
  if (claimData?.funding_type) {
    fundingType = claimData.funding_type.toLowerCase();
  } else if (claimData?.job_type === "retail" || claimData?.job_type === "cash") {
    fundingType = "retail";
  }

  // Look up template from contractor's contract_templates JSONB
  const templates = contractorData?.contract_templates || [];
  let matchingTemplate = templates.find((t: any) =>
    t.trade && t.trade.toLowerCase() === trade &&
    t.funding_type && t.funding_type.toLowerCase() === fundingType
  );
  if (!matchingTemplate) {
    matchingTemplate = templates.find((t: any) => t.trade && t.trade.toLowerCase() === trade);
  }
  if (!matchingTemplate && contractorData?.contract_pdf_url) {
    matchingTemplate = { file_url: contractorData.contract_pdf_url };
  }

  let templateBase64: string;
  if (matchingTemplate?.file_url && matchingTemplate.file_url.includes("contractor-templates")) {
    // Extract storage path from URL and download
    const pathMatch = matchingTemplate.file_url.match(/contractor-templates\/(.+)$/);
    if (pathMatch) {
      const storagePath = decodeURIComponent(pathMatch[1]);
      const { data: blob, error } = await supabase.storage.from("contractor-templates").download(storagePath);
      if (error) throw new Error(`Template download error: ${error.message}`);
      const ab = await blob.arrayBuffer();
      templateBase64 = base64EncodeBinary(new Uint8Array(ab));
    } else {
      templateBase64 = await fetchTemplateFromUrl(matchingTemplate.file_url);
    }
  } else if (matchingTemplate?.file_url) {
    templateBase64 = await fetchTemplateFromUrl(matchingTemplate.file_url);
  } else {
    // Fallback: try standard path convention
    templateBase64 = await getTemplateFromStorage(supabase, contractor_id, "contract");
  }

  // Generate IC 24-5-11 compliance addendum
  const contractDate = new Date().toLocaleDateString("en-US");
  const contractorName = contractorData?.company_name || signer.name || "Contractor";
  const homeownerName = autoFields.customer_name || "Homeowner";
  const addendumBase64 = generateComplianceAddendumPdf(contractorName, homeownerName, contractDate);

  // For retail (non-insurance) jobs: generate a Scope of Work PDF and attach it as
  // document 2. The IC 24-5-11 compliance addendum shifts to document 3.
  // For insurance jobs the loss sheet serves as the scope reference — no SOW generated.
  const isRetail = fundingType !== "insurance";
  let scopeOfWorkBase64: string | null = null;
  if (isRetail) {
    try {
      const measurements = await fetchHoverMeasurements(supabase, claim_id);
      // D-202 warranty lookup for SOW Mfr × Tier block
      let sowWarrantyDisplay: string | null = null;
      if (bidData?.warranty_option_id) {
        const { data: woRow } = await supabase
          .from("warranty_options")
          .select("display_string")
          .eq("id", bidData.warranty_option_id)
          .maybeSingle();
        sowWarrantyDisplay = bidData?.warranty_snapshot || woRow?.display_string || null;
      } else if (bidData?.warranty_snapshot) {
        sowWarrantyDisplay = bidData.warranty_snapshot;
      }

      scopeOfWorkBase64 = generateRetailScopeOfWorkPdf({
        homeownerName,
        contractorName,
        propertyAddress: claimData?.property_address || autoFields.customer_address || "",
        claimId: claim_id,
        trades: claimData?.selected_trades || [trade],
        contractPrice: bidData?.amount ?? bidData?.total_price ?? null,
        estimatedStartDate: bidData?.estimated_start_date ?? null,
        valueAdds: bidData?.value_adds ?? null,
        bidBrand: bidData?.brand ?? null,
        deckingPricePerSheet: bidData?.decking_price_per_sheet ?? null,
        fullRedeckPrice: bidData?.full_redeck_price ?? null,
        messageToHomeowner: bidData?.message_to_homeowner ?? bidData?.contractor_message ?? null,
        homeownerNotes: claimData?.homeowner_notes ?? null,
        projectConfirmation: claimData?.project_confirmation ?? null,
        measurements,
        contractDate,
        warrantyDisplayString: sowWarrantyDisplay,
        warrantySnapshot: bidData?.warranty_snapshot ?? null,
        workmanshipWarrantyYears: bidData?.workmanship_warranty_years ?? null,
        materialSelection: bidData?.material_selection ?? null,
      });
      console.log(`Retail Scope of Work PDF generated for claim ${claim_id}`);
    } catch (sowErr) {
      // Non-fatal: proceed without SOW if generation fails for any reason
      console.error("Retail SOW PDF generation failed (non-fatal, continuing without SOW):", sowErr);
      scopeOfWorkBase64 = null;
    }
  }

  const { accessToken, accountId, baseUri } = tokenInfo;

  // Document IDs:
  //   Insurance:  doc 1 = contractor agreement, doc 2 = IC 24-5-11 addendum
  //   Retail:     doc 1 = contractor agreement, doc 2 = Scope of Work, doc 3 = IC 24-5-11 addendum
  const documentId = "1";
  const sowDocId    = "2"; // retail only
  const addendumDocId = isRetail && scopeOfWorkBase64 ? "3" : "2";
  const textTabs = buildTextTabs(autoFields, documentId, "contractor_sign");
  const contractorTabs = buildSignerTabs(documentId, "contractor");

  // Resolve homeowner email for placeholder recipient (from profiles table)
  let homeownerEmail = "homeowner@placeholder.otterquote.com";
  let homeownerFullName = homeownerName;
  if (claimData?.user_id) {
    const { data: profileData } = await supabase
      .from("profiles")
      .select("email, full_name")
      .eq("id", claimData.user_id)
      .single();
    if (profileData) {
      homeownerEmail = profileData.email || homeownerEmail;
      homeownerFullName = profileData.full_name || homeownerFullName;
      if (!profileData.full_name) {
        // BUG-3 guard: if full_name is null, envelope is created with a fallback name.
        // homeowner_sign's profile lookup will also get null and fall back to signer.name.
        // This can still mismatch if signer.name differs. Log for observability.
        console.warn(`[BUG-3 guard] profiles.full_name is null for user ${claimData?.user_id} — envelope homeowner placeholder uses fallback: "${homeownerFullName}"`);
      }
    }
  }

  const docLabel = getDocumentLabel("contractor_sign");

  const envelopeDefinition: any = {
    emailSubject: `${docLabel} — OtterQuote (Claim ${claim_id.slice(0, 8)})`,
    documents: [
      {
        documentBase64: templateBase64,
        name: docLabel,
        fileExtension: "pdf",
        documentId,
      },
      // Scope of Work — retail jobs only (doc 2). Shifts addendum to doc 3.
      ...(scopeOfWorkBase64 ? [{
        documentBase64: scopeOfWorkBase64,
        name: "Scope of Work",
        fileExtension: "pdf",
        documentId: sowDocId,
      }] : []),
      {
        documentBase64: addendumBase64,
        name: "IC 24-5-11 Compliance Addendum",
        fileExtension: "pdf",
        documentId: addendumDocId,
      },
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
            ...(scopeOfWorkBase64 ? buildSowInitialTabs(sowDocId, "contractor") : {}),
          },
        },
        // Homeowner is signer 2 — not yet active (will use createRecipient later)
        // Placeholder with routingOrder 2 so DocuSign knows the signing order
        {
          email: homeownerEmail,
          name: homeownerFullName,
          recipientId: "2",
          routingOrder: "2",
          clientUserId: "homeowner_1",
          tabs: {
            ...buildSignerTabs(documentId, "homeowner"),
            ...buildAddendumTabs(addendumDocId),
            ...(scopeOfWorkBase64 ? buildSowInitialTabs(sowDocId, "homeowner") : {}),
          },
        },
      ],
    },
    status: "sent", // "sent" starts the signing workflow
  };

  console.log("Creating DocuSign envelope (contractor_sign)");
  const envelopeResponse = await fetch(
    `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(envelopeDefinition),
    }
  );

  if (!envelopeResponse.ok) {
    const errorData = await envelopeResponse.text();
    console.error("DocuSign envelope creation failed:", errorData);
    throw new Error(`Failed to create envelope: ${envelopeResponse.status} ${errorData}`);
  }

  const envelopeData = await envelopeResponse.json();
  const envelopeId = envelopeData.envelopeId;
  if (!envelopeId) throw new Error("No envelopeId returned from DocuSign");

  console.log(`Envelope created (contractor_sign): ${envelopeId}`);

  // Generate embedded signing URL for contractor
  const defaultReturnUrl = return_url || `https://otterquote.com/contractor-bid-form.html?claim_id=${claim_id}&signed=contractor`;
  const recipientViewResponse = await fetch(
    `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}/views/recipient`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        returnUrl: defaultReturnUrl,
        authenticationMethod: "none",
        email: signer.email,
        userName: signer.name,
        clientUserId: "contractor_1",
      }),
    }
  );

  if (!recipientViewResponse.ok) {
    const errorData = await recipientViewResponse.text();
    throw new Error(`Failed to generate contractor signing URL: ${recipientViewResponse.status} ${errorData}`);
  }

  const recipientViewData = await recipientViewResponse.json();
  const signingUrl = recipientViewData.url;
  if (!signingUrl) throw new Error("No URL returned from DocuSign recipient view endpoint");

  // Store envelope ID on the quote record
  const quoteUpdateFilter = quote_id
    ? supabase.from("quotes").update({ docusign_envelope_id: envelopeId }).eq("id", quote_id)
    : supabase.from("quotes").update({ docusign_envelope_id: envelopeId })
        .eq("claim_id", claim_id)
        .eq("contractor_id", contractor_id);

  const { error: quoteUpdateError } = await quoteUpdateFilter;
  if (quoteUpdateError) {
    console.error("Failed to update quote with envelope ID:", quoteUpdateError);
  }

  // Also update claim with the latest envelope
  await supabase.from("claims").update({
    contract_sent_at: new Date().toISOString(),
    docusign_envelope_id: envelopeId,
  }).eq("id", claim_id);

  return new Response(
    JSON.stringify({
      success: true,
      envelope_id: envelopeId,
      signing_url: signingUrl,
      status: "sent",
      document_type: "contractor_sign",
      signer_email: signer.email,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// ========== HANDLER: HOMEOWNER SIGN (new — Step C) ==========
async function handleHomeownerSign(
  supabase: any,
  requestBody: any,
  tokenInfo: CachedToken,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const { claim_id, contractor_id, signer, return_url, quote_id } = requestBody;

  // Look up existing envelope from the quote
  let envelopeId: string | null = null;

  if (quote_id) {
    const { data: quoteData } = await supabase
      .from("quotes")
      .select("docusign_envelope_id, contractor_signed_at")
      .eq("id", quote_id)
      .single();
    envelopeId = quoteData?.docusign_envelope_id;
  }

  if (!envelopeId) {
    // Fallback: look up by claim_id + contractor_id
    const { data: quoteData } = await supabase
      .from("quotes")
      .select("docusign_envelope_id, contractor_signed_at")
      .eq("claim_id", claim_id)
      .eq("contractor_id", contractor_id)
      .not("docusign_envelope_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    envelopeId = quoteData?.docusign_envelope_id;
  }

  if (!envelopeId) {
    throw new Error("No existing DocuSign envelope found for this quote. The contractor must sign first.");
  }

  const { accessToken, accountId, baseUri } = tokenInfo;

  // BUG-3 fix: fetch homeowner identity from the profiles table — must exactly
  // match what was stored as recipient 2 during contractor_sign envelope creation.
  // Never trust the frontend-provided signer values for DocuSign identity matching:
  // any mismatch (casing, missing middle name, fallback vs. real name) causes
  // UNKNOWN_ENVELOPE_RECIPIENT and blocks homeowner signing entirely.
  let homeownerEmail = signer.email;
  let homeownerName = signer.name;
  if (claim_id) {
    const { data: claimRow } = await supabase
      .from("claims")
      .select("user_id")
      .eq("id", claim_id)
      .single();
    if (claimRow?.user_id) {
      const { data: profileData } = await supabase
        .from("profiles")
        .select("email, full_name")
        .eq("id", claimRow.user_id)
        .single();
      if (profileData?.email) homeownerEmail = profileData.email;
      if (profileData?.full_name) homeownerName = profileData.full_name;
      console.log(`[BUG-3 fix] Homeowner identity resolved from profiles: ${homeownerEmail} / ${homeownerName}`);
    } else {
      console.warn(`[BUG-3 fix] No user_id on claim ${claim_id} — falling back to frontend signer values (mismatch risk)`);
    }
  }

  // Generate embedded signing URL for the homeowner (recipient 2, already in the envelope)
  const defaultReturnUrl = return_url || `https://otterquote.com/contract-signing.html?claim_id=${claim_id}&signed=true`;

  console.log(`Generating homeowner signing URL for envelope ${envelopeId}`);

  const recipientViewResponse = await fetch(
    `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}/views/recipient`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        returnUrl: defaultReturnUrl,
        authenticationMethod: "none",
        email: homeownerEmail,
        userName: homeownerName,
        clientUserId: "homeowner_1",
      }),
    }
  );

  if (!recipientViewResponse.ok) {
    const errorData = await recipientViewResponse.text();
    console.error("Homeowner signing URL generation failed:", errorData);
    throw new Error(`Failed to generate homeowner signing URL: ${recipientViewResponse.status} ${errorData}`);
  }

  const recipientViewData = await recipientViewResponse.json();
  const signingUrl = recipientViewData.url;
  if (!signingUrl) throw new Error("No URL returned from DocuSign recipient view endpoint");

  console.log("Homeowner signing URL generated successfully");

  return new Response(
    JSON.stringify({
      success: true,
      envelope_id: envelopeId,
      signing_url: signingUrl,
      status: "sent",
      document_type: "homeowner_sign",
      signer_email: signer.email,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// ========== HANDLER: LEGACY CONTRACT / COLOR / PROJECT CONFIRMATION ==========
async function handleLegacyFlow(
  supabase: any,
  requestBody: any,
  tokenInfo: CachedToken,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const {
    claim_id,
    document_type,
    contractor_id,
    signer,
    fields: providedFields,
    return_url,
  } = requestBody;

  // Auto-populate fields if not provided
  let autoFields = providedFields || {};
  let claimData: any = null;
  let contractorData: any = null;

  if (!providedFields || Object.keys(providedFields).length === 0) {
    const result = await autoPopulateFields(supabase, claim_id, contractor_id, signer.name, signer.email, document_type);
    autoFields = result.fields;
    claimData = result.claimData;
    contractorData = result.contractorData;
  } else {
    if (document_type === "project_confirmation") {
      const { data: fetchedClaim } = await supabase
        .from("claims")
        .select("project_confirmation, property_address, selected_trades, funding_type, job_type")
        .eq("id", claim_id)
        .single();
      claimData = fetchedClaim;

      const { data: fetchedContractor } = await supabase
        .from("contractors")
        .select("color_confirmation_template, company_name, email")
        .eq("id", contractor_id)
        .single();
      contractorData = fetchedContractor;
    }
  }

  // Fetch template PDF
  let templateBase64: string;

  if (document_type === "project_confirmation") {
    // Ensure contractor data with JSONB PC template column is loaded
    const templateContractor = contractorData || await (async () => {
      const { data } = await supabase
        .from("contractors")
        .select("color_confirmation_template, company_name")
        .eq("id", contractor_id)
        .single();
      return data;
    })();

    // Resolve trade + funding type from claim data
    const trade: string = (
      claimData?.selected_trades?.[0] ||
      (autoFields?.trade_type as string | undefined)
    )?.toLowerCase() || "roofing";

    const rawFunding: string = (
      claimData?.funding_type ||
      claimData?.job_type ||
      (autoFields?.funding_type as string | undefined) ||
      ""
    ).toLowerCase();
    // Normalize: anything containing "insurance" → "insurance", else "retail"
    const fundingType: string = rawFunding.includes("insurance") ? "insurance" : "retail";

    // Select the best-matching PC template slot
    const slot = selectPcTemplateSlot(
      templateContractor?.color_confirmation_template,
      trade,
      fundingType
    );

    if (!slot) {
      // No PC template available — log a warning and omit the PC document.
      // The envelope still generates (non-fatal per D-161 spec).
      console.warn(
        `[D-161] No project confirmation template found for contractor ${contractor_id} ` +
        `(trade=${trade}, fundingType=${fundingType}). Omitting PC document from envelope.`
      );
      throw new Error(
        "No project confirmation template on file for this trade and funding type. " +
        "The contractor must upload a Project Confirmation Template in their profile before this document can be created."
      );
    }

    templateBase64 = await getPcTemplateFromStorage(supabase, slot.file_url);
  } else {
    templateBase64 = await getTemplateFromStorage(supabase, contractor_id, document_type);
  }

  const { accessToken, accountId, baseUri } = tokenInfo;

  // Build envelope definition
  const documentId = "1";
  const textTabs = buildTextTabs(autoFields, documentId, document_type);
  const homeownerTabs = buildSignerTabs(documentId, "homeowner");
  const contractorTabs = buildSignerTabs(documentId, "contractor");

  let contractorEmail = autoFields.contractor_email || "contractor@example.com";
  let contractorName = autoFields.contractor_name || "Contractor";

  const docLabel = getDocumentLabel(document_type);

  // For contract type, also generate the compliance addendum
  const documents: any[] = [
    {
      documentBase64: templateBase64,
      name: docLabel,
      fileExtension: "pdf",
      documentId,
    },
  ];

  if (document_type === "contract") {
    const contractDate = new Date().toLocaleDateString("en-US");
    const addendumBase64 = generateComplianceAddendumPdf(
      contractorName,
      autoFields.customer_name || signer.name || "Homeowner",
      contractDate
    );
    documents.push({
      documentBase64: addendumBase64,
      name: "IC 24-5-11 Compliance Addendum",
      fileExtension: "pdf",
      documentId: "2",
    });
  }

  const envelopeDefinition = {
    emailSubject: `${docLabel} — OtterQuote (Claim ${claim_id.slice(0, 8)})`,
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
            ...(document_type === "contract" ? buildAddendumTabs("2") : {}),
          },
        },
        {
          email: contractorEmail,
          name: contractorName,
          recipientId: "2",
          routingOrder: "2",
          clientUserId: "contractor_1",
          tabs: {
            ...contractorTabs,
          },
        },
      ],
    },
    status: "sent",
  };

  console.log(`Creating DocuSign envelope (legacy: ${document_type})`);
  const envelopeResponse = await fetch(
    `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(envelopeDefinition),
    }
  );

  if (!envelopeResponse.ok) {
    const errorData = await envelopeResponse.text();
    console.error("DocuSign envelope creation failed:", errorData);
    throw new Error(`Failed to create envelope: ${envelopeResponse.status} ${errorData}`);
  }

  const envelopeData = await envelopeResponse.json();
  const envelopeId = envelopeData.envelopeId;
  if (!envelopeId) throw new Error("No envelopeId returned from DocuSign");

  console.log(`Envelope created (${document_type}): ${envelopeId}`);

  // Generate embedded signing URL
  const defaultReturnUrl = document_type === "project_confirmation"
    ? `https://otterquote.com/project-confirmation.html?claim_id=${claim_id}&signed=true`
    : "https://otterquote.com/contract-signing.html?signed=true";
  const signingReturnUrl = return_url || defaultReturnUrl;

  const recipientViewResponse = await fetch(
    `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}/views/recipient`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        returnUrl: signingReturnUrl,
        authenticationMethod: "none",
        email: signer.email,
        userName: signer.name,
        clientUserId: "homeowner_1",
      }),
    }
  );

  if (!recipientViewResponse.ok) {
    const errorData = await recipientViewResponse.text();
    throw new Error(`Failed to generate signing URL: ${recipientViewResponse.status} ${errorData}`);
  }

  const recipientViewData = await recipientViewResponse.json();
  const signingUrl = recipientViewData.url;
  if (!signingUrl) throw new Error("No URL returned from DocuSign recipient view endpoint");

  // Update claim in Supabase
  const updateData: any = {
    contract_sent_at: new Date().toISOString(),
  };

  if (document_type === "contract") {
    updateData.docusign_envelope_id = envelopeId;
  } else if (document_type === "color_confirmation") {
    updateData.color_confirmation_envelope_id = envelopeId;
  } else if (document_type === "project_confirmation") {
    updateData.project_confirmation_envelope_id = envelopeId;
  }

  const { error: updateError } = await supabase
    .from("claims")
    .update(updateData)
    .eq("id", claim_id);

  if (updateError) {
    console.error("Failed to update claim:", updateError);
  }

  return new Response(
    JSON.stringify({
      success: true,
      envelope_id: envelopeId,
      signing_url: signingUrl,
      status: "sent",
      document_type,
      signer_email: signer.email,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// ========== MAIN HANDLER ==========
serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const requestBody = await req.json();
    const {
      claim_id,
      document_type,
      contractor_id,
      signer,
    } = requestBody;

    // ========== INPUT VALIDATION ==========
    if (!claim_id || !document_type || !contractor_id || !signer?.email || !signer?.name) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields",
          required: ["claim_id", "document_type", "contractor_id", "signer.email", "signer.name"],
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const validDocTypes = ["contract", "contractor_sign", "homeowner_sign", "color_confirmation", "project_confirmation"];
    if (!validDocTypes.includes(document_type)) {
      return new Response(
        JSON.stringify({
          error: `document_type must be one of: ${validDocTypes.join(", ")}`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ========== RATE LIMIT CHECK ==========
    // Skip rate limit for homeowner_sign (no new envelope created)
    if (document_type !== "homeowner_sign") {
      const { data: rateLimitResult, error: rlError } = await supabase.rpc("check_rate_limit", {
        p_function_name: FUNCTION_NAME,
        p_user_id: claim_id || null,
      });

      if (rlError) {
        console.error("Rate limit check failed:", rlError);
        return new Response(
          JSON.stringify({
            error: "Rate limit check failed. Refusing to create envelope for safety.",
            detail: rlError.message,
          }),
          { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (!rateLimitResult?.allowed) {
        console.warn(`RATE LIMITED [${FUNCTION_NAME}]: ${rateLimitResult?.reason}`);
        return new Response(
          JSON.stringify({
            error: "Rate limit exceeded",
            reason: rateLimitResult?.reason,
            counts: rateLimitResult?.counts,
          }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ========== DOCUSIGN CONFIG ==========
    const REST_API_BASE = Deno.env.get("DOCUSIGN_BASE_URI") || Deno.env.get("DOCUSIGN_BASE_URL") || "https://demo.docusign.net";

    const INTEGRATION_KEY = Deno.env.get("DOCUSIGN_INTEGRATION_KEY");
    if (!INTEGRATION_KEY) {
      throw new Error("DocuSign credentials not configured. Set DOCUSIGN_INTEGRATION_KEY.");
    }

    // ========== GET ACCESS TOKEN + ACCOUNT INFO ==========
    console.log("Acquiring DocuSign access token");
    const tokenInfo = await getAccessToken(REST_API_BASE);

    // ========== ROUTE BY DOCUMENT TYPE ==========
    switch (document_type) {
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

    const message =
      error instanceof Error
        ? error.message
        : "An unexpected error occurred";

    return new Response(
      JSON.stringify({
        error: message,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
