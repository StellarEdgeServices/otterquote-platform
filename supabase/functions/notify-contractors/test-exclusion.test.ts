// Deno unit tests for the #543 test-contractor matching exclusion.
// Run: deno test supabase/functions/notify-contractors/test-exclusion.test.ts

import {
  assertEquals,
} from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { isExcludedTestContractor, selectFanOutContractors } from "./test-exclusion.ts";

Deno.test("real contractor is kept", () => {
  assertEquals(
    isExcludedTestContractor({ is_test: false, email: "martinezsonsconstruction2000@gmail.com" }),
    false,
  );
});

Deno.test("is_test=true is excluded regardless of email", () => {
  assertEquals(isExcludedTestContractor({ is_test: true, email: "real-looking@gmail.com" }), true);
});

Deno.test("@otterquote-internal.test email is excluded even when is_test=false", () => {
  // Live-prod regression shape: E2E rows seeded before seed.mjs stamped is_test.
  assertEquals(
    isExcludedTestContractor({ is_test: false, email: "test-contractor@otterquote-internal.test" }),
    true,
  );
  assertEquals(
    isExcludedTestContractor({ is_test: false, email: "test-contractor-d210@otterquote-internal.test" }),
    true,
  );
});

Deno.test("email check is case-insensitive and trims whitespace", () => {
  assertEquals(isExcludedTestContractor({ email: "Foo@OtterQuote-Internal.TEST" }), true);
  assertEquals(isExcludedTestContractor({ email: " foo@otterquote-internal.test " }), true);
});

Deno.test("similar-but-different domains are kept", () => {
  assertEquals(isExcludedTestContractor({ is_test: false, email: "a@otterquote-internal.test.com" }), false);
  assertEquals(isExcludedTestContractor({ is_test: false, email: "a@otterquote.com" }), false);
});

Deno.test("null/missing fields are kept (fail-open for real rows)", () => {
  assertEquals(isExcludedTestContractor({}), false);
  assertEquals(isExcludedTestContractor({ is_test: null, email: null }), false);
});

// ─── #564 symmetric fan-out selection ────────────────────────────────────────
// Regression spec, notification direction (CEO decision comment 2026-07-13):
// test claims → test contractors only; real claims → non-test contractors
// only (v69 behavior preserved).

const REAL = { is_test: false, email: "martinezsonsconstruction2000@gmail.com" };
const FLAGGED = { is_test: true, email: "pfw-walk-roofing@otterquote-internal.test" };
const FLAGGED_REAL_EMAIL = { is_test: true, email: "real-looking@gmail.com" };
const INTERNAL_UNFLAGGED = { is_test: false, email: "test-contractor@otterquote-internal.test" };
const POOL = [REAL, FLAGGED, FLAGGED_REAL_EMAIL, INTERNAL_UNFLAGGED];

Deno.test("#564: real claim keeps the v69 selection — only real contractors", () => {
  assertEquals(selectFanOutContractors(POOL, false), [REAL]);
});

Deno.test("#564: test claim selects is_test=true contractors only", () => {
  assertEquals(selectFanOutContractors(POOL, true), [FLAGGED, FLAGGED_REAL_EMAIL]);
});

Deno.test("#564: test claim does NOT select internal-email rows without the flag (v96 RLS parity — they can't see the claim)", () => {
  assertEquals(selectFanOutContractors([INTERNAL_UNFLAGGED], true), []);
});

Deno.test("#564: real contractor never receives a test claim; test contractor never receives a real claim", () => {
  assertEquals(selectFanOutContractors([REAL], true), []);
  assertEquals(selectFanOutContractors([FLAGGED], false), []);
});

Deno.test("#564: empty pool is safe in both directions", () => {
  assertEquals(selectFanOutContractors([], true), []);
  assertEquals(selectFanOutContractors([], false), []);
});
