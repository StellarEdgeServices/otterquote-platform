/**
 * admin-gate.ts -- the one place Edge Function admin gates read the admin set (gh-3077, PR a).
 *
 * Two checks, each failing CLOSED, each preserving EXACTLY the set the call site accepted
 * before this file existed (CTO RUN 83 ruling on #3077: "nothing widens"):
 *
 *   requireAdmin(req)         -- the caller's JWT is verified with Supabase auth, then the live SQL
 *                                function public.is_admin_email() is called WITH THAT JWT. Today it
 *                                accepts dustinstohler1@gmail.com and dustin@otterquote.com
 *                                (case-sensitive exact match on auth.jwt() ->> 'email'; NULL -> deny).
 *                                When #3009's admin_emails table is applied, only that function's
 *                                body changes; no call site here changes.
 *   requirePrimaryAdmin(req)  -- the verified JWT email must equal the single primary address. There
 *                                is no SQL counterpart, so this is the only literal left in the
 *                                Edge Function gates; it stays separate from requireAdmin so the
 *                                primary-only functions are not widened to the second address.
 *
 * Result shape: { ok: true, user } or { ok: false, status, reason, user? }.
 *   status 401 = no/invalid/expired credential (nobody was identified);
 *   status 403 = identified but not in the accepted set, or the check itself could not be completed.
 * Call sites keep their own response bodies and status codes; they only branch on `ok`
 * (and on `user` for the contractors.template_review_role fallback, which stays at the call site).
 *
 * Deployment: imports of other _shared/* modules are known to work for deployed functions, but this
 * helper is proven in production only by the first deploy of a function that imports it (#3077).
 * Merged is not deployed.
 */

export const PRIMARY_ADMIN_EMAIL = "dustinstohler1@gmail.com";

export interface GateUser {
  id: string;
  email: string | null;
}

export type GateResult =
  | { ok: true; user: GateUser }
  | { ok: false; status: 401 | 403; reason: string; user?: GateUser };

/** The slice of the supabase-js client this helper uses. */
export interface GateClient {
  auth: {
    getUser(): Promise<{
      data: { user: { id: string; email?: string | null } | null } | null;
      error: unknown;
    }>;
  };
  rpc(fn: string): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface GateDeps {
  /** Env reader; defaults to Deno.env.get. */
  getEnv?: (name: string) => string | undefined;
  /** Client factory; defaults to supabase-js. `authHeader` is the caller's Authorization header, verbatim. */
  makeClient?: (url: string, key: string, authHeader: string) => GateClient | Promise<GateClient>;
}

async function defaultMakeClient(url: string, key: string, authHeader: string): Promise<GateClient> {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.114.0");
  return createClient(url, key, { global: { headers: { Authorization: authHeader } } }) as unknown as GateClient;
}

/** Verify the caller's JWT. Returns the client (carrying that JWT) and the verified user, or a deny. */
async function verifyCaller(
  req: Request,
  deps: GateDeps,
): Promise<{ ok: true; client: GateClient; user: GateUser } | { ok: false; status: 401 | 403; reason: string }> {
  const getEnv = deps.getEnv ?? ((n: string) => Deno.env.get(n));
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(authHeader)) {
    return { ok: false, status: 401, reason: "missing bearer token" };
  }
  const url = getEnv("SUPABASE_URL") ?? "";
  const key = getEnv("SUPABASE_ANON_KEY") || getEnv("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !key) return { ok: false, status: 403, reason: "gate not configured" };
  try {
    const client = await (deps.makeClient ?? defaultMakeClient)(url, key, authHeader);
    const { data, error } = await client.auth.getUser();
    const u = data?.user;
    if (error || !u || !u.id) return { ok: false, status: 401, reason: "invalid token" };
    return { ok: true, client, user: { id: u.id, email: u.email ?? null } };
  } catch (_e) {
    return { ok: false, status: 403, reason: "gate error" };
  }
}

/** Admin set = whatever public.is_admin_email() accepts for the caller's JWT. Fails closed. */
export async function requireAdmin(req: Request, deps: GateDeps = {}): Promise<GateResult> {
  const v = await verifyCaller(req, deps);
  if (!v.ok) return v;
  try {
    const { data, error } = await v.client.rpc("is_admin_email");
    if (error || data !== true) return { ok: false, status: 403, reason: "not an admin", user: v.user };
  } catch (_e) {
    return { ok: false, status: 403, reason: "gate error", user: v.user };
  }
  return { ok: true, user: v.user };
}

/** Primary-admin-only: the verified JWT email must equal PRIMARY_ADMIN_EMAIL exactly. Fails closed. */
export async function requirePrimaryAdmin(req: Request, deps: GateDeps = {}): Promise<GateResult> {
  const v = await verifyCaller(req, deps);
  if (!v.ok) return v;
  if (v.user.email !== PRIMARY_ADMIN_EMAIL) {
    return { ok: false, status: 403, reason: "not the primary admin", user: v.user };
  }
  return { ok: true, user: v.user };
}
