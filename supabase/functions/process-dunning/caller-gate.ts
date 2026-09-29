// gh-2309 -- inbound caller gate for process-dunning.
//
// Before this change the function ran for ANY caller: config.toml pins
// verify_jwt = false and index.ts read no inbound credential, so an
// anonymous POST could run the CRON scan or forge a TRIGGER (Stripe retries,
// payment_failures insert, email/SMS to every contact on file).
//
// Real callers (all send `Authorization: Bearer <service-role key>`):
//   - pg_cron job 5 `process-dunning-cron` (key from vault `cron_service_role_key`)
//   - docusign-webhook (`Bearer ${supabaseKey}`, where supabaseKey comes from its
//     getServiceRoleKey(): SUPABASE_SECRET_KEYS.default when present, else the legacy
//     SUPABASE_SERVICE_ROLE_KEY)
//   - stripe-webhook, platform-health-check
// The gate accepts EITHER accepted key: the runtime SUPABASE_SERVICE_ROLE_KEY or the key
// getServiceRoleKey() returns (inlined below, this repo's per-function convention).
// Each candidate is compared in constant time (no early exit between candidates).
// Fail-closed: an empty/unset key never matches, so an empty bearer authorizes nobody.
//
// Routing (pure, no I/O -- unit-tested in caller-gate.test.ts):
//   OPTIONS                                  -> "preflight"  (CORS only)
//   POST body {health_check:true}            -> "health"     (returns {status:"ok"}, no I/O)
//   GET ?mode=homeowner_choice (emailed link)-> "homeowner_choice", ungated but the
//                                               failure_id / choice tokens are validated
//   everything else (TRIGGER, CRON, any
//   other method/mode)                       -> "gated": needs the service bearer,
//                                               else 401 with zero I/O
//
// Kept as a local file (not _shared/) because the EF body-deploy path does not
// resolve _shared/ imports for new modules; live-charge-guard.ts sets the precedent.

export type Route =
  | { kind: "preflight" }
  | { kind: "health" }
  | { kind: "homeowner_choice" }
  | { kind: "gated" };

/** Constant-time string equality (same primitive as create-invoice's constantTimeEqual). */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Length is compared first; comparing digests would hide it but the key
  // length is not a secret worth the extra cost here (matches create-invoice).
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

type KeyInput = string | undefined | null;

/**
 * Same resolution order as docusign-webhook's getServiceRoleKey() (D-274 / #631):
 * SUPABASE_SECRET_KEYS.default when present and valid JSON, else the legacy
 * SUPABASE_SERVICE_ROLE_KEY, else "". `getEnv` is injectable for tests.
 */
export function getServiceRoleKey(getEnv: (name: string) => string | undefined): string {
  const raw = getEnv("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.default) return String(parsed.default);
    } catch (_e) {
      console.warn("[process-dunning] SUPABASE_SECRET_KEYS present but not valid JSON -- falling back to legacy key");
    }
  }
  return getEnv("SUPABASE_SERVICE_ROLE_KEY") || "";
}

/** The accepted bearer keys: runtime service-role key and getServiceRoleKey() (may be equal or empty). */
export function acceptedServiceKeys(getEnv: (name: string) => string | undefined): string[] {
  return [getEnv("SUPABASE_SERVICE_ROLE_KEY") || "", getServiceRoleKey(getEnv)];
}

/**
 * True only for `Authorization: Bearer <k>` where k equals one of the non-empty
 * accepted keys. Every candidate is compared (no short-circuit); an empty/missing
 * key is skipped so it can never match, not even an empty bearer.
 */
export function hasServiceBearer(req: Request, serviceKeys: KeyInput | readonly KeyInput[]): boolean {
  const keys = (Array.isArray(serviceKeys) ? serviceKeys : [serviceKeys]) as readonly KeyInput[];
  const header = req.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return false;
  const presented = m[1].trim();
  if (!presented) return false;
  let ok = false;
  for (const k of keys) {
    if (!k) continue;
    if (constantTimeEqual(presented, k)) ok = true;
  }
  return ok;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string | null | undefined): v is string {
  return !!v && UUID_RE.test(v);
}

export type HomeownerChoiceCheck =
  | { ok: true; failureId: string; choice: "proceed" | "different" }
  | { ok: false; title: string; message: string };

/** Validates the emailed link's tokens BEFORE any DB access. */
export function validateHomeownerChoice(url: URL): HomeownerChoiceCheck {
  const failId = url.searchParams.get("failure_id");
  const choice = url.searchParams.get("choice");
  if (!failId || !choice) {
    return { ok: false, title: "Invalid Link", message: "This link is missing required parameters. Please contact support@otterquote.com." };
  }
  if (choice !== "proceed" && choice !== "different") {
    return { ok: false, title: "Invalid Choice", message: "Unrecognized selection. Please contact support@otterquote.com." };
  }
  if (!isUuid(failId)) {
    return { ok: false, title: "Invalid Link", message: "This link is not valid. Please contact support@otterquote.com." };
  }
  return { ok: true, failureId: failId, choice };
}

/** Classifies the request. `bodyPeek` is the already-parsed JSON body (or {}). */
export function classifyRequest(req: Request, bodyPeek: unknown): Route {
  if (req.method === "OPTIONS") return { kind: "preflight" };
  if ((bodyPeek as { health_check?: unknown } | null)?.health_check === true) return { kind: "health" };
  const mode = new URL(req.url).searchParams.get("mode");
  if (req.method === "GET" && mode === "homeowner_choice") return { kind: "homeowner_choice" };
  return { kind: "gated" };
}

/**
 * Returns a 401 Response when the request is on a gated route without the
 * service bearer; null when it may proceed. Pure -- performs no I/O.
 */
export function gateResponse(
  route: Route,
  req: Request,
  serviceKeys: KeyInput | readonly KeyInput[],
  corsHeaders: Record<string, string>,
): Response | null {
  if (route.kind !== "gated") return null;
  if (hasServiceBearer(req, serviceKeys)) return null;
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
