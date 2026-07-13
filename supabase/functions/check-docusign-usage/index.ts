/**
 * OtterQuote Edge Function: check-docusign-usage
 *
 * Runs daily at noon UTC (pg_cron job 9: "0 12 * * *").
 * - Fetches current billing-period envelope usage via DocuSign REST API
 * - Compares against hardcoded monthly limit (40 - "Basic API Plan - Monthly - 40")
 * - Sends Mailgun alert to dustinstohler1@gmail.com if usage >= 75% (30 of 40 envelopes;
 *   changed from >80% on 2026-07-12, P7 launch-hardening: alert must fire AT 30, not 33)
 * - Logs result to cron_health table via record_cron_health() RPC (key: docusign-usage)
 * - Returns { used, limit, percentUsed, alertSent }
 *
 * No JWT required - internal cron-invoked function.
 * Deploy: supabase functions deploy check-docusign-usage --use-api --no-verify-jwt
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Plan limit: "Basic API Plan - Monthly - 40"
// API returns "unlimited" for billingPeriodEnvelopesAllowed, so hardcode from plan name.
const MONTHLY_LIMIT = 40;
const ALERT_THRESHOLD_PCT = 75;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://otterquote.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface CachedToken {
  accessToken: string;
  accountId: string;
  baseUri: string;
  expiresAt: number;
}
let cachedToken: CachedToken | null = null;

// ---- JWT utilities ----

function base64urlEncode(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ASN.1 DER helper for PKCS#1 -> PKCS#8 wrapping
function encodeAsn1TLV(tag: number, content: Uint8Array): Uint8Array {
  const len = content.length;
  let header: Uint8Array;
  if (len < 128) {
    header = new Uint8Array([tag, len]);
  } else if (len < 256) {
    header = new Uint8Array([tag, 0x81, len]);
  } else {
    header = new Uint8Array([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
  }
  const out = new Uint8Array(header.length + len);
  out.set(header, 0);
  out.set(content, header.length);
  return out;
}

function wrapPkcs1InPkcs8(pkcs1Der: Uint8Array): Uint8Array {
  // AlgorithmIdentifier SEQUENCE { OID rsaEncryption, NULL }
  const algId = new Uint8Array([
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const octetString = encodeAsn1TLV(0x04, pkcs1Der);
  const inner = new Uint8Array(version.length + algId.length + octetString.length);
  inner.set(version, 0);
  inner.set(algId, version.length);
  inner.set(octetString, version.length + algId.length);
  return encodeAsn1TLV(0x30, inner);
}

async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN[^-]*-----/g, "")
    .replace(/-----END[^-]*-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const algo = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  // Try PKCS#8 first; fall back to wrapping PKCS#1
  try {
    return await crypto.subtle.importKey("pkcs8", der, algo, false, ["sign"]);
  } catch {
    return await crypto.subtle.importKey("pkcs8", wrapPkcs1InPkcs8(der), algo, false, ["sign"]);
  }
}

async function createJwtAssertion(integrationKey: string, userId: string, baseUrl: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const aud = baseUrl.includes("demo") || baseUrl.includes("account-d")
    ? "account-d.docusign.com"
    : "account.docusign.com";

  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iss: integrationKey, sub: userId, aud, iat: now, exp: now + 3600, scope: "signature impersonation" };

  const signingInput = base64urlEncode(JSON.stringify(header)) + "." + base64urlEncode(JSON.stringify(payload));

  const rsaKey = Deno.env.get("DOCUSIGN_RSA_PRIVATE_KEY");
  if (!rsaKey) throw new Error("DOCUSIGN_RSA_PRIVATE_KEY secret not set.");

  const cryptoKey = await importRsaPrivateKey(rsaKey);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
  return signingInput + "." + base64urlEncode(new Uint8Array(sig));
}

async function getAccessToken(baseUrl: string): Promise<CachedToken> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 300_000) return cachedToken;

  const integrationKey = Deno.env.get("DOCUSIGN_INTEGRATION_KEY");
  const userId = Deno.env.get("DOCUSIGN_USER_ID");
  if (!integrationKey || !userId) throw new Error("DOCUSIGN_INTEGRATION_KEY or DOCUSIGN_USER_ID not set.");

  const jwtAssertion = await createJwtAssertion(integrationKey, userId, baseUrl);
  const oauthHost = baseUrl.includes("demo") || baseUrl.includes("account-d")
    ? "https://account-d.docusign.com"
    : "https://account.docusign.com";

  const tokenRes = await fetch(`${oauthHost}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwtAssertion}`,
  });
  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`DocuSign token request failed: ${tokenRes.status} ${err}`);
  }
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;
  if (!accessToken) throw new Error("No access_token in DocuSign response");

  const userInfoRes = await fetch(`${oauthHost}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!userInfoRes.ok) {
    const err = await userInfoRes.text();
    throw new Error(`DocuSign userinfo failed: ${userInfoRes.status} ${err}`);
  }
  const userInfo = await userInfoRes.json();
  const account = userInfo.accounts?.find((a: any) => a.is_default) || userInfo.accounts?.[0];
  if (!account?.account_id) throw new Error(`Cannot determine DocuSign account ID: ${JSON.stringify(userInfo)}`);

  cachedToken = {
    accessToken,
    accountId: account.account_id,
    baseUri: account.base_uri || baseUrl,
    expiresAt: now + 3_600_000 - 300_000,
  };
  return cachedToken;
}

// ---- Mailgun alert ----

async function sendMailgunAlert(used: number, limit: number, pct: number): Promise<void> {
  const mailgunKey = Deno.env.get("MAILGUN_API_KEY");
  if (!mailgunKey) {
    console.warn("[check-docusign-usage] MAILGUN_API_KEY not set - skipping alert");
    return;
  }

  const subject = `[ALERT] DocuSign envelope usage at ${pct}% of monthly limit - ${used}/${limit} used`;
  const body = [
    "DocuSign envelope usage has reached the 75% alert threshold (30 of 40 envelopes).",
    "",
    `Plan: Basic API Plan - Monthly - 40`,
    `Used this billing period: ${used}`,
    `Monthly limit: ${limit}`,
    `Usage: ${pct}%`,
    "",
    "If this pace continues, envelopes may be exhausted before the billing period ends.",
    "Consider reviewing pending contracts or upgrading the DocuSign plan.",
    "Runbook: CEO/CTO/Runbooks/docusign-quota.md",
    "",
    "-- OtterQuote Platform Monitor",
  ].join("\n");

  const form = new URLSearchParams();
  form.set("from", "OtterQuote Monitor <no-reply@mail.otterquote.com>");
  form.set("to", "dustinstohler1@gmail.com");
  form.set("subject", subject);
  form.set("text", body);

  const res = await fetch("https://api.mailgun.net/v3/mail.otterquote.com/messages", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa("api:" + mailgunKey) },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Mailgun send failed: ${res.status} ${err}`);
  }
  console.log("[check-docusign-usage] Alert email sent");
}

// ---- cron_health helper ----

async function writeCronHealth(supabase: any, status: "success" | "error", meta: Record<string, unknown>): Promise<void> {
  try {
    await supabase.rpc("record_cron_health", {
      p_job_name: "docusign-usage",
      p_status: status,
      p_error: JSON.stringify(meta),
    });
  } catch (e) {
    console.warn("[check-docusign-usage] cron_health write failed (non-fatal):", e);
  }
}

// ---- Main handler ----

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const baseUrl = Deno.env.get("DOCUSIGN_BASE_URI") || "https://na3.docusign.net";

  try {
    console.log("[check-docusign-usage] Fetching DocuSign access token...");
    const { accessToken, accountId, baseUri } = await getAccessToken(baseUrl);

    console.log("[check-docusign-usage] Fetching account info for", accountId);
    const accountRes = await fetch(`${baseUri}/restapi/v2.1/accounts/${accountId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    if (!accountRes.ok) {
      const err = await accountRes.text();
      throw new Error(`DocuSign account fetch failed: ${accountRes.status} ${err}`);
    }
    const accountData = await accountRes.json();

    const used = parseInt(accountData.billingPeriodEnvelopesSent ?? "0", 10);
    const limit = MONTHLY_LIMIT;
    const percentUsed = Math.round((used / limit) * 100);

    console.log(`[check-docusign-usage] Usage: ${used}/${limit} (${percentUsed}%)`);

    let alertSent = false;
    if (percentUsed >= ALERT_THRESHOLD_PCT) {
      console.log(`[check-docusign-usage] Usage ${percentUsed}% >= ${ALERT_THRESHOLD_PCT}% - sending alert`);
      await sendMailgunAlert(used, limit, percentUsed);
      alertSent = true;
    }

    const metadata = { used, limit, percentUsed, alertSent };
    await writeCronHealth(supabase, "success", metadata);

    return new Response(JSON.stringify(metadata), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[check-docusign-usage] Fatal error:", err);
    const errMsg = err instanceof Error ? err.message : String(err);
    await writeCronHealth(supabase, "error", { error: errMsg });
    return new Response(JSON.stringify({ error: errMsg }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
