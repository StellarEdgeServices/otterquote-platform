// gh-3051 -- row loading for ga4-mp-conversion, split out of index.ts so it can be tested with a mock client (load-row.test.ts).
//
// D-323 + D-336: this file also reads every advertising-sharing opt-out signal for the person and folds them into
// ConversionRow.adOptOut (see ad-optout.ts). Every read that errors makes the state "unknown", which the handler does not send.
import type { ConversionKind, ConversionRow } from "./ga4-mp.ts";
import { sha256Hex } from "./ga4-mp.ts";
import { type AdOptOutState, combine, insertTimeState, storedProfileState, suppressionState } from "./ad-optout.ts";

// Minimal shape of the supabase-js query builder this file uses.
// deno-lint-ignore no-explicit-any
export type Db = { from: (table: string) => any };

export const LEAD_COLUMNS = "id,email,source,variant,utm_source,utm_medium,is_synthetic,created_at,ad_sharing_opt_out";
export const CLAIM_COLUMNS = "id,user_id,is_test,utm_source,utm_medium,created_at,ad_sharing_opt_out";
export const PROFILE_COLUMNS = "email,is_test,ad_sharing_opt_out";
/** Profiles looked up by a router lead's address: a signed-in person's stored opt-out follows them (ga-gate.js does the same). */
export const PROFILE_BY_EMAIL_COLUMNS = "ad_sharing_opt_out";
export const SUPPRESSION_COLUMNS = "email_sha256";

interface Read { data: Record<string, unknown> | null; failed: boolean }

/** One `select ... eq ... maybeSingle()` that never throws. A thrown or returned error is `failed`. */
async function readOne(sb: Db, table: string, cols: string, col: string, val: string): Promise<Read> {
  try {
    const { data, error } = await sb.from(table).select(cols).eq(col, val).maybeSingle();
    return { data: (data as Record<string, unknown> | null) ?? null, failed: !!error };
  } catch {
    return { data: null, failed: true };
  }
}

/** Same normalisation as stripe-webhook's CAPI hashing (trim + lowercase), so the digest matches ad_sharing_suppressions rows. */
export function normaliseEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  return e ? e : null;
}

/** The support-email suppression list (D-336 "a single suppression mechanism"). No address means nothing to match: not opted out. */
async function suppressionFor(sb: Db, email: string | null): Promise<AdOptOutState> {
  if (!email) return "not_opted_out";
  let digest: string;
  try { digest = await sha256Hex(email); } catch { return "unknown"; }
  const r = await readOne(sb, "ad_sharing_suppressions", SUPPRESSION_COLUMNS, "email_sha256", digest);
  return suppressionState(!!r.data, r.failed);
}

export async function loadRow(sb: Db, kind: ConversionKind, id: string): Promise<ConversionRow | null> {
  if (kind === "lead") {
    const { data } = await readOne(sb, "leads", LEAD_COLUMNS, "id", id);
    // Only front-door router leads are the router_contact_submitted conversion (partner / agent leads are not).
    if (!data || data.source !== "router") return null;
    const email = normaliseEmail(data.email);
    const states: AdOptOutState[] = [insertTimeState({ value: data.ad_sharing_opt_out as boolean | null })];
    // Only worth reading further if the insert-time state has not already decided it.
    if (states[0] === "not_opted_out") {
      states.push(await suppressionFor(sb, email));
      if (email) {
        const p = await readOne(sb, "profiles", PROFILE_BY_EMAIL_COLUMNS, "email", email);
        states.push(storedProfileState({ value: p.data?.ad_sharing_opt_out as boolean | null, failed: p.failed, missing: !p.data }, false));
      }
    }
    return {
      kind, id, email: data.email as string | null, variant: data.variant as string | null, utmSource: data.utm_source as string | null,
      utmMedium: data.utm_medium as string | null, isSynthetic: data.is_synthetic as boolean | null, createdAt: data.created_at as string | null,
      adOptOut: combine(states),
    };
  }
  const { data: c } = await readOne(sb, "claims", CLAIM_COLUMNS, "id", id);
  if (!c) return null;
  const userId = (c.user_id as string | null) ?? null;
  const p = userId ? await readOne(sb, "profiles", PROFILE_COLUMNS, "id", userId) : { data: null, failed: true };
  const email = normaliseEmail(p.data?.email);
  const states: AdOptOutState[] = [
    insertTimeState({ value: c.ad_sharing_opt_out as boolean | null }),
    // Ruling 6371298079 item (1): read ad_sharing_opt_out with the claim owner's profile; SKIP if true or the read fails.
    storedProfileState({ value: p.data?.ad_sharing_opt_out as boolean | null, failed: p.failed, missing: !p.data }, true),
  ];
  if (!states.includes("opted_out") && !states.includes("unknown")) states.push(await suppressionFor(sb, email));
  // A claim is test if the claim OR its owner's profile is flagged.
  return {
    kind, id, userId, email: (p.data?.email as string | null) ?? null, isTest: c.is_test === true || p.data?.is_test === true,
    utmSource: c.utm_source as string | null, utmMedium: c.utm_medium as string | null, createdAt: c.created_at as string | null,
    adOptOut: combine(states),
  };
}
