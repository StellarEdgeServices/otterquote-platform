// gh-3051 -- tests for the row-loading code (load-row.ts) with a mocked query client. A bad select would otherwise silently become row_not_found.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { CLAIM_COLUMNS, type Db, LEAD_COLUMNS, loadRow, PROFILE_COLUMNS } from "./load-row.ts";

const LEAD_ID = "147641e5-1111-4222-8333-444455556666";
const CLAIM_ID = "c1a1a000-0000-4000-8000-000000000001";
const USER_ID = "d04a29db-aaaa-4bbb-8ccc-ddddeeeeffff";

type Tables = Record<string, Record<string, unknown> | null>;
interface Seen { table: string; select: string; col: string; val: string }
/** Mock of supabase-js: from(t).select(cols).eq(col, val).maybeSingle() -> { data } from `tables[t]`; records what was asked. */
function mockDb(tables: Tables): { db: Db; seen: Seen[] } {
  const seen: Seen[] = [];
  const db: Db = {
    from: (table: string) => ({
      select: (select: string) => ({
        eq: (col: string, val: string) => ({
          maybeSingle: () => { seen.push({ table, select, col, val }); return Promise.resolve({ data: tables[table] ?? null }); },
        }),
      }),
    }),
  };
  return { db, seen };
}

const LEAD_ROW = { id: LEAD_ID, email: "jane@gmail.com", source: "router", variant: "e", utm_source: "chatgpt.com", utm_medium: "referral", is_synthetic: false, created_at: "2026-10-23T12:00:00Z" };
const CLAIM_ROW = { id: CLAIM_ID, user_id: USER_ID, is_test: false, utm_source: "google", utm_medium: "cpc", created_at: "2026-10-23T12:00:00Z" };

Deno.test("lead: a router lead maps every field and queries leads by id with the documented columns", async () => {
  const { db, seen } = mockDb({ leads: LEAD_ROW });
  const row = await loadRow(db, "lead", LEAD_ID);
  assertEquals(row, { kind: "lead", id: LEAD_ID, email: "jane@gmail.com", variant: "e", utmSource: "chatgpt.com", utmMedium: "referral", isSynthetic: false, createdAt: "2026-10-23T12:00:00Z" });
  assertEquals(seen, [{ table: "leads", select: LEAD_COLUMNS, col: "id", val: LEAD_ID }]);
  for (const c of ["source", "variant", "utm_source", "utm_medium", "is_synthetic", "created_at", "email"]) assert(LEAD_COLUMNS.split(",").includes(c), c);
});

Deno.test("lead: is_synthetic true is carried through (so the handler suppresses it)", async () => {
  const row = await loadRow(mockDb({ leads: { ...LEAD_ROW, is_synthetic: true } }).db, "lead", LEAD_ID);
  assertEquals(row?.isSynthetic, true);
});

Deno.test("lead: NEGATIVE CONTROL -- a non-router lead (re_agent / partner) returns null; the same row with source=router does not", async () => {
  for (const source of ["re_agent", "landing_page", "partner", null]) {
    assertEquals(await loadRow(mockDb({ leads: { ...LEAD_ROW, source } }).db, "lead", LEAD_ID), null, String(source));
  }
  assert((await loadRow(mockDb({ leads: { ...LEAD_ROW, source: "router" } }).db, "lead", LEAD_ID)) !== null);
});

Deno.test("lead / claim: a missing row returns null (row_not_found upstream)", async () => {
  assertEquals(await loadRow(mockDb({ leads: null }).db, "lead", LEAD_ID), null);
  assertEquals(await loadRow(mockDb({ claims: null }).db, "claim", CLAIM_ID), null);
});

Deno.test("claim: maps fields, reads the owner's profile by user_id, and queries with the documented columns", async () => {
  const { db, seen } = mockDb({ claims: CLAIM_ROW, profiles: { email: "jane@gmail.com", is_test: false } });
  const row = await loadRow(db, "claim", CLAIM_ID);
  assertEquals(row, { kind: "claim", id: CLAIM_ID, userId: USER_ID, email: "jane@gmail.com", isTest: false, utmSource: "google", utmMedium: "cpc", createdAt: "2026-10-23T12:00:00Z" });
  assertEquals(seen, [
    { table: "claims", select: CLAIM_COLUMNS, col: "id", val: CLAIM_ID },
    { table: "profiles", select: PROFILE_COLUMNS, col: "id", val: USER_ID },
  ]);
});

Deno.test("claim: is_test is the OR of the claim flag and the owner's profile flag", async () => {
  const cases: Array<[boolean, boolean, boolean]> = [[true, false, true], [false, true, true], [true, true, true]];
  for (const [claimFlag, profileFlag, want] of cases) {
    const row = await loadRow(mockDb({ claims: { ...CLAIM_ROW, is_test: claimFlag }, profiles: { email: "a@gmail.com", is_test: profileFlag } }).db, "claim", CLAIM_ID);
    assertEquals(row?.isTest, want, `claim=${claimFlag} profile=${profileFlag}`);
  }
});

Deno.test("claim: NEGATIVE CONTROL -- both flags false (or an owner profile that is missing) is NOT test", async () => {
  assertEquals((await loadRow(mockDb({ claims: CLAIM_ROW, profiles: { email: "a@gmail.com", is_test: false } }).db, "claim", CLAIM_ID))?.isTest, false);
  const noProfile = await loadRow(mockDb({ claims: CLAIM_ROW, profiles: null }).db, "claim", CLAIM_ID);
  assertEquals(noProfile?.isTest, false);
  assertEquals(noProfile?.email, null);
});

Deno.test("claim: a null is_test on the claim is not treated as true", async () => {
  const row = await loadRow(mockDb({ claims: { ...CLAIM_ROW, is_test: null }, profiles: { email: "a@gmail.com", is_test: null } }).db, "claim", CLAIM_ID);
  assertEquals(row?.isTest, false);
});
