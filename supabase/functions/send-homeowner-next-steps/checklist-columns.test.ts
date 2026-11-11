// gh-1570 — the draft derive-from-columns rule exists in two places (the nudge
// and get-homeowner-list/rows.ts, because EFs cannot share code across
// directories). This test pins them to each other.
// Run: deno test supabase/functions/send-homeowner-next-steps/checklist-columns.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { isChecklistCompleteByColumns, resolveChecklistCompletedAt } from "./checklist-columns.ts";
import { resolveChecklistCompleteAt } from "../get-homeowner-list/rows.ts";

const UPDATED = "2026-09-09T10:00:00Z";

Deno.test("checklist-columns: nudge and admin-tab derivations agree on every column combination", () => {
  for (const status of ["draft", "documents_needed", "submitted"]) {
    for (const funding_type of ["cash", "insurance", null]) {
      for (const has_estimate of [true, false]) {
        for (const has_measurements of [true, false]) {
          for (const has_material_selection of [true, false]) {
            const c = {
              id: "c", user_id: "u", status, funding_type, has_estimate, has_measurements, has_material_selection,
              created_at: "2026-08-01T00:00:00Z", updated_at: UPDATED, trades: null, job_type: null,
              is_test: false, homeowner_name: null,
            };
            const a = resolveChecklistCompletedAt(c, undefined) ?? null;
            const b = resolveChecklistCompleteAt(c, undefined);
            assertEquals(a, b, JSON.stringify(c));
            // an existing event always wins, in both
            assertEquals(resolveChecklistCompletedAt(c, "E"), "E");
            assertEquals(resolveChecklistCompleteAt(c, "E"), "E");
          }
        }
      }
    }
  }
});

Deno.test("checklist-columns: isChecklistCompleteByColumns mirrors dashboard.html isChecklistComplete", () => {
  assertEquals(isChecklistCompleteByColumns({ funding_type: "cash", has_measurements: true, has_material_selection: true }), true);
  assertEquals(isChecklistCompleteByColumns({ funding_type: "cash", has_estimate: true, has_material_selection: true }), false);
  assertEquals(isChecklistCompleteByColumns({ funding_type: "insurance", has_estimate: true, has_material_selection: true }), true);
  assertEquals(isChecklistCompleteByColumns({ funding_type: null, has_estimate: false, has_material_selection: true }), false);
});

// gh-3578 (D-407): ACV + purchased measurement, no estimate, is complete.
Deno.test("checklist-columns: ACV claim accepts a measurement in place of the estimate (gh-3578)", () => {
  const acv = { funding_type: "insurance", policy_type: "acv", has_estimate: false, has_measurements: true, has_material_selection: true };
  assertEquals(isChecklistCompleteByColumns(acv), true);
  assertEquals(resolveChecklistCompletedAt({ ...acv, status: "draft", updated_at: UPDATED }, undefined), UPDATED);
  assertEquals(isChecklistCompleteByColumns({ ...acv, has_material_selection: false }), false);
  assertEquals(isChecklistCompleteByColumns({ ...acv, policy_type: "rcv" }), false);
  assertEquals(isChecklistCompleteByColumns({ ...acv, policy_type: null }), false);
  assertEquals(isChecklistCompleteByColumns({ ...acv, has_measurements: false }), false);
});

Deno.test("checklist-columns: nudge and admin-tab derivations agree for ACV claims (gh-3578)", () => {
  for (const policy_type of ["acv", "rcv", "idk", null]) {
    for (const funding_type of ["cash", "insurance"]) {
      for (const has_estimate of [true, false]) {
        for (const has_measurements of [true, false]) {
          for (const has_material_selection of [true, false]) {
            const c = {
              id: "c", user_id: "u", status: "draft", funding_type, policy_type, has_estimate, has_measurements, has_material_selection,
              created_at: "2026-08-01T00:00:00Z", updated_at: UPDATED, trades: null, job_type: null,
              is_test: false, homeowner_name: null,
            };
            assertEquals(resolveChecklistCompletedAt(c, undefined) ?? null, resolveChecklistCompleteAt(c, undefined), JSON.stringify(c));
          }
        }
      }
    }
  }
});
