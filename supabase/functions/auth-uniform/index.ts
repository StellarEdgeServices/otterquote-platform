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
 *   - `redirectTo` is validated against an allow-list mirroring
 *     supabase/config.toml's `[auth].additional_redirect_urls` (plus the
 *     react-app's own `/auth-callback` origin, which is not a static-site
 *     path and so is not in that list) — an unrecognized redirect target
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

// Mirrors supabase/config.toml's [auth].additional_redirect_urls (the
// static-site pages that call sendMagicLink/sendPasswordReset via
// js/auth.js) plus the react-app's own callback origin (app.otterquote.com
// is already in ALLOWED_ORIGINS above as a CORS origin, but redirectTo is a
// full URL checked separately and independently of Origin, since a caller
// could in principle be cross-origin-safe but still ask to redirect
// somewhere this project never intends to send an auth link).
const ALLOWED_REDIRECTS = new Set([
  "https://otterquote.com",
  "https://otterquote.com/dashboard.html",
  "https://otterquote.com/get-started.html",
  "https://otterquote.com/bids.html",
  "https://otterquote.com/help-estimate.html",
  "https://otterquote.com/help-measurements.html",
  "https://otterquote.com/help-materials.html",
  "https://otterquote.com/color-selection.html",
  "https://otterquote.com/contract-signing.html",
  "https://otterquote.com/auth/hover/callback",
  "https://otterquote.com/auth-callback.html",
  "https://otterquote.com/contractor-pre-approval.html",
  "https://otterquote.com/partner-dashboard.html",
  "https://otterquote.com/partner-login.html?recovery=1",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://jade-alpaca-b82b5e.netlify.app/dashboard.html",
  "https://app.otterquote.com/auth-callback",
  "https://app-staging.otterquote.com/auth-callback",
  "http://localhost:3000",
  "http://localhost:5500",
]);

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

// Runs the real GoTrue call OFF the request path. Never throws — any error
// (network, GoTrue rejection, bad credentials) is caught and logged
// server-side only; nothing about the outcome reaches the HTTP response,
// which is the entire point (see file header).
async function dispatchAuthCall(
  action: "otp" | "recover",
  email: string,
  redirectTo: string,
  otpMetadata: Record<string, unknown> | undefined,
): Promise<void> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const sb = createClient(supabaseUrl, anonKey);

    if (action === "otp") {
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo, data: otpMetadata },
      });
      if (error) {
        console.error(`[${FUNCTION_NAME}] background otp call failed:`, error.message);
      }
    } else {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) {
        console.error(`[${FUNCTION_NAME}] background recover call failed:`, error.message);
      }
    }
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] background ${action} call threw:`, err);
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
  return typeof redirectTo === "string" && ALLOWED_REDIRECTS.has(redirectTo);
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
  const bg = dispatchAuthCall(action, email, redirectTo, otpMetadata);
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
  ALLOWED_REDIRECTS,
  extractOtpMetadata,
  getClientIp,
  handle,
  ipToUuid,
  isAllowedRedirect,
  isValidAction,
};
