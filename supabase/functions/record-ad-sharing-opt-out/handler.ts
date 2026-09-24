/**
 * record-ad-sharing-opt-out -- the support-email path for the advertising-sharing opt-out.
 *
 * gh-2107 / D-330 half 2. Dustin's ruling "b." (#2078 comment 5801822166), scope item 4: "The manual support-email opt-out
 * path sets the same flag, so admins have a way to record it." Privacy policy Section 12's opt-out today is an email to
 * support@otterquote.com; when one arrives, an admin calls this function with the address and it sets
 * profiles.ad_sharing_opt_out = TRUE (source `support_email`) on every profile with that address, so the server-side Meta
 * CAPI Purchase is skipped for that person (migration 20260924003805).
 *
 * ADMIN ONLY. The caller must present an admin Bearer JWT: authenticated, then an admin-role check made against the
 * AUTHENTICATED user (never anything in the request body). Same in-handler gate as approve-warranty-drift.
 *
 * WHAT IT DOES NOT DO. It never clears a flag. When no account has the address it stores nothing and says so
 * (`matched: 0`): a person who opted out before ever creating an account is a known gap, raised on #2107, not papered over.
 * It never logs or echoes the address or any database text.
 *
 * No imports on purpose: unit-tested by handler.test.ts (no network), deployed beside index.ts as a local module.
 */

export const FUNCTION_NAME = "record-ad-sharing-opt-out";

export const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

export function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim, lower-case, and accept only a plausible single address of at most 320 characters. Anything else is null. */
export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  if (!e || e.length > 320 || !EMAIL_RE.test(e)) return null;
  return e;
}

/** Escape LIKE/ILIKE metacharacters so an address is matched literally (an underscore is common in real addresses). */
export function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export interface Authed { id: string; email: string }

export interface Deps {
  /** The user behind a Bearer token, or null if the token is not valid. */
  authenticate(token: string): Promise<Authed | null>;
  /** Whether this AUTHENTICATED user is an admin. */
  isAdmin(userId: string, email: string): Promise<boolean>;
  /** Set the flag TRUE (never clear it) on every profile with this address. */
  recordByEmail(email: string, atIso: string): Promise<{ matched: number; updated: number } | { errorCode: string | null }>;
  now(): Date;
  log(message: string): void;
}

/** SQLSTATE-style codes only: short and alphanumeric. Anything else is dropped so a message cannot ride in the "code". */
function safeCode(code: unknown): string {
  return typeof code === "string" && /^[A-Za-z0-9_]{1,20}$/.test(code) ? ` (code ${code})` : "";
}

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  const cors = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  const auth = req.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401, cors);
  const user = await deps.authenticate(auth.slice(7));
  if (!user) return json({ error: "Unauthorized" }, 401, cors);
  if (!(await deps.isAdmin(user.id, user.email))) return json({ error: "Forbidden: admin role required" }, 403, cors);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400, cors);
  }
  const email = normalizeEmail(raw && typeof raw === "object" ? (raw as Record<string, unknown>).email : undefined);
  if (!email) return json({ error: "A valid email address is required" }, 400, cors);

  let result: { matched: number; updated: number } | { errorCode: string | null };
  try {
    result = await deps.recordByEmail(email, deps.now().toISOString());
  } catch {
    deps.log(`[${FUNCTION_NAME}] recording the opt-out threw`);
    return json({ error: "Could not record the opt-out" }, 500, cors);
  }
  if ("errorCode" in result) {
    deps.log(`[${FUNCTION_NAME}] recording the opt-out failed${safeCode(result.errorCode)}`);
    return json({ error: "Could not record the opt-out" }, 500, cors);
  }
  deps.log(`[${FUNCTION_NAME}] opt-out recorded by an admin: matched ${result.matched}, updated ${result.updated}`);
  if (result.matched === 0) {
    return json({ ok: true, matched: 0, updated: 0, note: "No account has this email address, so nothing was stored." }, 200, cors);
  }
  return json({ ok: true, matched: result.matched, updated: result.updated }, 200, cors);
}
