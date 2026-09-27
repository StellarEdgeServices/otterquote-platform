/**
 * OtterQuote Edge Function: auth-uniform
 *
 * gh-1883 [SECURITY]: `/auth/v1/otp` (called with `create_user:false`) and
 * `/auth/v1/recover` are Supabase GoTrue's own hosted routes on the same
 * project host. Both are unauthenticated account-enumeration oracles —
 * confirmed live and reproduced repeatedly on this issue's thread:
 *
 *   - `/auth/v1/otp` (`create_user:false`) returns `200 {}` for an existing
 *     address and `422 {"error_code":"otp_disabled",...}` for an absent
 *     one — a clean status-code oracle, 8/8 and 6/6 correctly classified
 *     across three independent reproductions.
 *   - `/auth/v1/recover` returns a uniform `200 {}` body/status either way,
 *     but the existing-address branch performs an inline SMTP send while
 *     the absent branch returns immediately: 1.6-1.8s vs 0.2-0.4s, no
 *     overlap, reproduced four times on this thread. A caller that has
 *     already sent one recovery email also gets a fourth signal — GoTrue's
 *     own per-address 429 `over_email_send_rate_limit` with a countdown —
 *     which is itself trivially distinguishable from the absent path's
 *     `200 {}` (see comment 5849967940).
 *
 * Neither oracle is closed by rate-limiting harder (ruled out explicitly on
 * this thread, comment 5591737947 / 5595399902): the absent branch of
 * `/otp` sends no email, so an email-send rate limit never touches it, and
 * `/recover`'s timing gap is architectural (inline send vs. no send), not a
 * volume property. GoTrue exposes no settings-page toggle for either
 * behavior (Management API config read attempted and credential-scoped out
 * on this thread, comment 5595399902; not re-attempted here — hunting for a
 * credential to route around a 403 is out of scope, same as
 * check-email-exists's convention).
 *
 * Ruling (comment 5857611145, Marty/CTO, claim cto-2026-09-27T13:21:21Z):
 * drop the `/otp` `create_user:false` status/body split for anonymous
 * callers (Tier B, ruled directly — nothing in this repo's caller set
 * consumes that distinction as anonymous-caller behavior; a legitimate
 * caller who has no account simply receives no email and sees the same
 * "check your email" state as everyone else) and front both endpoints with
 * an Edge Function that ALWAYS returns a uniform `200 {}`, with the real
 * GoTrue call dispatched off the request path so its latency can never
 * leak into the response. This is the same fronting pattern this repo
 * already uses for other sensitive Supabase-managed behavior
 * (check-email-exists, resend-hover-link) rather than modifying GoTrue's
 * own routes directly (which this repo does not control).
 *
 * Design, mirroring check-email-exists/index.ts's conventions:
 *
 *   - CORS allow-list matches check-email-exists's ALLOWED_ORIGINS exactly
 *     (same set of first-party origins call auth flows).
 *     [REVIEW FOLLOW-UP, comment 5857851132] originally documented here as
 *     "mirroring supabase/config.toml's `additional_redirect_urls`" — that
 *     was never accurate: config.toml lists `stellaredgeservices.com` URLs,
 *     a different domain than this app serves, and is stale relative to
 *     production independently of this PR. This function's own allow-list
 *     (REDIRECT_ORIGIN_PATHS, below) is authoritative for what THIS
 *     function accepts; it is validated against every real first-party
 *     caller target in this repo, static and staging alike, by
 *     index.test.ts's caller-target table, not against config.toml.
 *   - `redirectTo` is validated against that allow-list, checked as an
 *     origin (an exact, case-insensitive match) plus a path (an exact
 *     match; the query string and any fragment are handled separately, see
 *     `isAllowedRedirect`) — an unrecognized redirect target
 *     is a 400, not a padded 200; it is a caller bug (or a misuse attempt),
 *     not part of the enumeration surface this function protects, so it
 *     costs the caller no information about any address and does not need
 *     constant-time treatment.
 *   - The real GoTrue call is started but never awaited by the response
 *     path — `EdgeRuntime.waitUntil()` keeps it alive after the response
 *     ships (the documented Supabase Edge Functions background-task
 *     mechanism; falls back to a fire-and-forget promise with its own
 *     `.catch()` if `EdgeRuntime` is unavailable, e.g. under `deno test`).
 *     Its result and any error are logged server-side ONLY — never
 *     returned to the caller in any form (status, body, or timing).
 *   - After kicking off (not awaiting) the GoTrue call, the handler pads
 *     the response to a fixed minimum wall-clock time (`MIN_RESPONSE_MS`,
 *     800ms) measured from request start, so the response is
 *     indistinguishable in time regardless of whether the address exists,
 *     whether GoTrue accepts or rejects the call, or whether GoTrue is
 *     slow. A slow GoTrue call cannot make the response slower (it isn't
 *     awaited); it can only make the padding a no-op if it were awaited,
 *     which is exactly why it is not.
 *   - A per-IP rate limit (`check_rate_limit`, function name
 *     `auth-uniform`, config row added in the companion migration) is
 *     checked BEFORE the redirect/email validation, same ordering as
 *     check-email-exists. A rate-limited caller gets `429` immediately
 *     (own bucket, no padding) rather than the padded `200 {}` -- this
 *     discloses IP-level burst volume, never per-email existence, which
 *     this repo's convention (check-email-exists) already treats as an
 *     acceptable, non-enumerating signal.
 *
 * Usage:
 *   POST /functions/v1/auth-uniform
 *   Body: { "action": "otp" | "recover", "email": "a@b.com", "redirectTo": "https://otterquote.com/auth-callback.html" }
 *   Response (always, existing or absent address, GoTrue success or failure):
 *     200 {}                                            -- after >= MIN_RESPONSE_MS
 *   Response (caller error, never account-dependent):
 *     400 { "error": "..." }                             -- bad JSON / missing field / bad action / redirect not allow-listed
 *     429 { "error": "Too many requests. Please try again later." }  -- per-IP burst limit
 *     405 { "error": "Method not allowed" }               -- non-POST/OPTIONS
 *
 * Residual, stated honestly: this closes the status/body/timing oracle on
 * both endpoints for callers that go through this function. It does NOT
 * (and cannot) stop a caller from hitting `/auth/v1/otp` or
 * `/auth/v1/recover` directly with the project's publishable key — those
 * are GoTrue's own routes and this repo does not control whether they stay
 * reachable. Closing this issue's `closes-on` requires BOTH this function
 * existing AND every first-party caller in this repo switching from
 * `supabase.auth.signInWithOtp()` / `supabase.auth.resetPasswordForEmail()`
 * (which call GoTrue directly, bypassing this function entirely) to this
 * function — see the companion caller-migration changes in the same PR.
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";

declare const EdgeRuntime: { waitUntil?: (promise: Promise<unknown>) => void } | undefined;

const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

// gh-1883 REVIEW FOLLOW-UP (must-fix 1+2, comment 5857851132): this used to
// be a flat Set of exact URL strings, matched verbatim including query
// string. Two real callers broke as a result:
//   - login.html's "Forgot password?" sends
//     `${CONFIG.SITE_URL}/login.html?recovery=1` -- not in the old Set (only
//     partner-login.html's equivalent was), so every homeowner reset 400'd.
//   - CONFIG.SITE_URL (js/config.js) and contractor-join.html's
//     window.location.origin both resolve to the STAGING Netlify origins on
//     jade-alpaca-b82b5e.netlify.app / staging--jade-alpaca-b82b5e.netlify.app
//     when the page is loaded there, and the old Set had no staging entries
//     for anything but /dashboard.html -- every staging sign-in/reset 400'd.
//
// Rebuilt as an origin allow-list x path allow-list, checked independently,
// with the query string and fragment handled explicitly below in
// isAllowedRedirect -- NOT as part of the string being matched. This is
// intentionally origin+path matching, not a prefix or substring match: an
// unlisted path on an allow-listed origin is still rejected (same guarantee
// the old exact-Set gave), but a listed path now accepts ANY query string
// (real callers append `?recovery=1`, `?intent=...`, etc., and none of that
// affects which page ultimately handles the redirect).
//
// This list is NOT a mirror of supabase/config.toml's
// [auth].additional_redirect_urls -- that file lists stellaredgeservices.com
// URLs (a different domain than this app serves), so it is already stale
// relative to production and this EF's own allow-list is authoritative for
// what THIS function accepts. GoTrue's own project-level redirect allow-list
// (config.toml, pushed via the deploy pipeline) is a SEPARATE gate the
// emailed link must also clear once GoTrue sends it -- config.toml is not
// touched by this PR; reconciling it with production's real domain is a
// separate, larger config change, not a must-fix here.
const REDIRECT_STATIC_PATHS = new Set([
  "/",
  "/dashboard.html",
  "/get-started.html",
  "/bids.html",
  "/help-estimate.html",
  "/help-measurements.html",
  "/help-materials.html",
  "/color-selection.html",
  "/contract-signing.html",
  "/auth/hover/callback",
  "/auth-callback.html",
  "/contractor-pre-approval.html",
  "/partner-dashboard.html",
  "/partner-login.html",
  "/login.html",
]);

// The react-app's own callback path (app.otterquote.com / its staging
// alias), a Next.js route with no ".html" suffix -- distinct path space
// from the static site above, so kept as its own set rather than merged in.
const REDIRECT_REACT_PATHS = new Set([
  "/auth-callback",
]);

// Local dev only -- both static-site (python -m http.server / live-server)
// and react-app (next dev) local runs redirect back to their own root.
const REDIRECT_LOCALHOST_PATHS = new Set([
  "/",
]);

const REDIRECT_ORIGIN_PATHS: Record<string, Set<string>> = {
  "https://otterquote.com": REDIRECT_STATIC_PATHS,
  "https://jade-alpaca-b82b5e.netlify.app": REDIRECT_STATIC_PATHS,
  "https://staging--jade-alpaca-b82b5e.netlify.app": REDIRECT_STATIC_PATHS,
  "https://app.otterquote.com": REDIRECT_REACT_PATHS,
  "https://app-staging.otterquote.com": REDIRECT_REACT_PATHS,
  "http://localhost:3000": REDIRECT_LOCALHOST_PATHS,
  "http://localhost:5500": REDIRECT_LOCALHOST_PATHS,
};

const FUNCTION_NAME = "auth-uniform";
const MIN_RESPONSE_MS = 800;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// gh-1883: contractor-join.html's direct signInWithOtp() call stamps
// `options.data.role = 'contractor'` on the new-user record so index.html
// can fast-path role resolution straight from the JWT's `user_metadata.role`
// (see index.html's own comment on this, and the 4 E2E fixtures asserting
// `user_metadata: { role: 'contractor' }`). That is load-bearing behavior,
// not incidental — dropping it when routing through this function would be
// a silent regression, not just a safe simplification. Rather than forward
// an arbitrary caller-supplied `data` object into GoTrue's signup metadata
// (which would let a caller stamp anything onto their own account — low
// risk, since it's their own account, but needless), only this one known
// key is threaded through, and only to one of the roles this repo actually
// uses. Anything else in `data` is silently dropped.
const ALLOWED_METADATA_ROLES = new Set([
  "homeowner",
  "contractor",
  "re_agent",
  "insurance_agent",
  "home_inspector",
  "adjuster",
  "other",
]);

// deno-lint-ignore no-explicit-any
function extractOtpMetadata(data: any): Record<string, unknown> | undefined {
  if (!data || typeof data !== "object") return undefined;
  const role = data.role;
  if (typeof role === "string" && ALLOWED_METADATA_ROLES.has(role)) {
    return { role };
  }
  return undefined;
}

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// gh-1883 REVIEW FOLLOW-UP (must-fix 4, comment 5857851132): GoTrue's own
// per-IP limiter for /otp, /recover, /signup and /resend is shared across
// ALL FOUR of those routes, keyed on the caller's IP
// (internal/api/apilimiter/apilimiter.go, performRateLimiting). Called from
// here, that caller IP is this Edge Function's own egress IP, not the
// end user's -- every user's magic-link/reset/signup request would land in
// the SAME shared bucket (hosted default: 30/5min) unless the real
// end-user IP is forwarded.
//
// Supabase supports exactly this via the `Sb-Forwarded-For` request header
// (see "IP address forwarding" in Supabase's Rate Limits docs), but ONLY
// when BOTH of these hold:
//   1. The project has "IP Address Forwarding" turned ON under
//      Authentication > Rate Limits (or `security_sb_forwarded_for_enabled`
//      via the Management API) -- a project setting, not something this
//      function or this repo's code can flip. NOT verified as on for this
//      project as part of this fix; do not assume it is.
//   2. The GoTrue call is authenticated with a NEW-format secret key
//      (`sb_secret_...`). Supabase's docs are explicit that legacy
//      `service_role`/`anon` keys and the new publishable key are NOT
//      supported for this header -- so the anon key this call otherwise
//      uses could never carry it even if (1) were on.
//
// This function forwards the header whenever a `SUPABASE_SECRET_KEY` EF
// secret is provisioned (checked at call time, not import time, so a
// human adding the secret later takes effect on the next invocation with
// no code change) and falls back to the anon key exactly as before when it
// is not -- i.e. today, until that secret exists AND (1) is confirmed on,
// this is a documented no-op, not a silent gap: see the alerting below,
// which is what makes a resulting throttle visible instead of silent
// either way.
//
// Runs the real GoTrue call OFF the request path. Never throws — any error
// (network, GoTrue rejection, bad credentials) is caught, logged
// server-side, and (best-effort) recorded to platform_alerts_log so a rate
// limit or send failure back here is visible to an operator instead of
// only ever showing the caller a uniform "check your email" that never
// arrives. Nothing about the outcome reaches the HTTP response, which is
// the entire point (see file header).
async function dispatchAuthCall(
  action: "otp" | "recover",
  email: string,
  redirectTo: string,
  otpMetadata: Record<string, unknown> | undefined,
  clientIp: string,
): Promise<void> {
  let errorMessage: string | undefined;
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    // New-format `sb_secret_...` key, provisioned separately from the
    // legacy SUPABASE_SERVICE_ROLE_KEY (which is not accepted for
    // Sb-Forwarded-For -- see comment above). Absent until a human
    // provisions it and confirms project-level IP forwarding is on.
    const secretKey = Deno.env.get("SUPABASE_SECRET_KEY") || "";
    const canForwardIp = Boolean(secretKey) && clientIp !== "unknown";
    const sb = canForwardIp
      ? createClient(supabaseUrl, secretKey, {
        global: { headers: { "Sb-Forwarded-For": clientIp } },
      })
      : createClient(supabaseUrl, anonKey);

    if (action === "otp") {
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo, data: otpMetadata },
      });
      if (error) errorMessage = error.message;
    } else {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) errorMessage = error.message;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  if (errorMessage) {
    console.error(`[${FUNCTION_NAME}] background ${action} call failed:`, errorMessage);
    await alertBackgroundAuthFailure(action, errorMessage);
  }
}

// Best-effort alert row so a background GoTrue failure -- most importantly
// a rate-limit throttle (`over_request_rate_limit` /
// `over_email_send_rate_limit`), which the uniform 200 response now hides
// completely from the caller -- leaves a trace an operator actually
// watches, per this repo's existing platform_alerts_log convention (see
// e.g. notify-measurement-order/index.ts). Uses its own service-role
// client, independent of whichever key dispatchAuthCall used for the
// GoTrue call itself, since platform_alerts_log writes require it. Never
// includes the email address -- same "no addresses in logs" posture as the
// rest of this function.
async function alertBackgroundAuthFailure(action: "otp" | "recover", reason: string): Promise<void> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const sbAdmin = createClient(supabaseUrl, serviceRoleKey);
    const isRateLimit = /rate.?limit/i.test(reason);
    await sbAdmin.from("platform_alerts_log").insert({
      alert_type: isRateLimit ? "auth_uniform_rate_limited" : "auth_uniform_send_failed",
      function_name: FUNCTION_NAME,
      message: `background ${action} call failed: ${reason}`,
      sent_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] failed to write alert row:`, err);
  }
}

// gh-1724-style per-IP synthetic bucket, same construction as
// check-email-exists/index.ts's getClientIp()/ipToUuid() (namespaced with
// FUNCTION_NAME so the hash never collides with another function's bucket
// for the same IP).
function getClientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}

async function ipToUuid(ip: string): Promise<string> {
  const data = new TextEncoder().encode(`${FUNCTION_NAME}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Pure validators, extracted so they're unit-testable without a network
// call — same convention as check-email-exists's computeSelfCheck().
function isValidAction(action: unknown): action is "otp" | "recover" {
  return action === "otp" || action === "recover";
}

function isAllowedRedirect(redirectTo: unknown): redirectTo is string {
  if (typeof redirectTo !== "string" || redirectTo.length === 0) return false;

  let url;
  try {
    // `new URL()` with no base rejects protocol-relative ("//evil.com") and
    // other non-absolute forms outright (throws), so those never reach the
    // checks below.
    url = new URL(redirectTo);
  } catch {
    return false;
  }

  // Reject embedded credentials before ever looking at origin/path:
  // `https://evil.com@otterquote.com` parses to origin "https://otterquote.com"
  // (evil.com is the *username*), which would otherwise sail through the
  // origin+path check below even though the browser is being told to
  // authenticate to "evil.com" first. No real caller in this repo ever puts
  // a username/password in a redirect URL, so this costs nothing.
  if (url.username || url.password) return false;

  // Reject a fragment outright. No real caller appends one, and without
  // this check a payload like ".../auth-callback.html#@evil.com" would
  // parse to the same allow-listed origin+path with the attacker-controlled
  // part silently dropped as the (ignored) hash -- correct in that the
  // browser never actually leaves otterquote.com, but the shipped review
  // treated this shape as one that must still be rejected outright, so it
  // is rejected here rather than allowed on the technicality that it's
  // harmless.
  if (url.hash) return false;

  // `URL` lower-cases scheme and host during parsing, so origin comparison
  // here is already case-insensitive (an uppercase-scheme/host attack
  // variant of an otherwise-malicious URL still fails to match any
  // allow-listed origin; it is not a way to bypass the check).
  const allowedPaths = REDIRECT_ORIGIN_PATHS[url.origin];
  if (!allowedPaths) return false;

  // Path must match exactly (URL normalizes away ../ segments and duplicate
  // slashes before this runs) -- the query string is deliberately NOT part
  // of this comparison. A listed path accepts any query string a real
  // caller appends (?recovery=1, ?intent=homeowner, etc.); an unlisted path
  // is rejected regardless of query string, same as before.
  return allowedPaths.has(url.pathname);
}

async function handle(req: Request): Promise<Response> {
  const start = performance.now();
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, corsHeaders);
  }

  // Per-IP burst gate, checked before parsing the body -- same ordering as
  // check-email-exists. A rejected caller gets an immediate, unpadded 429;
  // this discloses IP-level volume only, never per-email existence.
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const sbAdmin = createClient(supabaseUrl, serviceRoleKey);

  const clientIp = getClientIp(req);
  const ipBucketId = await ipToUuid(clientIp);
  const { data: rateLimitResult, error: rlError } = await sbAdmin.rpc("check_rate_limit", {
    p_function_name: FUNCTION_NAME,
    p_user_id: ipBucketId,
  });
  if (rlError) {
    // RPC failure, not a rate-limit decision -- log and fall through
    // (fail OPEN), matching check-email-exists's stated posture for infra
    // hiccups: a broken limiter must not trap a legitimate user either.
    console.error(`[${FUNCTION_NAME}] rate limit check failed, failing open:`, rlError);
  } else if (!rateLimitResult?.allowed) {
    console.warn(`[${FUNCTION_NAME}] RATE LIMITED ip=${clientIp}: ${rateLimitResult?.reason}`);
    return json({ error: "Too many requests. Please try again later." }, 429, corsHeaders);
  }

  let action: unknown;
  let email = "";
  let redirectTo: unknown;
  let otpMetadata: Record<string, unknown> | undefined;
  try {
    const body = await req.json();
    action = body?.action;
    email = String(body?.email || "").trim();
    redirectTo = body?.redirectTo;
    otpMetadata = extractOtpMetadata(body?.data);
  } catch {
    return json({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  if (!isValidAction(action)) {
    return json({ error: "action must be \"otp\" or \"recover\"" }, 400, corsHeaders);
  }
  if (!email || !EMAIL_RE.test(email)) {
    return json({ error: "Missing or invalid email" }, 400, corsHeaders);
  }
  if (!isAllowedRedirect(redirectTo)) {
    return json({ error: "redirectTo is not an allowed redirect target" }, 400, corsHeaders);
  }

  // Kick off the real GoTrue call but do NOT await it -- its latency and
  // outcome must never reach the response. `EdgeRuntime.waitUntil` is the
  // documented Supabase Edge Functions mechanism to keep a background task
  // alive after the response ships; it is unavailable under `deno test`
  // (and in some local runs), so fall back to a bare fire-and-forget
  // promise with its own internal `.catch` (dispatchAuthCall never
  // rejects, but the fallback is defensive).
  const bg = dispatchAuthCall(action, email, redirectTo, otpMetadata, clientIp);
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(bg);
  } else {
    bg.catch((err) => console.error(`[${FUNCTION_NAME}] background task rejected:`, err));
  }

  // Pad to a fixed minimum wall-clock time so the response is
  // indistinguishable regardless of account existence or GoTrue behavior.
  const elapsed = performance.now() - start;
  const remaining = Math.max(0, MIN_RESPONSE_MS - elapsed);
  if (remaining > 0) await sleep(remaining);

  return json({}, 200, corsHeaders);
}

serve(handle);

export {
  ALLOWED_METADATA_ROLES,
  REDIRECT_ORIGIN_PATHS,
  extractOtpMetadata,
  getClientIp,
  handle,
  ipToUuid,
  isAllowedRedirect,
  isValidAction,
};
