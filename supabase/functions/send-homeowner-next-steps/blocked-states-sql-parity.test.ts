// gh-2492 (CTO ruling 5969703832): parseBlockedStates() in BOTH colocated TS copies
// must return exactly what the database function public.get_homeowner_blocked_states()
// returns for the same stored jsonb value, for every input.
//
// How the expected values were obtained: the function takes no argument (it reads
// platform_settings.homeowner_blocked_states), so each `sql` column below was produced on
// PRODUCTION (read-only SELECT, project yeszghaspzwwstvsrioa, 2026-10-03) by running the
// function's own body logic (pg_get_functiondef text: jsonb_typeof / jsonb_array_length /
// the EXISTS "any element not a string of two letters after upper(btrim())" test /
// array_agg(DISTINCT upper(btrim(e)) ORDER BY ...)) over each literal jsonb value. Rules:
//   - not a JSON array, or SQL NULL (missing row / JSON null)  -> default FL,LA,TX
//   - empty array                                              -> {} (nothing blocked)
//   - ANY element that is not a string matching ^[A-Z]{2}$ after btrim (spaces only) and
//     upper()                                                  -> the WHOLE value is
//     rejected, default FL,LA,TX (fail closed)
//   - otherwise: the distinct upper-cased codes, sorted.
// Run: deno test supabase/functions/send-homeowner-next-steps/blocked-states-sql-parity.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import * as local from "./blocked-states.ts";
import * as canonical from "../notify-admin-new-homeowner/notify-helpers.ts";

const D = ["FL", "LA", "TX"];

// [label, input (as JSON.parse of the jsonb value would give it), SQL output]
const CASES: [string, unknown, string[]][] = [
  ["valid list", ["FL", "LA", "TX"], D],
  ["lower-case codes", ["fl", "la", "tx"], D],
  ["unsorted lower-case", ["tx", "fl", "la"], D],
  ["padded with spaces (valid + padded)", ["IN", " la "], ["IN", "LA"]],
  ["full state name among codes", ["FL", "LA", "Texas"], D],
  ["unknown but well-formed code", ["FL", "LA", "ZZ"], ["FL", "LA", "ZZ"]],
  ["blank string entry", ["FL", "LA", "TX", ""], D],
  ["only a space", [" "], D],
  ["only space+tab", [" \t "], D],
  ["empty array", [], []],
  ["JSON null", null, D],
  ["missing row (undefined)", undefined, D],
  ["string", "FL", D],
  ["object", { a: 1 }, D],
  ["number", 7, D],
  ["boolean", true, D],
  ["duplicates", ["TX", "FL", "FL", "tx", "LA"], D],
  ["valid code plus lower-case duplicate", ["IN", "tx"], ["IN", "TX"]],
  ["3-letter code", ["FLA", "LA", "TX"], D],
  ["1-letter code", ["F"], D],
  ["digit in code", ["F1", "LA"], D],
  ["internal space", ["F L"], D],
  ["number element", ["FL", 1], D],
  ["null element", ["FL", null], D],
  ["nested array element", [["FL"]], D],
  // btrim() with no second argument strips SPACES only; JS trim() also strips these.
  ["tab padding is NOT trimmed", ["IN", "la\t"], D],
  ["newline padding is NOT trimmed", ["IN", "la\n"], D],
  ["carriage return padding is NOT trimmed", ["IN", "la\r"], D],
  ["vertical tab padding is NOT trimmed", ["IN", "\u000bla"], D],
  ["no-break space is NOT trimmed", ["IN", "la "], D],
  ["em space is NOT trimmed", ["IN", " la"], D],
  // upper() is a full Unicode case map in production (en_US.UTF-8): ß -> SS, ﬁ -> FI.
  ["sharp s upper-cases to SS", ["IN", "ß"], ["IN", "SS"]],
  ["fi ligature upper-cases to FI", ["IN", "ﬁ"], ["FI", "IN"]],
  ["dotless i upper-cases to one letter", ["IN", "ı"], D],
  ["long s upper-cases to one letter", ["IN", "ſ"], D],
  ["full-width letters", ["ＦＬ"], D],
  ["accented letter", ["é", "LA"], D],
];

for (const [label, input, sql] of CASES) {
  Deno.test(`blocked-states SQL parity: ${label}: ${JSON.stringify(input) ?? "undefined"}`, () => {
    assertEquals(local.parseBlockedStates(input), sql, "send-homeowner-next-steps copy");
    assertEquals(canonical.parseBlockedStates(input), sql, "notify-admin-new-homeowner copy");
  });
}

Deno.test("blocked-states SQL parity: the default is never aliased (callers cannot mutate it)", () => {
  const a = local.parseBlockedStates("FL");
  a.push("ZZ");
  assertEquals(local.parseBlockedStates("FL"), D);
  const b = canonical.parseBlockedStates("FL");
  b.push("ZZ");
  assertEquals(canonical.parseBlockedStates("FL"), D);
});
