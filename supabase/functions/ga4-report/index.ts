/**
 * OtterQuote Edge Function: ga4-report
 *
 * gh-1331 — the free GA4 read path.
 *
 * Supermetrics reported GA4 as NOT_AUTHENTICATED; Dustin re-authenticated it on
 * 2026-08-28 and the auth went green, but every query then returned
 * [TRIAL_EXPIRED] — the free trial ended 2026-08-26. The CEO ruling on that
 * issue: do not buy Supermetrics for one property with near-zero traffic, and
 * build against the read path we already own — the GA4 Data API service account
 * otterquote-ga4-reader@otterquote-analytics.iam.gserviceaccount.com, created
 * 2026-05-27 for exactly this and never consumed by any code until now.
 *
 * Without this, every conversion rate is a guess with no denominator: the CRO's
 * funnel row (visits -> signups -> checkouts -> paid -> referrals) runs on
 * Stripe + Supabase only and prints NOT RUN for visits.
 *
 * Input:  GET, or POST { start_date?, end_date?, metrics?: string[] }
 *         Defaults to sessions + totalUsers over the last 7 days, which is the
 *         shape gh-1331's closes-on asks for.
 * Output: { ok: true, property_id, date_range, metrics: { sessions: N, ... },
 *           rows_returned, queried_at }
 *
 * Read-only. Calls Google's token endpoint and the GA4 Data API and writes
 * nothing anywhere — no DB write, no email, no payment. Tier 3A under D-182.
 *
 * Auth: verify_jwt = false (see supabase/config.toml) — performed in-handler,
 * same pattern as approve-payout / get-payout-completion-status. Accepts either
 * the service-role key (how an executive session calls it) or a Supabase JWT
 * whose email is in the admin allow-list.
 *
 * GitHub: #1331
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";

const FUNCTION_NAME = "ga4-report";
const ADMIN_EMAILS = ["dustinstohler1@gmail.com", "dustin@otterquote.com"];

/**
 * The NUMERIC GA4 property id, which is what the Data API takes.
 *
 * Not to be confused with G-D1Y1TLGEFY, which appears all over this issue and
 * in the site's gtag snippet: that is the MEASUREMENT id and the Data API does
 * not accept it. 541423859 is the property "Otter Quotes", confirmed via
 * Supermetrics accounts_discovery on 2026-08-28 as the property connected under
 * DustinStohler1@gmail.com.
 */
const DEFAULT_PROPERTY_ID = "541423859";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GA4_DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

const DEFAULT_METRICS = ["sessions", "totalUsers"];
const MAX_METRICS = 10;

// Metric names are interpolated into the API request body, so constrain them to
// the shape GA4 metric identifiers actually take rather than passing through
// whatever a caller sends.
const METRIC_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const DATE_RE = /^(\d{4}-\d{2}-\d{2}|today|yesterday|\d{1,4}daysAgo)$/;

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

function jsonResponse(data: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Service account credentials
// ---------------------------------------------------------------------------

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

/**
 * Setup/configuration faults that are SAFE to describe to an (already
 * authenticated, admin-only) caller, because every message below is static text
 * authored here -- never an exception message, an upstream response body, or a
 * stack frame.
 *
 * The indirection exists because CodeQL flagged the original handler for
 * "information exposure through a stack trace": the catch forwarded
 * `err.message` to the response, which taints the response with whatever any
 * throw site happened to include (Google's token-endpoint body, among others).
 * Carrying a CODE and looking the text up in this frozen map means nothing
 * derived from the exception object can reach the client, while the operator
 * still gets the one diagnostic that actually saves time here.
 */
const CONFIG_ERROR_MESSAGES: Record<string, string> = {
  doppler_field_swap:
    "GA4_SERVICE_ACCOUNT_JSON is empty but GA4_PROPERTY_ID contains JSON. This is the " +
    "known Doppler field swap from gh-1331: the two values are transposed at the source. " +
    "Fix them in Doppler rather than reading the swapped names here.",
  missing_secret: "GA4_SERVICE_ACCOUNT_JSON is not set in this function's secrets.",
  invalid_json: "GA4_SERVICE_ACCOUNT_JSON is set but is not valid JSON.",
  incomplete_service_account:
    "GA4_SERVICE_ACCOUNT_JSON is missing client_email or private_key.",
};

const GENERIC_ERROR =
  "Internal error. Details were logged to this function's logs and are deliberately " +
  "not returned in the response.";

class ConfigError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ConfigError";
  }
}

