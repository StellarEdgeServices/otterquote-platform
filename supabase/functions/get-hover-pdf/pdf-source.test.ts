// Deno unit tests for gh-1538's get-hover-pdf half: before this, the
// function only ever checked hover_job_id and returned 500 ("Hover job ID
// not found on order record") for every manually fulfilled order, even one
// with an admin-uploaded PDF sitting in Storage at report_url. It also
// still filtered `.eq("status", "complete")` against a column that only
// ever holds "completed" for manual orders (fixed separately in PR #1581 —
// selectPdfSource here is the part that PR did not cover).
//
// Run: deno test --allow-read=supabase/functions supabase/functions/get-hover-pdf/

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { canAccessClaim, selectPdfSource } from "./pdf-source.ts";

// ── selectPdfSource ──────────────────────────────────────────────────────
// Covers gh-1538 AC: "a manual order (NULL job id) served, hover order
// served" — i.e. both order shapes route to a real PDF source instead of a
// dead end.

Deno.test("selectPdfSource: hover order (hover_job_id set) routes to the Hover API path", () => {
  const source = selectPdfSource({ hover_job_id: "job_123", report_url: null });
  assertEquals(source, { kind: "hover", jobId: "job_123" });
});

Deno.test("selectPdfSource: manual order (hover_job_id NULL, report_url set) routes to Storage — gh-1538 AC", () => {
  const source = selectPdfSource({
    hover_job_id: null,
    report_url: "d71831ae-2c6d-487b-af52-ef0598d30448/measurements/73208937-a1c2-4db5-b402-3e7ec76374ae/716e0bab-1b69-436a-87c5-ef8210036d96.pdf",
  });
  assertEquals(source.kind, "manual");
  if (source.kind === "manual") {
    assertEquals(
      source.path,
      "d71831ae-2c6d-487b-af52-ef0598d30448/measurements/73208937-a1c2-4db5-b402-3e7ec76374ae/716e0bab-1b69-436a-87c5-ef8210036d96.pdf",
    );
  }
});

Deno.test("selectPdfSource: manual order with neither hover_job_id nor report_url has no file to serve", () => {
  // Measurements entered manually but no PDF ever uploaded (the actual
  // shape of the one live is_test row at time of writing: status=completed,
  // hover_job_id=null, report_url=null, measurements_json present).
  const source = selectPdfSource({ hover_job_id: null, report_url: null });
  assertEquals(source, { kind: "none" });
});

Deno.test("selectPdfSource: hover_job_id takes priority when both are somehow set", () => {
  const source = selectPdfSource({ hover_job_id: "job_123", report_url: "some/path.pdf" });
  assertEquals(source.kind, "hover");
});

// ── canAccessClaim ───────────────────────────────────────────────────────
// Covers gh-1538 AC: "a non-owner refused" — and confirms the same gate a
// legitimate owner/contractor passes through is unchanged by this issue's
// fix (the authorization check runs identically before selectPdfSource is
// ever reached, for both order shapes).

function stubSupabase(tables: Record<string, unknown[]>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const builder = {
        _rows: rows as any[],
        _filters: [] as Array<(row: any) => boolean>,
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          builder._filters.push((row: any) => row[col] === val);
          return builder;
        },
        in(col: string, vals: unknown[]) {
          builder._filters.push((row: any) => vals.includes(row[col]));
          return builder;
        },
        limit() {
          return builder;
        },
        maybeSingle() {
          const match = builder._rows.find((row) => builder._filters.every((f) => f(row))) ?? null;
          return Promise.resolve({ data: match, error: null });
        },
        then(resolve: (v: { data: any[]; error: null }) => void) {
          const matched = builder._rows.filter((row) => builder._filters.every((f) => f(row)));
          resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
  };
}

const HOMEOWNER = { id: "homeowner-1" };
const OTHER_USER = { id: "stranger-1" };
const CONTRACTOR_USER = { id: "contractor-user-1" };

const CLAIM_ID = "claim-1";

function baseTables() {
  return {
    claims: [
      { id: CLAIM_ID, user_id: HOMEOWNER.id, ready_for_bids: true, status: "bidding" },
    ],
    contractors: [] as any[],
    quotes: [] as any[],
  };
}

Deno.test("canAccessClaim: the owning homeowner is served", async () => {
  const supabase = stubSupabase(baseTables());
  const allowed = await canAccessClaim(supabase, CLAIM_ID, HOMEOWNER);
  assertEquals(allowed, true);
});

