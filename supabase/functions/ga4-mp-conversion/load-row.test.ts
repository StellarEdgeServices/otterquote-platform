// gh-3051 -- tests for the row-loading code (load-row.ts) with a mocked query client. A bad select would otherwise silently become row_not_found.
// D-323 + D-336: also proves every advertising-sharing opt-out signal is read and folded into adOptOut, failing closed.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  CLAIM_COLUMNS, type Db, LEAD_COLUMNS, loadRow, normaliseEmail, PROFILE_BY_EMAIL_COLUMNS, PROFILE_COLUMNS, SUPPRESSION_COLUMNS,
} from "./load-row.ts";
import { sha256Hex } from "./ga4-mp.ts";

const LEAD_ID = "147641e5-1111-4222-8333-444455556666";
const CLAIM_ID = "c1a1a000-0000-4000-8000-000000000001";
const USER_ID = "d04a29db-aaaa-4bbb-8ccc-ddddeeeeffff";

type Row = Record<string, unknown> | null;
/** A table entry: a row, or a function of (col, val) -> row, or "ERROR" (the read returns an error), or "THROW". */
type Entry = Row | ((col: string, val: string) => Row) | "ERROR" | "THROW";
type Tables = Record<string, Entry>;
interface Seen { table: string; select: string; col: string; val: string }
/** Mock of supabase-js: from(t).select(cols).eq(col, val).maybeSingle() -> { data, error }; records what was asked. */
function mockDb(tables: Tables): { db: Db; seen: Seen[] } {
  const seen: Seen[] = [];
  const db: Db = {
    from: (table: string) => ({
      select: (select: string) => ({
        eq: (col: string, val: string) => ({
          maybeSingle: () => {
            seen.push({ table, select, col, val });
            const e = tables[table];
            if (e === "THROW") throw new Error("boom");
            if (e === "ERROR") return Promise.resolve({ data: null, error: { code: "42P01" } });
            const data = typeof e === "function" ? e(col, val) : (e ?? null);
            return Promise.resolve({ data, error: null });
          },
        }),
      }),
    }),
  };
  return { db, seen };
}

const LEAD_ROW = { id: LEAD_ID, email: "Jane@Gmail.com", source: "router", variant: "e", utm_source: "chatgpt.com", utm_medium: "referral", is_synthetic: false, created_at: "2026-10-23T12:00:00Z", ad_sharing_opt_out: false };
const CLAIM_ROW = { id: CLAIM_ID, user_id: USER_ID, is_test: false, utm_source: "google", utm_medium: "cpc", created_at: "2026-10-23T12:00:00Z", ad_sharing_opt_out: false };
const PROFILE = { email: "jane@gmail.com", is_test: false, ad_sharing_opt_out: null };
/** Every signal clear: insert-time FALSE, no suppression row, a profile with no stored opt-out. */
const CLEAR_LEAD: Tables = { leads: LEAD_ROW, ad_sharing_suppressions: null, profiles: { ad_sharing_opt_out: false } };
const CLEAR_CLAIM: Tables = { claims: CLAIM_ROW, profiles: PROFILE, ad_sharing_suppressions: null };

Deno.test("lead: a router lead maps every field, reads the D-336 signals, and queries with the documented columns", async () => {
  const { db, seen } = mockDb(CLEAR_LEAD);
  const row = await loadRow(db, "lead", LEAD_ID);
  assertEquals(row, { kind: "lead", id: LEAD_ID, email: "Jane@Gmail.com", variant: "e", utmSource: "chatgpt.com", utmMedium: "referral", isSynthetic: false, createdAt: "2026-10-23T12:00:00Z", adOptOut: "not_opted_out" });
  const digest = await sha256Hex("jane@gmail.com");
  assertEquals(seen, [
    { table: "leads", select: LEAD_COLUMNS, col: "id", val: LEAD_ID },
    { table: "ad_sharing_suppressions", select: SUPPRESSION_COLUMNS, col: "email_sha256", val: digest },
    { table: "profiles", select: PROFILE_BY_EMAIL_COLUMNS, col: "email", val: "jane@gmail.com" },
  ]);
  for (const c of ["source", "variant", "utm_source", "utm_medium", "is_synthetic", "created_at", "email", "ad_sharing_opt_out"]) assert(LEAD_COLUMNS.split(",").includes(c), c);
});

