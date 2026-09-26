// gh-2107 / D-330 -- the CAPI Purchase honours the hashed-email suppression list. Ben's DECIDED ruling c. on #2078 (5805593465)
// and his R-177 SIGNED on the table's PR (5806201431), which owes "the CAPI suppression check, placed after hashing and before
// building the send, and failing closed. It must reuse #2107's hash function." REVIEW 5806174399 N2 adds: look up whichever
// address is being hashed (profiles.email OR the auth.admin fallback), skip if the lookup errors with a fixed reason and no
// hash in the log, and structural tests that fail when the lookup is removed.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { shouldSkipForSuppression } from "./meta-capi.ts";

// -- the decision -----------------------------------------------------------------------------
Deno.test("suppression: a digest that IS on the list is skipped, reason suppressed", () => {
  assertEquals(shouldSkipForSuppression(true, false), { skip: true, reason: "suppressed" });
});

Deno.test("suppression: a digest that is NOT on the list is not skipped", () => {
  assertEquals(shouldSkipForSuppression(false, false), { skip: false, reason: null });
});

Deno.test("suppression: a FAILED lookup (including the table missing) skips, fail closed, reason suppression_lookup_failed", () => {
  assertEquals(shouldSkipForSuppression(false, true), { skip: true, reason: "suppression_lookup_failed" });
  // a failed lookup wins even if a stale row came back
  assertEquals(shouldSkipForSuppression(true, true), { skip: true, reason: "suppression_lookup_failed" });
});

// -- structure: wired into the handler, after hashing, before anything is built or sent ----------
const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const start = index.indexOf("async function handleMeasurementOrderCapiPurchase(");
const end = index.indexOf("// Entry point", start);
const handler = index.slice(start, end);

Deno.test("index.ts: the handler queries ad_sharing_suppressions and calls shouldSkipForSuppression exactly once", () => {
  assert(start > 0 && end > start);
  assertEquals(handler.split('.from("ad_sharing_suppressions")').length - 1, 1);
  assertEquals(handler.split("shouldSkipForSuppression(").length - 1, 1);
  assert(/\.eq\("email_sha256",\s*hashedEmail\)/.test(handler), "looks up the SAME digest that is about to be sent as user_data.em");
});

Deno.test("index.ts: the suppression check comes AFTER the email is hashed (either source) and BEFORE the payload is built and anything is sent", () => {
  const hashAt = handler.indexOf("hashedEmail = await hashEmailSha256(rawEmail)");
  const authFallbackAt = handler.indexOf("auth.admin.getUserById");
  const lookupAt = handler.indexOf('.from("ad_sharing_suppressions")');
  const payloadAt = handler.indexOf("buildCapiPurchasePayload(");
  const fetchAt = handler.indexOf("graph.facebook.com");
  assert(hashAt > 0 && authFallbackAt > 0 && authFallbackAt < hashAt, "the digest is computed after BOTH email sources (profiles and the auth.admin fallback)");
  assert(lookupAt > hashAt, "lookup after hashing");
  assert(payloadAt > lookupAt && fetchAt > lookupAt, "lookup before the payload is built and before the Meta call");
});

Deno.test("index.ts: it reuses the CAPI send's own hashEmailSha256 (no second hash implementation in the handler)", () => {
  assert(handler.includes("hashEmailSha256(rawEmail)"));
  assert(!handler.includes("crypto.subtle"), "no second hash implementation");
});

Deno.test("index.ts: the lookup error is passed to the decision (fail closed), and a match returns early", () => {
  const callAt = handler.indexOf("shouldSkipForSuppression(");
  const call = handler.slice(callAt, handler.indexOf(");", callAt) + 2);
  assert(/!!suppErr/.test(call), "the call passes !!suppErr, not a constant: " + call);
  assert(/const \{ data: suppressedRow, error: suppErr \}/.test(handler), "the select destructures its error");
  const after = handler.slice(callAt, callAt + 700);
  const branch = after.slice(0, after.indexOf("return;") + 7);
  assert(/if \(suppression\.skip\)/.test(branch) && branch.includes("return;"), "returns when skipping");
});

Deno.test("index.ts: the suppression skip log names the PaymentIntent id and a fixed reason only: no digest, no email, no database text", () => {
  const callAt = handler.indexOf("shouldSkipForSuppression(");
  const after = handler.slice(callAt, callAt + 700);
  const branch = after.slice(0, after.indexOf("return;") + 7);
  const logStmt = branch.slice(branch.indexOf("console.log("), branch.indexOf("return;"));
  assert(logStmt.includes("paymentIntent.id") && logStmt.includes("suppression.reason"), logStmt);
  assert(!/hashedEmail|rawEmail|suppErr|suppressedRow|\.message/.test(logStmt), "no digest, email or error text in the log: " + logStmt);
});

Deno.test("index.ts: with no resolvable email there is nothing to look up (the event carries no user_data), and the lookup is inside the has-a-digest branch", () => {
  const lookupAt = handler.indexOf('.from("ad_sharing_suppressions")');
  const before = handler.slice(Math.max(0, lookupAt - 400), lookupAt);
  assert(/if \(hashedEmail\)/.test(before), "guarded by if (hashedEmail)");
});

Deno.test("index.ts: imports shouldSkipForSuppression once, with the other meta-capi imports (no duplicated import block: TS2300)", () => {
  assertEquals(index.split('from "./meta-capi.ts"').length - 1, 1);
  const importBlock = index.slice(index.lastIndexOf("import {", index.indexOf('from "./meta-capi.ts"')), index.indexOf('from "./meta-capi.ts"'));
  assertEquals(importBlock.split("shouldSkipForSuppression").length - 1, 1);
});
