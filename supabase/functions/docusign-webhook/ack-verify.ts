/**
 * D-269 (#550) — otterquote_acknowledgment server-side backstop helpers.
 *
 * The PLATFORM DISCLOSURE acknowledgment is enforced at signing time by the
 * D-123 signHere tab in create-docusign-envelope (checkboxTab required:"true"
 * was unreliable in embedded signing — 2026-05-20 error-log evidence). This
 * module is the completion-side verification layer: given the signers of a
 * COMPLETED contract envelope, decide whether the acknowledgment tab is
 * verifiably satisfied.
 *
 * evaluateAcknowledgment() is pure (unit-tested in ack-verify.test.ts).
 * fetchEnvelopeSignersWithTabs() queries the eSignature API for the
 * authoritative recipients+tabs state, because Connect payloads normally
 * omit tab data. JWT/JWT-grant plumbing mirrors create-docusign-envelope
 * (inlined per the no-_shared-imports precedent; local module imports like
 * ./payload-parser.ts bundle fine).
 *
 * Invariant (CEO decision D-269, 2026-07-13): no silently-accepted contract
 * without the acknowledgment.
 */

export const ACK_TAB_LABEL = "otterquote_acknowledgment";

export type AckEvaluation =
  | { state: "satisfied"; via: "signhere" | "checkbox" }
  | { state: "defect"; via: "signhere" | "checkbox" | "tab_missing"; detail: string }
  | { state: "indeterminate"; detail: string };

interface TabLike {
  tabLabel?: string;
  status?: string;
  selected?: string;
}

interface SignerLike {
  clientUserId?: string;
  tabs?: {
    signHereTabs?: TabLike[];
    checkboxTabs?: TabLike[];
  };
}

/**
 * Evaluate the acknowledgment tab state across an envelope's signers.
 *
 * - signHere tab (D-123, current envelopes): satisfied only when EVERY
 *   matching tab has status "signed" (anchor tabs stamp at every anchor
 *   occurrence, so more than one match is possible — all must be signed).
 * - checkbox tab (pre-D-123 envelopes): satisfied only when EVERY matching
 *   tab has selected "true".
 * - Tab data present but no acknowledgment tab found → defect (tab_missing):
 *   a contract envelope without the tab cannot demonstrate acknowledgment.
 * - No signer carries any tab data → indeterminate (caller should fetch the
 *   authoritative state from the eSignature API).
 */
export function evaluateAcknowledgment(signers: unknown[]): AckEvaluation {
  let sawTabData = false;
  const signHereMatches: TabLike[] = [];
  const checkboxMatches: TabLike[] = [];

  for (const s of (signers as SignerLike[]) || []) {
    const tabs = s?.tabs;
    if (!tabs || typeof tabs !== "object") continue;
    sawTabData = true;
    for (const t of tabs.signHereTabs || []) {
      if (t?.tabLabel === ACK_TAB_LABEL) signHereMatches.push(t);
    }
    for (const t of tabs.checkboxTabs || []) {
      if (t?.tabLabel === ACK_TAB_LABEL) checkboxMatches.push(t);
    }
  }

  if (!sawTabData) {
    return { state: "indeterminate", detail: "no tab data on any signer" };
  }

  if (signHereMatches.length > 0) {
    const unsigned = signHereMatches.filter(
      (t) => String(t.status || "").toLowerCase() !== "signed",
    );
    if (unsigned.length === 0) return { state: "satisfied", via: "signhere" };
    return {
      state: "defect",
      via: "signhere",
      detail: `${unsigned.length}/${signHereMatches.length} ${ACK_TAB_LABEL} signHere tab(s) not signed (status: ${unsigned
        .map((t) => t.status || "absent")
        .join(",")})`,
    };
  }

  if (checkboxMatches.length > 0) {
    const unchecked = checkboxMatches.filter(
      (t) => String(t.selected || "").toLowerCase() !== "true",
    );
    if (unchecked.length === 0) return { state: "satisfied", via: "checkbox" };
    return {
      state: "defect",
      via: "checkbox",
      detail: `${unchecked.length}/${checkboxMatches.length} ${ACK_TAB_LABEL} checkbox tab(s) unchecked`,
    };
  }

  return {
    state: "defect",
    via: "tab_missing",
    detail: `tab data present but no ${ACK_TAB_LABEL} tab on any signer`,
  };
}

// ═════════════════════════ DocuSign eSignature API ══════════════════════════
// JWT-grant auth mirroring create-docusign-envelope (same project secrets:
// DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID, DOCUSIGN_RSA_PRIVATE_KEY,
// DOCUSIGN_BASE_URI/DOCUSIGN_BASE_URL).

