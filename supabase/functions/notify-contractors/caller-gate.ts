// gh-2462 -- inbound caller gate (the #2309 process-dunning pattern, generalised).
//
// BYTE-IDENTICAL COPIES live in: process-hover-rebate, check-siding-design-completion,
// notify-feature-request, notify-contractors, check-rate-limits (each <fn>/caller-gate.ts). The copies are
// pinned identical by process-hover-rebate/caller-gate.test.ts. Kept as local files
// (not _shared/) because the EF body-deploy path does not resolve _shared/ imports for
// new modules -- same reason process-dunning/caller-gate.ts is local (gh-2309).
//
// Accepted service bearers (identical to gh-2309, proven live on cron job 5):
//   - the runtime SUPABASE_SERVICE_ROLE_KEY (hover-webhook, stripe-webhook,
//     switch-contractor, check-siding-design-completion send this), and
//   - getServiceRoleKey(): SUPABASE_SECRET_KEYS.default when present, else the legacy
//     SUPABASE_SERVICE_ROLE_KEY (docusign-webhook sends this; vault
//     `cron_service_role_key`, used by the pg_cron jobs and the pg_net DB triggers, is
//     the same `sb_secret_` key -- measured accepted by the gh-2309 gate on 48/48 runs).
// Each candidate is compared in constant time (no early exit between candidates).
// Fail-closed: an empty/unset key never matches, so an empty bearer authorizes nobody.
// Pure: no I/O anywhere in this file.

/** Constant-time string equality (same primitive as process-dunning / create-invoice). */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export type GetEnv = (name: string) => string | undefined;
type KeyInput = string | undefined | null;

/**
 * Same resolution order as docusign-webhook's getServiceRoleKey() (D-274 / #631):
 * SUPABASE_SECRET_KEYS.default when present and valid JSON, else the legacy
 * SUPABASE_SERVICE_ROLE_KEY, else "".
 */
export function getServiceRoleKey(getEnv: GetEnv): string {
  const raw = getEnv("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.default) return String(parsed.default);
    } catch (_e) {
      console.warn("[caller-gate] SUPABASE_SECRET_KEYS present but not valid JSON -- falling back to legacy key");
    }
  }
  return getEnv("SUPABASE_SERVICE_ROLE_KEY") || "";
}

/** The accepted bearer keys: runtime service-role key and getServiceRoleKey() (may be equal or empty). */
export function acceptedServiceKeys(getEnv: GetEnv): string[] {
  return [getEnv("SUPABASE_SERVICE_ROLE_KEY") || "", getServiceRoleKey(getEnv)];
}

/** The presented `Authorization: Bearer <token>` value, trimmed; "" when absent or another scheme. */
export function bearerToken(req: Request): string {
  const header = req.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : "";
}

/**
 * True only for `Authorization: Bearer <k>` where k equals one of the non-empty
 * accepted keys. Every candidate is compared (no short-circuit); an empty/missing
 * key is skipped so it can never match, not even an empty bearer.
 */
export function hasServiceBearer(req: Request, serviceKeys: KeyInput | readonly KeyInput[]): boolean {
  const keys = (Array.isArray(serviceKeys) ? serviceKeys : [serviceKeys]) as readonly KeyInput[];
  const presented = bearerToken(req);
  if (!presented) return false;
  let ok = false;
  for (const k of keys) {
    if (!k) continue;
    if (constantTimeEqual(presented, k)) ok = true;
  }
  return ok;
}

/** A user access token is always a three-part JWT; anything else is never sent to auth. */
export function looksLikeJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

/** The gate's refusal: JSON `{error}` with CORS headers; leaks nothing about why. */
export function deny(status: 401 | 403, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: status === 401 ? "Unauthorized" : "Forbidden" }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Service-only gate: returns a 401 Response unless the request carries an accepted
 * service bearer; null when it may proceed. Pure -- performs no I/O.
 */
export function serviceGate(
  req: Request,
  getEnv: GetEnv,
  corsHeaders: Record<string, string>,
): Response | null {
  if (hasServiceBearer(req, acceptedServiceKeys(getEnv))) return null;
  return deny(401, corsHeaders);
}
