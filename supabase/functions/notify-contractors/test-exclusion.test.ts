// Deno unit tests for the #543 test-contractor matching exclusion.
// Run: deno test supabase/functions/notify-contractors/test-exclusion.test.ts

import {
  assertEquals,
} from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { isExcludedTestContractor } from "./test-exclusion.ts";

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
