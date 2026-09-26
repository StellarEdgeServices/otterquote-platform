// gh-2107 / D-330 half 2 -- the CAPI Purchase honours a stored advertising-sharing opt-out.
// Dustin's ruling "b." (#2078 comment 5801822166): "The CAPI Purchase send skips any opted-out person, with a test for that
// case." Also pins the TS2300 fix: PR #2107 committed its import block and header comment TWICE, which does not compile,
// while every check stayed green (CI never type-checks this file), so a structural test now guards it.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { shouldSkipForAdSharingOptOut, shouldSkipForGpcMetadata } from "./meta-capi.ts";

// -- the decision -------------------------------------------------------------
Deno.test("opt-out: a profile with ad_sharing_opt_out === true is skipped, reason opted_out", () => {
  assertEquals(shouldSkipForAdSharingOptOut({ ad_sharing_opt_out: true }, false), { skip: true, reason: "opted_out" });
});

Deno.test("opt-out: NULL (never recorded) and false are NOT skipped -- only an explicit TRUE opts out", () => {
  for (const v of [null, undefined, false]) {
    assertEquals(shouldSkipForAdSharingOptOut({ ad_sharing_opt_out: v }, false), { skip: false, reason: null }, String(v));
  }
});

Deno.test("opt-out: anything that is not the boolean true is not an opt-out (a string or number never opts a person out by accident)", () => {
  for (const v of ["true", 1, "1", {}, []]) {
    assertEquals(shouldSkipForAdSharingOptOut({ ad_sharing_opt_out: v as unknown as boolean }, false).skip, false, JSON.stringify(v));
  }
});

Deno.test("opt-out: if the profile lookup FAILED the answer is unknown, so the send is skipped (fail closed), reason lookup_failed", () => {
  assertEquals(shouldSkipForAdSharingOptOut(null, true), { skip: true, reason: "lookup_failed" });
  // a failed lookup wins even when a stale row came back
  assertEquals(shouldSkipForAdSharingOptOut({ ad_sharing_opt_out: false }, true), { skip: true, reason: "lookup_failed" });
});

Deno.test("opt-out: no profile row and no error (nobody to have opted out) is not skipped", () => {
  assertEquals(shouldSkipForAdSharingOptOut(null, false), { skip: false, reason: null });
});

// -- structure: it is wired into the handler BEFORE anything personal is touched --
const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const handlerStart = index.indexOf("async function handleMeasurementOrderCapiPurchase(");
const handlerEnd = index.indexOf("// Entry point", handlerStart);
const handler = index.slice(handlerStart, handlerEnd);

Deno.test("index.ts: the handler exists and was located", () => {
  assert(handlerStart > 0 && handlerEnd > handlerStart);
});

Deno.test("index.ts: the handler reads profiles.ad_sharing_opt_out and calls shouldSkipForAdSharingOptOut exactly once", () => {
  assert(/select\("[^"]*ad_sharing_opt_out[^"]*"\)/.test(handler), "the profile select includes ad_sharing_opt_out");
  assertEquals(handler.split("shouldSkipForAdSharingOptOut(").length - 1, 1);
});

Deno.test("index.ts: the opt-out check comes BEFORE the email is hashed and BEFORE anything is sent to Meta", () => {
  const skipAt = handler.indexOf("shouldSkipForAdSharingOptOut(");
  const hashAt = handler.indexOf("hashEmailSha256(");
  const fetchAt = handler.indexOf("graph.facebook.com");
  assert(skipAt > 0 && hashAt > skipAt, "skip decision before hashing the email");
  assert(fetchAt > skipAt, "skip decision before the outbound Meta call");
});

Deno.test("index.ts: an opted-out person returns early (no payload, no send) and the log line carries no email and no raw database text", () => {
  const skipAt = handler.indexOf("shouldSkipForAdSharingOptOut(");
  const after = handler.slice(skipAt, skipAt + 900);
  const branch = after.slice(0, after.indexOf("return;") + 7);
  assert(/if \(optOut\.skip\)/.test(branch) && branch.includes("return;"), "returns when skipping");
  const logStart = branch.indexOf("console.log(");
  assert(logStart > 0, "the skip branch logs");
  const logStmt = branch.slice(logStart, branch.indexOf("return;"));
  assert(!/email|\.message|profileErr|profile/i.test(logStmt), "the skip log carries no email, no profile and no error text: " + logStmt);
  assert(logStmt.includes("paymentIntent.id") && logStmt.includes("optOut.reason"), "it names the PaymentIntent id and the fixed reason only");
});

