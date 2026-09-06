// vault-resync/gate.ts
//
// Pure caller-gate + planning logic for vault-resync, split out of index.ts
// (same source-split pattern as mint-test-session/gate.ts and
// watch-template-mapping/select-stale.ts) so it can be unit-tested with no
// live Supabase client and no network listener. index.ts wires the verified
// JWT email and Deno.env into the functions below.
//
// gh-1531: the 2026-08-29 ruling owes "an Edge Function re-syncing Vault from
// its own injected SUPABASE_SERVICE_ROLE_KEY after any rotation". This module
// decides WHO may trigger that and WHAT gets written; it never logs, returns,
// or serialises a secret value — only its name, length and 4-char prefix.

// gh-1534: kept in sync with supabase/functions/_shared/admin.ts
// PRIMARY_ADMIN_EMAIL — inlined, not imported, because the EF deploy path
// does not bundle _shared/ (see that file's header). Single-admin gate, the
// same narrow list as mint-test-session / admin-contractor-action; do not
// widen to ADMIN_EMAILS without an explicit access-widening decision.
export const PRIMARY_ADMIN_EMAIL = "dustinstohler1@gmail.com";

/** Vault secret name -> Edge Function env var it is re-synced from. */
export const RESYNC_TARGETS: Readonly<Record<string, string>> = {
  cron_service_role_key: "SUPABASE_SERVICE_ROLE_KEY",
  cron_secret: "CRON_SECRET",
};

export type GateResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Caller gate. `email` must be the VERIFIED email from
 * `supabase.auth.getUser(token)` — never a client-supplied value.
 * Case-sensitive exact match (matches the gh-1534 majority semantics).
 */
export function authorizeCaller(email: string | null | undefined): GateResult {
  if (!email) return { ok: false, status: 401, error: "Unauthenticated" };
  if (email !== PRIMARY_ADMIN_EMAIL) {
    return { ok: false, status: 403, error: "Unauthorized" };
  }
  return { ok: true };
}

export interface ResyncPlanItem {
  name: string; // Vault secret name
  envName: string; // env var the value comes from
  value: string; // the secret — never leaves the process
}

export interface ResyncPlan {
  items: ResyncPlanItem[];
  missing: string[]; // env vars that were unset/empty — reported by NAME only
  rejected: string[]; // requested names not in RESYNC_TARGETS
}

/**
 * Build the write plan from the function's own env. `requested` narrows to a
 * subset of RESYNC_TARGETS (default: all). Unknown names are rejected rather
 * than silently ignored; unset env vars are reported by name and skipped so
 * a partially-configured environment never overwrites a good Vault row with
 * an empty string.
 */
export function planResync(
  env: { get(name: string): string | undefined },
  requested?: string[] | null,
): ResyncPlan {
  const names = requested && requested.length > 0
    ? requested
    : Object.keys(RESYNC_TARGETS);
  const plan: ResyncPlan = { items: [], missing: [], rejected: [] };
  for (const name of names) {
    const envName = RESYNC_TARGETS[name];
    if (!envName) {
      plan.rejected.push(String(name));
      continue;
    }
    const value = env.get(envName) ?? "";
    if (value.length < 16) {
      plan.missing.push(envName);
      continue;
    }
    plan.items.push({ name, envName, value });
  }
  return plan;
}

export interface ResyncResultRow {
  name: string;
  action: "created" | "updated" | "dry_run" | "error";
  len: number;
  prefix: string;
  error?: string;
}

/** Describe one plan item without its value (safe for logs and responses). */
export function describe(item: ResyncPlanItem, action: ResyncResultRow["action"], error?: string): ResyncResultRow {
  const row: ResyncResultRow = {
    name: item.name,
    action,
    len: item.value.length,
    prefix: item.value.slice(0, 4),
  };
  if (error) row.error = error;
  return row;
}

export interface ParsedBody {
  names: string[] | null;
  dryRun: boolean;
}

/** Parse the optional JSON body: { names?: string[], dry_run?: boolean }. */
export function parseBody(body: unknown): ParsedBody {
  const b = (body && typeof body === "object") ? body as Record<string, unknown> : {};
  const names = Array.isArray(b.names)
    ? b.names.filter((n): n is string => typeof n === "string")
    : null;
  return { names, dryRun: b.dry_run === true };
}
