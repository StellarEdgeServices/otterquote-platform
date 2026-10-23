// gh-3051 -- row loading for ga4-mp-conversion, split out of index.ts so it can be tested with a mock client (load-row.test.ts).
import type { ConversionKind, ConversionRow } from "./ga4-mp.ts";

// Minimal shape of the supabase-js query builder this file uses.
// deno-lint-ignore no-explicit-any
export type Db = { from: (table: string) => any };

export const LEAD_COLUMNS = "id,email,source,variant,utm_source,utm_medium,is_synthetic,created_at";
export const CLAIM_COLUMNS = "id,user_id,is_test,utm_source,utm_medium,created_at";
export const PROFILE_COLUMNS = "email,is_test";

export async function loadRow(sb: Db, kind: ConversionKind, id: string): Promise<ConversionRow | null> {
  if (kind === "lead") {
    const { data } = await sb.from("leads").select(LEAD_COLUMNS).eq("id", id).maybeSingle();
    // Only front-door router leads are the router_contact_submitted conversion (partner / agent leads are not).
    if (!data || data.source !== "router") return null;
    return { kind, id, email: data.email, variant: data.variant, utmSource: data.utm_source, utmMedium: data.utm_medium, isSynthetic: data.is_synthetic, createdAt: data.created_at };
  }
  const { data: c } = await sb.from("claims").select(CLAIM_COLUMNS).eq("id", id).maybeSingle();
  if (!c) return null;
  const { data: p } = await sb.from("profiles").select(PROFILE_COLUMNS).eq("id", c.user_id).maybeSingle();
  // A claim is test if the claim OR its owner's profile is flagged.
  return { kind, id, userId: c.user_id, email: p?.email ?? null, isTest: c.is_test === true || p?.is_test === true, utmSource: c.utm_source, utmMedium: c.utm_medium, createdAt: c.created_at };
}
