// gh-3635 (P23): parity between the database function public.get_guarantee_covered(uuid) and the TypeScript coverage rules in guarantee-coverage.ts
// (parseExcludedStates + normalizePropertyState), the rules create-measurement-order applies when it records hover_orders.guarantee_covered. For every
// (stored list value x claims.property_state) pair below, the TS rules must return exactly what the SQL function returned.
//
// How the expected values were obtained: the migration supabase/migrations_drafts/gh3635_get_guarantee_covered.sql was executed in a throwaway
// PGlite (WASM Postgres) with stub auth.uid(), claims(id,user_id,property_state) and platform_settings(key,value) tables; for each pair the claim belonged to the
// caller and the function was called. NOT applied anywhere. SQL NULL = null, and "no row" is the list value undefined. Re-run that harness whenever the function changes.
// Access rules (not parity): NULL for another user's claim, no auth.uid(), unknown claim or NULL claim id; EXECUTE for authenticated only (also proved in that run).
// Run: deno test supabase/functions/create-measurement-order/guarantee-covered-sql-parity.test.ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { normalizePropertyState, parseExcludedStates } from "./guarantee-coverage.ts";

/** The TS rules, composed from the real exports: list first (no fallback list), then the claim's state; covered = not on the list. */
function tsCovered(listValue: unknown, propertyState: unknown): boolean | null {
  const list = parseExcludedStates(listValue === undefined ? null : { value: listValue });
  if (list.kind !== "configured") return null;
  const state = normalizePropertyState(propertyState);
  return state ? !list.states.includes(state) : null;
}

const STATES: (string | null)[] = ["IN","in"," IN ","\tIN\n"," IN","IN﻿","　IN","FL","fl"," Fl","KY","MI","TX","Indiana","","  ","I","INN","I N","1N","ＩＮ",null];

// [label, stored list value (undefined = no row), expected SQL result for each entry of STATES, in order]
const CASES: [string, unknown, (boolean | null)[]][] = [
  ["no row", undefined, [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null]],
  ["json null", null, [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null]],
  ["string \"FL\"", "FL", [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null]],
  ["object", {"a":1}, [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null]],
  ["empty []", [], [true,true,true,true,true,true,true,true,true,true,true,true,true,null,null,null,null,null,null,null,null,null]],
  ["launch 9", ["FL","LA","TX","OK","AR","KS","NE","MI","KY"], [true,true,true,true,true,true,true,false,false,false,false,false,false,null,null,null,null,null,null,null,null,null]],
  ["number elem", ["FL",5], [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null]],
  ["bad elem Texas", ["FL","Texas"], [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null]],
  ["null elem", ["FL",null], [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null]],
  ["padded lower", [" fl ","la"], [true,true,true,true,true,true,true,false,false,false,true,true,true,null,null,null,null,null,null,null,null,null]],
  ["dups", ["FL","fl","TX"], [true,true,true,true,true,true,true,false,false,false,true,true,false,null,null,null,null,null,null,null,null,null]],
  ["tab elem", ["\tFL"], [null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null]],
  ["single IN", ["IN"], [false,false,false,false,false,false,false,true,true,true,true,true,true,null,null,null,null,null,null,null,null,null]],
];

for (const [label, list, expected] of CASES) {
  Deno.test(`get_guarantee_covered SQL parity: list ${label}`, () => {
    assertEquals(expected.length, STATES.length);
    STATES.forEach((state, i) => {
      assertEquals(tsCovered(list, state), expected[i], `list ${label}, state ${JSON.stringify(state)}`);
    });
  });
}

Deno.test("get_guarantee_covered SQL parity: the launch list (FL, LA, TX, OK, AR, KS, NE, MI, KY) covers IN and excludes FL", () => {
  const launch = ["FL", "LA", "TX", "OK", "AR", "KS", "NE", "MI", "KY"];
  assertEquals(tsCovered(launch, "IN"), true);
  assertEquals(tsCovered(launch, "FL"), false);
  assertEquals(tsCovered(undefined, "IN"), null, "no list = unknown, never covered");
});
