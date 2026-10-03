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
