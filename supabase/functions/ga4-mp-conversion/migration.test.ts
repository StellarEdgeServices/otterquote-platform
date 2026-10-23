// gh-3051 -- static checks on the DRAFT migration (needs --allow-read=supabase/migrations_drafts,supabase/migrations_rollbacks, as CI grants).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const SQL_URL = new URL("../../migrations_drafts/gh3051_ga4_mp_conversion_triggers.sql", import.meta.url);
const ROLLBACK_URL = new URL("../../migrations_rollbacks/gh3051_ga4_mp_conversion_triggers_rollback.sql", import.meta.url);

const stripComments = (sql: string) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

/** Returns the list of problems; empty = the migration meets the gh-3051 rails. */
export function lintMigration(sql: string): string[] {
  const code = stripComments(sql);
  const bad: string[] = [];
  if (!/REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.notify_ga4_mp_conversion\(\)\s+FROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated\s*;/i.test(code)) bad.push("missing REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated");
  if (!/has_function_privilege\(\s*'anon'/i.test(code) || !/has_function_privilege\(\s*'authenticated'/i.test(code)) bad.push("missing in-migration privilege assertion");
  if (/ON\s+public\.profiles/i.test(code) || /sign_up/i.test(code)) bad.push("sign_up / profiles trigger present (dropped by CTO ruling)");
  if (!/CREATE TRIGGER trg_ga4_mp_lead AFTER INSERT ON public\.leads/i.test(code)) bad.push("missing leads trigger");
  if (!/CREATE TRIGGER trg_ga4_mp_claim AFTER INSERT ON public\.claims/i.test(code)) bad.push("missing claims trigger");
  if (!/SECURITY DEFINER/i.test(code) || !/EXCEPTION WHEN OTHERS/i.test(code)) bad.push("function must be SECURITY DEFINER and swallow errors");
  if (!/GRANT SELECT, INSERT, DELETE ON public\.ga4_mp_sent TO service_role/i.test(code)) bad.push("missing service_role grant on ga4_mp_sent");
  if (!/'event_id'|'id',\s*NEW\.id/.test(code) || /to_jsonb\(NEW\)/i.test(code)) bad.push("pg_net body must be {event_type,id} only");
  return bad;
}

Deno.test("draft migration: REVOKE EXECUTE, assertion, two triggers, no sign_up, id-only body", async () => {
  assertEquals(lintMigration(await Deno.readTextFile(SQL_URL)), []);
});

Deno.test("draft migration header states that apply + deploy starts production sends via the GA4_API_SECRET fallback", async () => {
  const sql = await Deno.readTextFile(SQL_URL);
  assert(/GO-LIVE WARNING/.test(sql) && /GA4_API_SECRET/.test(sql) && /PRODUCTION sends to GA4 immediately/.test(sql));
});

Deno.test("NEGATIVE CONTROL: the lint catches a migration without the REVOKE, with a profiles trigger, or with a row-content body", async () => {
  const good = await Deno.readTextFile(SQL_URL);
  const noRevoke = good.replace(/REVOKE EXECUTE ON FUNCTION[^;]*;/i, "");
  assert(lintMigration(noRevoke).some((p) => p.includes("REVOKE")));
  const withProfiles = good + "\nCREATE TRIGGER t AFTER INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.notify_ga4_mp_conversion('sign_up');";
  assert(lintMigration(withProfiles).some((p) => p.includes("sign_up")));
  const leaky = good.replace("jsonb_build_object('event_type', TG_ARGV[0], 'id', NEW.id)", "jsonb_build_object('event_type', TG_ARGV[0], 'record', to_jsonb(NEW))");
  assert(lintMigration(leaky).some((p) => p.includes("pg_net body")));
});

Deno.test("rollback drops both triggers, the function and the table; no profiles trigger", async () => {
  const rb = stripComments(await Deno.readTextFile(ROLLBACK_URL));
  for (const t of ["trg_ga4_mp_lead", "trg_ga4_mp_claim"]) assert(rb.includes(`DROP TRIGGER IF EXISTS ${t}`), t);
  assert(rb.includes("DROP FUNCTION IF EXISTS public.notify_ga4_mp_conversion()") && rb.includes("DROP TABLE IF EXISTS public.ga4_mp_sent"));
  assert(!/profiles/.test(rb));
});