/**
 * Pure core of loadServiceAccount: given the raw string values of the two env
 * vars, decide whether we have a usable service account, the gh-1331 Doppler
 * field swap, or some other config fault.
 *
 * Deliberately detects the Doppler field swap Dustin found (gh-1331): there,
 * GA4_PROPERTY_ID holds the service-account JSON and GA4_SERVICE_ACCOUNT_JSON is
 * empty. Supabase's copy is correct, so this function reads the correct name --
 * but if it is ever synced from the swapped source, the failure would otherwise
 * be an opaque parse error. Naming the swap costs three lines and saves the next
 * person the hour it cost this one.
 *
 * Split out from env-reading (rather than calling Deno.env.get directly) so
 * this logic runs under index.test.ts's zero-permission `deno test` in the CI
 * pure-unit lane -- no --allow-env needed, and the real key material this
 * guards is never read in a test, only synthetic strings.
 */
function parseServiceAccountEnv(rawJson: string, propertyEnvRaw: string): ServiceAccount {
  const raw = rawJson.trim();
  const propertyEnv = propertyEnvRaw.trim();

  if (!raw) {
    throw new ConfigError(propertyEnv.startsWith("{") ? "doppler_field_swap" : "missing_secret");
  }

  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError("invalid_json");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new ConfigError("incomplete_service_account");
  }
  return parsed;
}

/** Reads the two env vars and delegates to parseServiceAccountEnv above. */
function loadServiceAccount(): ServiceAccount {
  return parseServiceAccountEnv(
    Deno.env.get("GA4_SERVICE_ACCOUNT_JSON") || "",
    Deno.env.get("GA4_PROPERTY_ID") || "",
  );
}

// ---------------------------------------------------------------------------
// Google OAuth: signed JWT assertion -> access token
// ---------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlText(text: string): string {
  return base64url(new TextEncoder().encode(text));
}

/**
 * PEM (PKCS#8) -> raw DER, for crypto.subtle.importKey.
 *
 * Returns ArrayBuffer rather than Uint8Array on purpose: importKey's BufferSource
 * overload rejects Uint8Array<ArrayBufferLike> under TS 5.7+ lib typings, and an
 * ArrayBuffer is unambiguous under every version.
 */
function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const der = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der.buffer;
}

