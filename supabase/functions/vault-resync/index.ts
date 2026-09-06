/**
 * vault-resync — re-sync the pg_cron Vault secrets from this function's own
 * injected environment, so a credential rotation is one call rather than a
 * hunt (gh-1531; the 2026-08-29 CEO ruling on hazard-register-security.md:36).
 *
 * What it writes (via the SECURITY DEFINER RPC public.cron_vault_resync,
 * migration 20260905044823_gh1531_cron_vault_resync.sql):
 *   vault.secrets 'cron_service_role_key'  <-  env SUPABASE_SERVICE_ROLE_KEY
 *   vault.secrets 'cron_secret'            <-  env CRON_SECRET
 *
 * Rotation runbook (Doppler is the record; the two runtime stores are the
 * Edge Function secrets and Vault):
 *   1. new value -> Doppler otterquote/prd
 *   2. new value -> Edge Function secrets (`supabase secrets set` / Management API)
 *   3. POST this function with an admin JWT  ->  Vault rows rewritten from (2)
 *   pg_cron jobs read Vault at fire time, so (3) completes the rotation.
 *
 * Auth: verify_jwt = true (supabase/config.toml) AND an in-handler single-admin
 *   gate (PRIMARY_ADMIN_EMAIL, gh-1534 semantics) — see gate.ts. Refuses every
 *   other caller with 403; refuses a missing/invalid token with 401.
 *
 * Body (optional JSON): { names?: ["cron_secret" | "cron_service_role_key"], dry_run?: boolean }
 * Response: { ok, dry_run, results: [{ name, action, len, prefix }], missing: [env names], rejected: [names] }
 *   — never a secret value; only length and a 4-char prefix.
 *
 * Unit tests: supabase/functions/vault-resync/gate.test.ts (deno test).
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { authorizeCaller, describe, parseBody, planResync, type ResyncResultRow } from "./gate.ts";

const FUNCTION_NAME = "vault-resync";

const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
];

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  const cors = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, cors);

  try {
    // ── Token ──
    const authHeader = req.headers.get("authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ ok: false, error: "Missing or invalid Authorization header" }, 401, cors);
    }
    const token = authHeader.substring(7);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ ok: false, error: "Server configuration error" }, 500, cors);
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // ── Caller gate: verified JWT email must be the single admin (gate.ts) ──
    const { data: callerData, error: callerError } = await supabase.auth.getUser(token);
    const gate = authorizeCaller(callerError ? null : callerData?.user?.email);
    if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status, cors);

    // ── Plan from our own env; values never leave this process ──
    const body = await req.json().catch(() => ({}));
    const { names, dryRun } = parseBody(body);
    const plan = planResync(Deno.env, names);

    const results: ResyncResultRow[] = [];
    for (const item of plan.items) {
      if (dryRun) {
        results.push(describe(item, "dry_run"));
        continue;
      }
      const { data, error } = await supabase.rpc("cron_vault_resync", {
        p_name: item.name,
        p_secret: item.value,
      });
      if (error) {
        console.error(`[${FUNCTION_NAME}] ${item.name}: ${error.message}`);
        results.push(describe(item, "error", error.message));
        continue;
      }
      const action = (data && typeof data === "object" && (data as { action?: string }).action === "created")
        ? "created"
        : "updated";
      results.push(describe(item, action));
    }

    const ok = results.every((r) => r.action !== "error") && plan.rejected.length === 0;
    console.log(
      `[${FUNCTION_NAME}] by=${callerData?.user?.email} dry_run=${dryRun} ` +
        results.map((r) => `${r.name}:${r.action}(len ${r.len})`).join(" ") +
        (plan.missing.length ? ` missing=${plan.missing.join(",")}` : ""),
    );
    return json(
      { ok, dry_run: dryRun, results, missing: plan.missing, rejected: plan.rejected },
      ok ? 200 : 422,
      cors,
    );
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] unexpected:`, (err as Error)?.message ?? err);
    return json({ ok: false, error: "Unexpected error" }, 500, cors);
  }
});