function base64urlEncode(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ASN.1 DER helper for PKCS#1 -> PKCS#8 wrapping (SP #5 — the DocuSign key is
// PKCS#1 format; crypto.subtle only imports PKCS#8).
function encodeAsn1TLV(tag: number, content: Uint8Array): Uint8Array {
  const len = content.length;
  let header: Uint8Array;
  if (len < 128) header = new Uint8Array([tag, len]);
  else if (len < 256) header = new Uint8Array([tag, 0x81, len]);
  else header = new Uint8Array([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
  const out = new Uint8Array(header.length + len);
  out.set(header, 0);
  out.set(content, header.length);
  return out;
}

function wrapPkcs1InPkcs8(pkcs1Der: Uint8Array): Uint8Array {
  const algId = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const octetString = encodeAsn1TLV(0x04, pkcs1Der);
  const inner = new Uint8Array(version.length + algId.length + octetString.length);
  inner.set(version, 0);
  inner.set(algId, version.length);
  inner.set(octetString, version.length + algId.length);
  return encodeAsn1TLV(0x30, inner);
}

async function importRsaPrivateKey(pemBase64: string): Promise<CryptoKey> {
  const b64 = pemBase64
    .replace(/-----BEGIN[^-]*-----/g, "")
    .replace(/-----END[^-]*-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const algo = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  try {
    return await crypto.subtle.importKey("pkcs8", der as BufferSource, algo, false, ["sign"]);
  } catch {
    return await crypto.subtle.importKey(
      "pkcs8",
      wrapPkcs1InPkcs8(der) as BufferSource,
      algo,
      false,
      ["sign"],
    );
  }
}

async function createJwtAssertion(
  integrationKey: string,
  userId: string,
  baseUrl: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const aud =
    baseUrl.includes("demo") || baseUrl.includes("account-d")
      ? "account-d.docusign.com"
      : "account.docusign.com";
  const payload = {
    iss: integrationKey,
    sub: userId,
    aud,
    iat: now,
    exp: now + 3600,
    scope: "signature impersonation",
  };
  const header = { alg: "RS256", typ: "JWT" };
  const signingInput = `${base64urlEncode(JSON.stringify(header))}.${base64urlEncode(JSON.stringify(payload))}`;
  const rsaPrivateKeyB64 = Deno.env.get("DOCUSIGN_RSA_PRIVATE_KEY");
  if (!rsaPrivateKeyB64) {
    throw new Error("DOCUSIGN_RSA_PRIVATE_KEY not configured");
  }
  const cryptoKey = await importRsaPrivateKey(rsaPrivateKeyB64);
  const signatureBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64urlEncode(new Uint8Array(signatureBuffer))}`;
}

interface CachedToken {
  accessToken: string;
  accountId: string;
  baseUri: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

async function getAccessToken(): Promise<CachedToken> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 300000) return cachedToken;

  const integrationKey = Deno.env.get("DOCUSIGN_INTEGRATION_KEY");
  const userId = Deno.env.get("DOCUSIGN_USER_ID");
  if (!integrationKey || !userId) {
    throw new Error("DocuSign JWT auth not configured (DOCUSIGN_INTEGRATION_KEY / DOCUSIGN_USER_ID)");
  }
  const baseUrl =
    Deno.env.get("DOCUSIGN_BASE_URI") || Deno.env.get("DOCUSIGN_BASE_URL") || "https://demo.docusign.net";
  const jwtAssertion = await createJwtAssertion(integrationKey, userId, baseUrl);
  const oauthHost =
    baseUrl.includes("demo") || baseUrl.includes("account-d")
      ? "https://account-d.docusign.com"
      : "https://account.docusign.com";

  const tokenResponse = await fetch(`${oauthHost}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwtAssertion}`,
  });
  if (!tokenResponse.ok) {
    throw new Error(`DocuSign token request failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  }
  const tokenData = await tokenResponse.json();
  if (!tokenData.access_token) throw new Error("No access_token in DocuSign response");

  const userInfoResponse = await fetch(`${oauthHost}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!userInfoResponse.ok) {
    throw new Error(`DocuSign userinfo request failed: ${userInfoResponse.status} ${await userInfoResponse.text()}`);
  }
  const userInfo = await userInfoResponse.json();
  const account =
    userInfo.accounts?.find((a: { is_default?: boolean }) => a.is_default) || userInfo.accounts?.[0];
  if (!account?.account_id) {
    throw new Error("Could not determine DocuSign account ID from userinfo");
  }
  cachedToken = {
    accessToken: tokenData.access_token,
    accountId: account.account_id,
    baseUri: account.base_uri || baseUrl,
    expiresAt: now + 3600000 - 300000,
  };
  return cachedToken;
}

/**
 * Fetch the authoritative signers-with-tabs state for an envelope from the
 * eSignature API (GET .../recipients?include_tabs=true). Throws on any
 * auth/HTTP failure — the caller decides the fail-open/closed posture.
 */
export async function fetchEnvelopeSignersWithTabs(envelopeId: string): Promise<unknown[]> {
  const { accessToken, accountId, baseUri } = await getAccessToken();
  const res = await fetch(
    `${baseUri}/restapi/v2.1/accounts/${accountId}/envelopes/${envelopeId}/recipients?include_tabs=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new Error(`DocuSign recipients request failed: ${res.status} ${await res.text()}`);
  }
  const recipients = await res.json();
  return recipients?.signers || [];
}