async function mintAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64urlText(
    JSON.stringify({
      iss: sa.client_email,
      scope: GA4_SCOPE,
      aud: TOKEN_ENDPOINT,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;

  // The private_key arrives with literal \n when it has round-tripped through an
  // env var; normalise before parsing the PEM.
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key.replace(/\\n/g, "\n")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)),
  );
  const assertion = `${signingInput}.${base64url(signature)}`;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Google token endpoint returned ${res.status}: ${body.slice(0, 400)}`);
  }
  const token = JSON.parse(body).access_token;
  if (!token) throw new Error("Google token endpoint returned no access_token.");
  return token;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // --- auth (verify_jwt = false; enforced here) --------------------------
    const authHeader = req.headers.get("Authorization") || "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!bearer) return jsonResponse({ ok: false, error: "Missing Authorization header" }, 401, cors);

    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const isServiceRole = serviceRoleKey.length > 0 && bearer === serviceRoleKey;

    if (!isServiceRole) {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_ANON_KEY") ?? "",
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      const email = userData?.user?.email?.toLowerCase();
      if (userErr || !email || !ADMIN_EMAILS.includes(email)) {
        return jsonResponse({ ok: false, error: "Forbidden" }, 403, cors);
      }
    }

    // --- inputs ------------------------------------------------------------
    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      try {
        body = await req.json();
      } catch {
        body = {};
      }
    }

    const startDate = String(body.start_date ?? "7daysAgo");
    const endDate = String(body.end_date ?? "today");
    if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
      return jsonResponse(
        { ok: false, error: "start_date/end_date must be YYYY-MM-DD, 'today', 'yesterday', or 'NdaysAgo'" },
        400,
        cors,
      );
    }

    const metrics = Array.isArray(body.metrics) && body.metrics.length
      ? (body.metrics as unknown[]).map(String)
      : DEFAULT_METRICS;
    if (metrics.length > MAX_METRICS || !metrics.every((m) => METRIC_NAME_RE.test(m))) {
      return jsonResponse(
        { ok: false, error: `metrics must be at most ${MAX_METRICS} valid GA4 metric names` },
        400,
        cors,
      );
    }

    const propertyId = (Deno.env.get("GA4_PROPERTY_ID") || "").trim().match(/^\d+$/)
      ? (Deno.env.get("GA4_PROPERTY_ID") as string).trim()
      : DEFAULT_PROPERTY_ID;

    // --- fetch -------------------------------------------------------------
    const accessToken = await mintAccessToken(loadServiceAccount());

    const reportRes = await fetch(`${GA4_DATA_API}/properties/${propertyId}:runReport`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        metrics: metrics.map((name) => ({ name })),
      }),
    });
    const reportText = await reportRes.text();

    if (!reportRes.ok) {
      // Log the upstream body for the operator; never return it. It is an
      // external response and forwarding it is the same exposure class CodeQL
      // flagged on the catch below.
      console.error(`[${FUNCTION_NAME}] GA4 ${reportRes.status}:`, reportText.slice(0, 600));
    }

    if (reportRes.status === 403) {
      // gh-1331 predicted this exact case: a 403 means the service account's
      // Viewer grant is still on the old "Claim Shield" property rather than
      // "Otter Quotes - Web". That is one click for Dustin, so say so instead of
      // returning a bare 403 someone has to go decode.
      return jsonResponse(
        {
          ok: false,
          error: "GA4 Data API returned 403 for this property.",
          likely_cause:
            `The service account is authenticated but not authorized on property ${propertyId}. ` +
            "Per gh-1331 this most likely means its Viewer grant is still on the old " +
            "\"Claim Shield\" property. Fix: add " +
            "otterquote-ga4-reader@otterquote-analytics.iam.gserviceaccount.com as a Viewer " +
            "on \"Otter Quotes - Web\" in GA4 Admin > Property Access Management.",
          property_id: propertyId,
        },
        403,
        cors,
      );
    }
    if (!reportRes.ok) {
      return jsonResponse(
        {
          ok: false,
          error: `GA4 Data API returned ${reportRes.status}`,
          property_id: propertyId,
          detail: "Upstream response body was logged, not returned.",
        },
        502,
        cors,
      );
    }

    const report = JSON.parse(reportText);
    const values: string[] = report?.rows?.[0]?.metricValues?.map((v: { value: string }) => v.value) ?? [];
    const out: Record<string, number> = {};
    metrics.forEach((name, i) => {
      out[name] = Number(values[i] ?? 0);
    });

    return jsonResponse(
      {
        ok: true,
        property_id: propertyId,
        date_range: { start_date: startDate, end_date: endDate },
        metrics: out,
        // A property with genuinely zero traffic returns no rows, which is a
        // valid answer and not an error. Surfaced so a caller can tell "zero
        // sessions" apart from "the query matched nothing".
        rows_returned: report?.rows?.length ?? 0,
        queried_at: new Date().toISOString(),
      },
      200,
      cors,
    );
  } catch (err) {
    // Full detail (message + stack) goes to the function logs, which is where an
    // operator looks. The RESPONSE carries only static text: either a message
    // looked up by code from the frozen map above, or the generic fallback.
    // Nothing derived from the exception object crosses this boundary.
    console.error(`[${FUNCTION_NAME}]`, err);
    if (err instanceof ConfigError) {
      const message = CONFIG_ERROR_MESSAGES[err.code];
      if (message) {
        return jsonResponse({ ok: false, error: message, error_code: err.code }, 500, cors);
      }
    }
    return jsonResponse({ ok: false, error: GENERIC_ERROR }, 500, cors);
  }
});