Deno.test("lead: is_synthetic true is carried through (so the handler suppresses it)", async () => {
  const row = await loadRow(mockDb({ ...CLEAR_LEAD, leads: { ...LEAD_ROW, is_synthetic: true } }).db, "lead", LEAD_ID);
  assertEquals(row?.isSynthetic, true);
});

Deno.test("lead: NEGATIVE CONTROL -- a non-router lead (re_agent / partner) returns null; the same row with source=router does not", async () => {
  for (const source of ["re_agent", "landing_page", "partner", null]) {
    assertEquals(await loadRow(mockDb({ ...CLEAR_LEAD, leads: { ...LEAD_ROW, source } }).db, "lead", LEAD_ID), null, String(source));
  }
  assert((await loadRow(mockDb(CLEAR_LEAD).db, "lead", LEAD_ID)) !== null);
});

Deno.test("lead / claim: a missing row (or a failed row read) returns null (row_not_found upstream)", async () => {
  assertEquals(await loadRow(mockDb({ leads: null }).db, "lead", LEAD_ID), null);
  assertEquals(await loadRow(mockDb({ claims: null }).db, "claim", CLAIM_ID), null);
  assertEquals(await loadRow(mockDb({ leads: "ERROR" }).db, "lead", LEAD_ID), null);
  assertEquals(await loadRow(mockDb({ claims: "THROW" }).db, "claim", CLAIM_ID), null);
});

Deno.test("claim: maps fields, reads the owner's profile by user_id + the suppression list, with the documented columns", async () => {
  const { db, seen } = mockDb(CLEAR_CLAIM);
  const row = await loadRow(db, "claim", CLAIM_ID);
  assertEquals(row, { kind: "claim", id: CLAIM_ID, userId: USER_ID, email: "jane@gmail.com", isTest: false, utmSource: "google", utmMedium: "cpc", createdAt: "2026-10-23T12:00:00Z", adOptOut: "not_opted_out" });
  assertEquals(seen, [
    { table: "claims", select: CLAIM_COLUMNS, col: "id", val: CLAIM_ID },
    { table: "profiles", select: PROFILE_COLUMNS, col: "id", val: USER_ID },
    { table: "ad_sharing_suppressions", select: SUPPRESSION_COLUMNS, col: "email_sha256", val: await sha256Hex("jane@gmail.com") },
  ]);
  assert(PROFILE_COLUMNS.split(",").includes("ad_sharing_opt_out") && CLAIM_COLUMNS.split(",").includes("ad_sharing_opt_out"));
});

Deno.test("claim: is_test is the OR of the claim flag and the owner's profile flag", async () => {
  const cases: Array<[boolean, boolean, boolean]> = [[true, false, true], [false, true, true], [true, true, true]];
  for (const [claimFlag, profileFlag, want] of cases) {
    const row = await loadRow(mockDb({ ...CLEAR_CLAIM, claims: { ...CLAIM_ROW, is_test: claimFlag }, profiles: { ...PROFILE, is_test: profileFlag } }).db, "claim", CLAIM_ID);
    assertEquals(row?.isTest, want, `claim=${claimFlag} profile=${profileFlag}`);
  }
});

Deno.test("claim: NEGATIVE CONTROL -- both flags false (or an owner profile that is missing) is NOT test", async () => {
  assertEquals((await loadRow(mockDb(CLEAR_CLAIM).db, "claim", CLAIM_ID))?.isTest, false);
  const noProfile = await loadRow(mockDb({ ...CLEAR_CLAIM, profiles: null }).db, "claim", CLAIM_ID);
  assertEquals(noProfile?.isTest, false);
  assertEquals(noProfile?.email, null);
});

Deno.test("claim: a null is_test on the claim is not treated as true", async () => {
  const row = await loadRow(mockDb({ ...CLEAR_CLAIM, claims: { ...CLAIM_ROW, is_test: null }, profiles: { ...PROFILE, is_test: null } }).db, "claim", CLAIM_ID);
  assertEquals(row?.isTest, false);
});