Deno.test("canAccessClaim: a non-owner with no contractor record is refused — gh-1538 AC", async () => {
  const supabase = stubSupabase(baseTables());
  const allowed = await canAccessClaim(supabase, CLAIM_ID, OTHER_USER);
  assertEquals(allowed, false);
});

Deno.test("canAccessClaim: a non-owner, inactive-contractor caller is refused", async () => {
  const tables = baseTables();
  tables.contractors = [{ id: "c1", user_id: CONTRACTOR_USER.id, status: "inactive" }];
  const supabase = stubSupabase(tables);
  const allowed = await canAccessClaim(supabase, CLAIM_ID, CONTRACTOR_USER);
  assertEquals(allowed, false);
});

// gh-2559 / D-370 (CEO ruling 6045857216): no measurement report before
// selection. The first two cases below were SERVED before this change.
Deno.test("canAccessClaim: an active contractor on a released biddable claim, nobody selected, is REFUSED (gh-2559)", async () => {
  const tables = baseTables();
  tables.contractors = [{ id: "c1", user_id: CONTRACTOR_USER.id, status: "active" }];
  const allowed = await canAccessClaim(stubSupabase(tables), CLAIM_ID, CONTRACTOR_USER);
  assertEquals(allowed, false);
});

Deno.test("canAccessClaim: an active contractor with a quote on the claim, not selected, is REFUSED (gh-2559)", async () => {
  const tables = baseTables();
  tables.contractors = [{ id: "c1", user_id: CONTRACTOR_USER.id, status: "active" }];
  tables.quotes = [{ id: "q1", claim_id: CLAIM_ID, contractor_id: "c1" }];
  const allowed = await canAccessClaim(stubSupabase(tables), CLAIM_ID, CONTRACTOR_USER);
  assertEquals(allowed, false);
});

Deno.test("canAccessClaim: a bidder is REFUSED when another contractor is the selected one (gh-2559)", async () => {
  const tables = baseTables();
  (tables.claims[0] as any).selected_contractor_id = "k-selected";
  tables.contractors = [{ id: "c1", user_id: CONTRACTOR_USER.id, status: "active" }];
  tables.quotes = [{ id: "q1", claim_id: CLAIM_ID, contractor_id: "c1" }];
  const allowed = await canAccessClaim(stubSupabase(tables), CLAIM_ID, CONTRACTOR_USER);
  assertEquals(allowed, false);
});

Deno.test("canAccessClaim: the SELECTED contractor, active, is served, also after the claim closes for bids (gh-2559)", async () => {
  const tables = baseTables();
  (tables.claims[0] as any).selected_contractor_id = "k-selected";
  tables.contractors = [{ id: "k-selected", user_id: CONTRACTOR_USER.id, status: "active" }];
  assertEquals(await canAccessClaim(stubSupabase(tables), CLAIM_ID, CONTRACTOR_USER), true);
  tables.claims[0].ready_for_bids = false;
  tables.claims[0].status = "contract_signed";
  assertEquals(await canAccessClaim(stubSupabase(tables), CLAIM_ID, CONTRACTOR_USER), true);
});

Deno.test("canAccessClaim: the selected contractor record, when not active, is REFUSED (gh-2559)", async () => {
  const tables = baseTables();
  (tables.claims[0] as any).selected_contractor_id = "k-selected";
  tables.contractors = [{ id: "k-selected", user_id: CONTRACTOR_USER.id, status: "suspended" }];
  const allowed = await canAccessClaim(stubSupabase(tables), CLAIM_ID, CONTRACTOR_USER);
  assertEquals(allowed, false);
});

Deno.test("canAccessClaim: a user with two contractor records is served only through the selected one (gh-2559)", async () => {
  const tables = baseTables();
  (tables.claims[0] as any).selected_contractor_id = "k-selected";
  tables.contractors = [{ id: "k-other", user_id: CONTRACTOR_USER.id, status: "active" }];
  assertEquals(await canAccessClaim(stubSupabase(tables), CLAIM_ID, CONTRACTOR_USER), false);
  tables.contractors.push({ id: "k-selected", user_id: CONTRACTOR_USER.id, status: "active" });
  assertEquals(await canAccessClaim(stubSupabase(tables), CLAIM_ID, CONTRACTOR_USER), true);
});

Deno.test("canAccessClaim: an unknown claim id is refused", async () => {
  const supabase = stubSupabase(baseTables());
  const allowed = await canAccessClaim(supabase, "no-such-claim", HOMEOWNER);
  assertEquals(allowed, false);
});
