/**
 * OtterQuote Edge Function: check-docusign-usage
 *
 * Runs daily at noon UTC (pg_cron job 9: "0 12 * * *").
 * - Fetches current billing-period envelope usage via DocuSign REST API
 * - Compares against the hardcoded monthly limit (40 — "Basic API Plan - Monthly - 40")
 * - Sends a Mailgun alert to dustinstohler1@gmail.com if usage > 80%
 * - Logs result to cron_health table via record_cron_health() RPC
 * - Returns { used, limit, percentUsed, alertSent }
 *
 * No JWT required — internal cron-invoked function.
 * Deploy: supabase functions deploy check-docusign-usage --use-api --no-verify-jwt
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Plan limit ─────────────────────────────────────────────────────────────
// DocuSign "Basic API Plan - Monthly - 40" — API returns "unlimited" for
// billingPeriodEnvelopesAllowed, so we hardcode the true limit from the plan name.
const MONTHLY_LIMIT = 40;
const ALERT_THRESHOLD = 0.8; // 80%

// ── CORS (not needed for cron calls, but required for OPTIONS preflight) ────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://otterquote.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Token cache ─────────────────────────────────────────────────────────────
interface CachedToken {
  accessToken: string;
  accountId: string;
  baseUri: string;
  expiresAt: number;
}
let cachedToken: CachedToken | null = null;

// ── JWT utilities (identical to create-docusign-envelope) ───────────────────
function base64urlEncode(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const binary = String.fromCharCode(...bytes);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function importRsaPrivateKey(pemBase64: string): Promise<CryptoKey> {
  const b64 = pemBase64
    .replace(/-----BEGIN[^-]*-----/g, "")
    .replace(/-----END[^-]*-----/g, "")
    .replace(/\s+/g, "");
  const pemBinary = atob(b64);
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
  const aud =
    baseUrl.includes("demo") || baseUrl.includes("account-d")
      ? "account-d.docusign.com"
      : "account.docusign.com";

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: integrationKey,
    sub: userId,
    aud,
    iat: now,
    exp: now + 3600,
    scope: "signature impersonation",
  };

  const headerEncoded = base64urlEncode(JSON.stringify(header));
  const payloadEncoded = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${headerEncoded}.${payloadEncoded}`;

  const rsaPrivateKeyB64 = Deno.env.get("DOCUSIGN_RSA_PRIVATE_KEY");
  if (!rsaPrivateKeyB64) {
    throw new Error("DOCUSIGN_RSA_PRIVATE_KEY secret not set.");
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

async function getAccessToken(baseUrl: string): Promise<CachedToken> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 300_000) {
    return cachedToken;
  }

  const integrationKey = Deno.env.get("DOCUSIGN_INTEGRATION_KEY");
  const userId = Deno.env.get("DOCUSIGN_USER_ID");
  if (!integrationKey || !userId) {
    throw new Error("DOCUSIGN_INTEGRATION_KEY or DOCUSIGN_USER_ID not set.");
  }

  const jwtAssertion = await createJwtAssertion(integrationKey, userId, baseUrl);
  const oauthHost =
    baseUrl.includes("demo") || baseUrl.includes("account-d")
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
    throw new Error(`DocuSign userinfo request failed: ${userInfoRes.status} ${err}`);
  }
  const userInfo = await userInfoRes.json();
  const account =
    userInfo.accounts?.find((a: any) => a.is_default) || userInfo.accounts?.[0];
  if (!account?.account_id) {
    throw new Error(`Could not determine DocuSign account ID: ${JSON.stringify(userInfo)}`);
  }

  cachedToken = {
    accessToken,
    accountId: account.account_id,
    baseUri: account.base_uri || baseUrl,
    expiresAt: now + 3_600_000 - 300_000,
  };
  return cachedToken;
}

// ── Mailgun alert ───────────────────────────────────────────────────────────
async function sendMailgunAlert(used: number, limit: number, pct: number): Promise<void> {
  const mailgunKey = Deno.env.get("MAILGUN_API_KEY");
  if (!mailgunKey) {
    console.warn("[check-docusign-usage] MAILGUN_API_KEY not set — skipping alert");
    return;
  }

  const subject = `⚠️ DocuSign envelope usage at ${pct}% of monthly limit — ${used}/${limit} used`;
  const body = [
    `DocuSign envelope usage has exceeded the 80% alert threshold.`,
    ``,
    `Plan: Basic API Plan - Monthly - 40`,
    `Used this billing period: ${used}`,
    `Monthly limit: ${limit}`,
    `Usage: ${pct}%`,
    ``,
    `If this pace continues, envelopes will be exhausted before the billing period ends.`,
    `Consider reviewing pending contracts or upgrading the DocuSign plan.`,
    ``,
    `— OtterQuote Platform Monitor`,
  ].join("\n");

  const form = new URLSearchParams();
  form.set("from", "OtterQuote Monitor <no-reply@mail.otterquote.com>");
  form.set("to", "dustinstohler1@gmail.com");
  form.set("subject", subject);
  form.set("text", body);

  const res = await fetch("https://api.mailgun.net/v3/mail.otterquote.com/messages", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa("api:" + mailgunKey)}`,
    },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("[check-docusign-usage] Mailgun alert failed:", res.status, err);
    throw new Error(`Mailgun send failed: ${res.status} ${err}`);
  }
  console.log("[check-docusign-usage] Alert email sent successfully");
}

// ── cron_health helper ──────────────────────────────────────────────────────
async function writeCronHealth(
  supabase: any,
  status: "success" | "error",
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    // Store metadata JSON in p_error even on success so the admin panel can
    // surface usage/limit/percentUsed without a schema change.
    await supabase.rpc("record_cron_health", {
      p_job_name: "docusign-usage",
      p_status: status,
      p_error: JSON.stringify(metadata),
    });
  } catch (e) {
    console.warn("[check-docusign-usage] cron_health write failed (non-fatal):", e);
  }
}

// ── Main handler ────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const baseUrl = Deno.env.get("DOCUSIGN_BASE_URI") || "https://na3.docusign.net";

  try {
    // ── 1. Get DocuSign access token ────────────────────────────────────────
    console.log("[check-docusign-usage] Fetching DocuSign access token…");
    const { accessToken, accountId, baseUri } = await getAccessToken(baseUrl);

    // ── 2. Fetch account info for billing period envelope counts ───────────
    console.log(`[check-docusign-usage] Fetching account info for ${accountId}…`);
    const accountRes = await fetch(
      `${baseUri}/restapi/v2.1/accounts/${accountId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (!accountRes.ok) {
      const err = await accountRes.text();
      throw new Error(`DocuSign account fetch failed: ${accountRes.status} ${err}`);
    }
    const accountData = await accountRes.json();

    const usedRaw = accountData.billingPeriodEnvelopesSent;
    const used = parseInt(usedRaw ?? "0", 10);
    const limit = MONTHLY_LIMIT;
    const percentUsed = Math.round((used / limit) * 100);

    console.log(
      `[check-docusign-usage] Usage: ${used}/${limit} (${percentUsed}%) — billing period: ${accountData.billingPeriodStartDate ?? "?"} to ${accountData.billingPeriodEndDate ?? "?"}`
    );

    // ── 3. Send Mailgun alert if threshold exceeded ─────────────────────────
    let alertSent = false;
    if (percentUsed > ALERT_THRESHOLD * 100) {
      console.log(`[check-docusign-usage] Usage ${percentUsed}% > 80% — sending alert…`);
      await sendMailgunAlert(used, limit, percentUsed);
      alertSent = true;
    }

    // ── 4. Log to cron_health ───────────────────────────────────────────────
    const metadata = { used, limit, percentUsed, alertSent };
    await writeCronHealth(supabase, "success", metadata);

    // ── 5. Return result ────────────────────────────────────────────────────
    return new Response(JSON.stringify(metadata), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[check-docusign-usage] Fatal error:", err);
    const errMsg = err instanceof Error ? err.message : String(err);

    // Log failure to cron_health (non-fatal)
    const supabaseUrl2 = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey2 = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase2 = createClient(supabaseUrl2, serviceRoleKey2);
    await writeCronHealth(supabase2, "error", { error: errMsg });

    return new Response(JSON.stringify({ error: errMsg }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
