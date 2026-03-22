/**
 * OtterQuote Edge Function: create-docusign-envelope
 * Creates a DocuSign envelope for contract signing with JWT Grant auth flow.
 * Auto-populates contractor templates with claim data using anchor-based tabs.
 * Rate-limited via Supabase check_rate_limit() RPC.
 * Supports document types: "contract" and "color_confirmation"
 *
 * Environment variables:
 *   DOCUSIGN_INTEGRATION_KEY
 *   DOCUSIGN_USER_ID
 *   DOCUSIGN_ACCOUNT_ID
 *   DOCUSIGN_RSA_PRIVATE_KEY (base64 encoded PEM)
 *   DOCUSIGN_BASE_URL (default: https://account-d.docusign.com for sandbox)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "create-docusign-envelope";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ========== TOKEN CACHE ==========
interface CachedToken {
  accessToken: string;
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

async function importRsaPrivateKey(pemBase64: string): Promise<CryptoKey> {
  const pemBinary = atob(pemBase64);
  const pemBytes = new Uint8Array(pemBinary.split("").map((c) => c.charCodeAt(0)));
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
async function getAccessToken(baseUrl: string): Promise<string> {
  const now = Date.now();

  // Return cached token if valid (with 5-minute buffer)
  if (cachedToken && cachedToken.expiresAt > now + 300000) {
    console.log("Using cached DocuSign access token");
    return cachedToken.accessToken;
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

  // Cache token (valid for 1 hour, cache with 5-minute buffer)
  cachedToken = {
    accessToken,
    expiresAt: now + 3600000 - 300000,
  };

  return accessToken;
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

function base64EncodeBinary(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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
  // Mapping of field names to anchor strings
  const fieldAnchors: { [key: string]: string } = {
    // Contract fields
    customer_name: "Name",
    customer_address: "Address:",
    customer_city_zip: "City/Zip:",
    customer_phone: "Phone",
    customer_email: "Email:",
    insurance_company: "Insurance Co",
    claim_number: "Claim #",
    deductible: "DEDUCTIBLE:",
    // Color confirmation fields
    shingle_manufacturer: "Single Manufacture",
    shingle_type: "Shingle Type:",
    shingle_color: "Shingle Color:",
    drip_edge_color: "Drip Edge Color:",
    vents: "Vents",
    satellite: "Satellite",
    skylights: "Skylights",
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
      fontSize: "10",
      documentId,
    });
  }

  return tabs;
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

// ========== MAIN HANDLER ==========
serve(async (req) => {
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
      fields,
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

    if (!["contract", "color_confirmation"].includes(document_type)) {
      return new Response(
        JSON.stringify({
          error: 'document_type must be "contract" or "color_confirmation"',
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ========== RATE LIMIT CHECK ==========
    const { data: rateLimitResult, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_function_name: FUNCTION_NAME,
      p_caller_id: claim_id || null,
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
    // ========== END RATE LIMIT CHECK ==========

    // ========== DOCUSIGN CONFIG ==========
    const INTEGRATION_KEY = Deno.env.get("DOCUSIGN_INTEGRATION_KEY");
    const ACCOUNT_ID = Deno.env.get("DOCUSIGN_ACCOUNT_ID");
    const BASE_URL = Deno.env.get("DOCUSIGN_BASE_URL") || "https://account-d.docusign.com";

    if (!INTEGRATION_KEY || !ACCOUNT_ID) {
      throw new Error(
        "DocuSign credentials not configured. Set DOCUSIGN_INTEGRATION_KEY and DOCUSIGN_ACCOUNT_ID."
      );
    }

    // ========== FETCH TEMPLATE PDF ==========
    console.log(`Fetching template: ${contractor_id}/${document_type}.pdf`);
    const templateBase64 = await getTemplateFromStorage(supabase, contractor_id, document_type);

    // ========== GET ACCESS TOKEN ==========
    console.log("Acquiring DocuSign access token");
    const accessToken = await getAccessToken(BASE_URL);

    // ========== BUILD ENVELOPE DEFINITION ==========
    const documentId = "1";
    const textTabs = buildTextTabs(fields || {}, documentId, document_type);

    // Homeowner (recipient 1)
    const homeownerTabs = buildSignerTabs(documentId, "homeowner");

    // Contractor (recipient 2)
    const contractorTabs = buildSignerTabs(documentId, "contractor");

    const envelopeDefinition = {
      emailSubject: `${
        document_type === "contract" ? "Repair Contract" : "Color Confirmation"
      } — OtterQuote (Claim ${claim_id.slice(0, 8)})`,
      documents: [
        {
          documentBase64: templateBase64,
          name:
            document_type === "contract"
              ? "Repair Contract"
              : "Color Confirmation Form",
          fileExtension: "pdf",
          documentId,
        },
      ],
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
            },
          },
          {
            email: "contractor@example.com", // Placeholder; normally provided separately
            name: "Contractor",
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

    // ========== CREATE ENVELOPE ==========
    console.log("Creating DocuSign envelope");
    const envelopeResponse = await fetch(
      `${BASE_URL}/restapi/v2.1/accounts/${ACCOUNT_ID}/envelopes`,
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
      throw new Error(
        `Failed to create envelope: ${envelopeResponse.status} ${errorData}`
      );
    }

    const envelopeData = await envelopeResponse.json();
    const envelopeId = envelopeData.envelopeId;

    if (!envelopeId) {
      throw new Error("No envelopeId returned from DocuSign");
    }

    console.log(`Envelope created: ${envelopeId}`);

    // ========== GENERATE EMBEDDED SIGNING URL ==========
    console.log("Generating embedded signing URL for homeowner");
    const recipientViewResponse = await fetch(
      `${BASE_URL}/restapi/v2.1/accounts/${ACCOUNT_ID}/envelopes/${envelopeId}/views/recipient`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          returnUrl: "https://otterquote.com/contract-signing.html?signed=true",
          authenticationMethod: "none",
          email: signer.email,
          userName: signer.name,
          clientUserId: "homeowner_1",
        }),
      }
    );

    if (!recipientViewResponse.ok) {
      const errorData = await recipientViewResponse.text();
      console.error("Embedded signing URL generation failed:", errorData);
      throw new Error(
        `Failed to generate signing URL: ${recipientViewResponse.status} ${errorData}`
      );
    }

    const recipientViewData = await recipientViewResponse.json();
    const signingUrl = recipientViewData.url;

    if (!signingUrl) {
      throw new Error("No URL returned from DocuSign recipient view endpoint");
    }

    console.log("Signing URL generated successfully");

    // ========== UPDATE CLAIM IN SUPABASE ==========
    const updateData: any = {
      contract_sent_at: new Date().toISOString(),
    };

    if (document_type === "contract") {
      updateData.docusign_envelope_id = envelopeId;
    } else if (document_type === "color_confirmation") {
      updateData.color_confirmation_envelope_id = envelopeId;
    }

    const { error: updateError } = await supabase
      .from("claims")
      .update(updateData)
      .eq("id", claim_id);

    if (updateError) {
      console.error("Failed to update claim:", updateError);
      throw new Error(`Failed to update claim: ${updateError.message}`);
    }

    // ========== SUCCESS RESPONSE ==========
    return new Response(
      JSON.stringify({
        success: true,
        envelope_id: envelopeId,
        signing_url: signingUrl,
        status: "sent",
        document_type,
        signer_email: signer.email,
        rate_limit_counts: rateLimitResult?.counts,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
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