// ---- D-323 + D-336: every opt-out signal, fail closed (ruling 6371298079 items 1 and 2) ----
const OPTED: Array<[string, Tables]> = [
  ["insert-time TRUE (Sec-GPC / cookie / GPC header at write time)", { ...CLEAR_LEAD, leads: { ...LEAD_ROW, ad_sharing_opt_out: true } }],
  ["address on the support-email suppression list", { ...CLEAR_LEAD, ad_sharing_suppressions: (_c, v) => (v ? { email_sha256: v } : null) }],
  ["a profile with that address has the stored flag TRUE", { ...CLEAR_LEAD, profiles: { ad_sharing_opt_out: true } }],
];
const UNKNOWN_LEAD: Array<[string, Tables]> = [
  ["insert-time NULL (state never reported)", { ...CLEAR_LEAD, leads: { ...LEAD_ROW, ad_sharing_opt_out: null } }],
  ["insert-time column absent (trigger not applied)", { ...CLEAR_LEAD, leads: (() => { const { ad_sharing_opt_out: _x, ...r } = LEAD_ROW; return r; })() }],
  ["suppression read errors", { ...CLEAR_LEAD, ad_sharing_suppressions: "ERROR" }],
  ["suppression read throws", { ...CLEAR_LEAD, ad_sharing_suppressions: "THROW" }],
  ["profile-by-email read errors", { ...CLEAR_LEAD, profiles: "ERROR" }],
];
for (const [label, tables] of OPTED) {
  Deno.test(`D-336 lead: ${label} -> opted_out`, async () => {
    assertEquals((await loadRow(mockDb(tables).db, "lead", LEAD_ID))?.adOptOut, "opted_out");
  });
}
for (const [label, tables] of UNKNOWN_LEAD) {
  Deno.test(`D-336 lead: ${label} -> unknown (fail closed: not sent)`, async () => {
    assertEquals((await loadRow(mockDb(tables).db, "lead", LEAD_ID))?.adOptOut, "unknown");
  });
}
Deno.test("D-336 lead NEGATIVE CONTROL: every signal clear -> not_opted_out; no profile for the address is not an opt-out", async () => {
  assertEquals((await loadRow(mockDb(CLEAR_LEAD).db, "lead", LEAD_ID))?.adOptOut, "not_opted_out");
  assertEquals((await loadRow(mockDb({ ...CLEAR_LEAD, profiles: null }).db, "lead", LEAD_ID))?.adOptOut, "not_opted_out");
});

const CLAIM_CASES: Array<[string, Tables, string]> = [
  ["owner profile ad_sharing_opt_out TRUE", { ...CLEAR_CLAIM, profiles: { ...PROFILE, ad_sharing_opt_out: true } }, "opted_out"],
  ["claim insert-time TRUE (GPC / cookie at claim creation)", { ...CLEAR_CLAIM, claims: { ...CLAIM_ROW, ad_sharing_opt_out: true } }, "opted_out"],
  ["owner's address on the suppression list", { ...CLEAR_CLAIM, ad_sharing_suppressions: (_c, v) => ({ email_sha256: v }) }, "opted_out"],
  ["owner profile read FAILS", { ...CLEAR_CLAIM, profiles: "ERROR" }, "unknown"],
  ["owner profile read THROWS", { ...CLEAR_CLAIM, profiles: "THROW" }, "unknown"],
  ["owner profile MISSING", { ...CLEAR_CLAIM, profiles: null }, "unknown"],
  ["claim has no user_id", { ...CLEAR_CLAIM, claims: { ...CLAIM_ROW, user_id: null } }, "unknown"],
  ["claim insert-time NULL (state never reported)", { ...CLEAR_CLAIM, claims: { ...CLAIM_ROW, ad_sharing_opt_out: null } }, "unknown"],
  ["suppression read errors", { ...CLEAR_CLAIM, ad_sharing_suppressions: "ERROR" }, "unknown"],
];
for (const [label, tables, want] of CLAIM_CASES) {
  Deno.test(`D-336 claim: ${label} -> ${want}`, async () => {
    assertEquals((await loadRow(mockDb(tables).db, "claim", CLAIM_ID))?.adOptOut, want);
  });
}
Deno.test("D-336 claim NEGATIVE CONTROL: profile flag FALSE or NULL with every other signal clear -> not_opted_out", async () => {
  for (const v of [false, null]) {
    assertEquals((await loadRow(mockDb({ ...CLEAR_CLAIM, profiles: { ...PROFILE, ad_sharing_opt_out: v } }).db, "claim", CLAIM_ID))?.adOptOut, "not_opted_out", String(v));
  }
});

Deno.test("suppression digest uses stripe-webhook's normalisation (trim + lowercase)", async () => {
  assertEquals(normaliseEmail("  Jane@Gmail.COM "), "jane@gmail.com");
  assertEquals(normaliseEmail(""), null);
  assertEquals(normaliseEmail(null), null);
});