Deno.test("index.ts: a FAILED profile read is passed to the decision as lookupFailed (the fail-closed input is wired, not defaulted)", () => {
  const skipAt = handler.indexOf("shouldSkipForAdSharingOptOut(");
  const call = handler.slice(skipAt, handler.indexOf(");", skipAt) + 2);
  assert(/!!profileErr/.test(call), "the call passes !!profileErr: " + call);
  assert(/const \{ data: profile, error: profileErr \}/.test(handler), "the select destructures its error");
});

// -- the TS2300 fix: nothing declared twice --------------------------------------
Deno.test("index.ts: imports from ./meta-capi.ts ONCE (a duplicated import block is a compile error: TS2300 x8)", () => {
  assertEquals(index.split('from "./meta-capi.ts"').length - 1, 1);
});

Deno.test("index.ts: every meta-capi import specifier and the CAPI header comment appear once", () => {
  const importBlock = index.slice(index.lastIndexOf("import {", index.indexOf('from "./meta-capi.ts"')), index.indexOf('from "./meta-capi.ts"'));
  for (const name of ["buildCapiEventId", "buildCapiPurchasePayload", "hashEmailSha256", "MEASUREMENT_ORDER_PI_TYPES", "MEASUREMENT_PURCHASE_VALUE_USD", "sanitizeCapiVariant", "shouldSendCapiEvent", "shouldSkipForAdSharingOptOut"]) {
    assertEquals(importBlock.split(name).length - 1, 1, `${name} imported exactly once`);
  }
  assertEquals(index.split("gh-2078b / D-330: server-side Meta Conversions API (CAPI) `Purchase` event,").length - 1, 1, "header comment not duplicated");
});

// -- REVIEW: FAIL 5806828503 F2 on #2134: the GPC signal also rides on the PaymentIntent -----------------------------------------
Deno.test("F2: a PaymentIntent whose metadata carries ad_sharing_opt_out=1 is skipped, reason gpc_signal, even when the profile flag was never written", () => {
  assertEquals(shouldSkipForGpcMetadata({ ad_sharing_opt_out: "1", type: "hover_measurement" }), { skip: true, reason: "gpc_signal" });
});

Deno.test("F2: absent metadata, a missing key, or any other value is NOT a signal (only the exact string 1)", () => {
  for (const m of [undefined, null, {}, { type: "hover_measurement" }, { ad_sharing_opt_out: "0" }, { ad_sharing_opt_out: "true" }, { ad_sharing_opt_out: "" }, { ad_sharing_opt_out: "11" }]) {
    assertEquals(shouldSkipForGpcMetadata(m as Record<string, string> | undefined), { skip: false, reason: null }, JSON.stringify(m));
  }
});

Deno.test("F2: the webhook checks the PaymentIntent's own signal FIRST (before any lookup, the profile read, the hash or a send), with a fixed log", () => {
  const gpcAt = handler.indexOf("shouldSkipForGpcMetadata(");
  assert(gpcAt > 0, "the handler calls shouldSkipForGpcMetadata");
  assertEquals(handler.split("shouldSkipForGpcMetadata(").length - 1, 1);
  for (const later of ['.from("claims")', '.from("profiles")', "hashEmailSha256(", "graph.facebook.com"]) {
    assert(handler.indexOf(later) > gpcAt, `${later} comes after the metadata signal check`);
  }
  const after = handler.slice(gpcAt, gpcAt + 600);
  const branch = after.slice(0, after.indexOf("return;") + 7);
  assert(/if \(gpcMeta\.skip\)/.test(branch) && branch.includes("return;"), "returns when skipping");
  const logStmt = branch.slice(branch.indexOf("console.log("), branch.indexOf("return;"));
  assert(logStmt.includes("paymentIntent.id") && logStmt.includes("gpcMeta.reason") && !/email|metadata|\.message/i.test(logStmt), logStmt);
});
