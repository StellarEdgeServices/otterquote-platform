// gh-2107 / D-330 half 2 -- REVIEW: FAIL 5805561942 and LEGAL-READ: FAIL 5805566240 on head b46e44b9.
//   B1  the Meta access token was in the request URL, so a network-level fetch failure wrote it, in plain text, to the
//       function logs through the catch's raw `err` (Deno puts the URL in the error's cause).
//   B2  the opt-out check did not fail closed on the CLAIM lookup: when it errored, or the PaymentIntent carried no
//       claim_id, userId stayed null, the whole opt-out block was skipped, and a Purchase was sent anyway.
// Plus the reviewer's cheap non-blocking items: the value comes from the charge, and no raw error text is logged.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { capiPurchaseValueUsd, decideCapiPerson, safeMetaErrorSummary } from "./meta-capi.ts";

// -- B2: the person must be resolvable, or nothing is sent -----------------------------
Deno.test("decideCapiPerson: a resolved claim with a user is not skipped", () => {
  assertEquals(decideCapiPerson({ claimId: "c1", claimLookupFailed: false, userId: "u1" }), { skip: false, reason: null });
});

Deno.test("decideCapiPerson: a FAILED claim lookup skips (fail closed), reason claim_lookup_failed", () => {
  assertEquals(decideCapiPerson({ claimId: "c1", claimLookupFailed: true, userId: null }), { skip: true, reason: "claim_lookup_failed" });
  // a failed lookup wins even if a stale user id is somehow present
  assertEquals(decideCapiPerson({ claimId: "c1", claimLookupFailed: true, userId: "u1" }), { skip: true, reason: "claim_lookup_failed" });
});

Deno.test("decideCapiPerson: a PaymentIntent with NO claim_id skips, reason no_claim_id", () => {
  for (const id of [null, "", undefined]) {
    assertEquals(decideCapiPerson({ claimId: id as string | null, claimLookupFailed: false, userId: null }), { skip: true, reason: "no_claim_id" }, String(id));
  }
});

Deno.test("decideCapiPerson: a claim with no user_id (or a claim that was not found) skips, reason no_user_id", () => {
  for (const u of [null, "", undefined]) {
    assertEquals(decideCapiPerson({ claimId: "c1", claimLookupFailed: false, userId: u as string | null }), { skip: true, reason: "no_user_id" }, String(u));
  }
});

// -- the value comes from the charge, not a constant -------------------------------------
Deno.test("capiPurchaseValueUsd: the charged amount in cents becomes dollars; anything unusable falls back", () => {
  assertEquals(capiPurchaseValueUsd(1500, 15), 15);
  assertEquals(capiPurchaseValueUsd(1900, 15), 19);
  assertEquals(capiPurchaseValueUsd(1550, 15), 15.5);
  for (const bad of [0, -5, NaN, Infinity, "1500", null, undefined, 12.5, {}]) assertEquals(capiPurchaseValueUsd(bad, 15), 15, String(bad));
});

// -- Meta's error body never goes into a log or an alert row as raw text --------------------
Deno.test("safeMetaErrorSummary: keeps only a numeric code and a short type token, never the message", () => {
  const body = JSON.stringify({ error: { message: "Invalid parameter for user secret.person@example.com", type: "OAuthException", code: 190, error_subcode: 463, fbtrace_id: "A1b2C3" } });
  const s = safeMetaErrorSummary(body);
  assertEquals(s, "code=190 type=OAuthException");
  assert(!s.includes("secret.person") && !s.includes("Invalid parameter"));
});

Deno.test("safeMetaErrorSummary: unparseable, empty or hostile bodies give a fixed string", () => {
  for (const b of ["", "not json", "<html>500</html>", JSON.stringify({}), JSON.stringify({ error: "plain string with secret" }), JSON.stringify({ error: { message: "x secret" } })]) {
    const s = safeMetaErrorSummary(b);
    assert(!s.includes("secret") && !s.includes("html"), s);
  }
  assertEquals(safeMetaErrorSummary("not json"), "unparsed");
  // a type that is not a short token is dropped
  assertEquals(safeMetaErrorSummary(JSON.stringify({ error: { code: 1, type: "has spaces and secret.person@example.com" } })), "code=1");
});

// -- structure -------------------------------------------------------------------------------
const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const start = index.indexOf("async function handleMeasurementOrderCapiPurchase(");
const end = index.indexOf("// Entry point", start);
const handler = index.slice(start, end);

Deno.test("B1: the Meta access token is NEVER in a URL (a fetch failure puts the URL in the error): no `access_token=` anywhere in index.ts", () => {
  assert(!index.includes("access_token="), "access_token= must not appear in index.ts");
  const at = handler.indexOf("graph.facebook.com");
  assert(at > 0);
  const urlLine = handler.slice(at, handler.indexOf("\n", at));
  assert(!/token/i.test(urlLine), "the URL line carries no token: " + urlLine);
});

Deno.test("B1: the token travels in the JSON body, and the catch logs the error NAME only, never the error object", () => {
  assert(/JSON\.stringify\(\{\s*\.\.\.payload,\s*access_token:\s*capiToken\s*\}\)/.test(handler), "body carries access_token");
  const catchAt = handler.lastIndexOf("} catch (err) {");
  const catchBlock = handler.slice(catchAt);
  assert(!/^\s*err,?\s*$/m.test(catchBlock), "the raw err is not passed to console.error");
  assert(/err instanceof Error \? err\.name/.test(catchBlock), "logs err.name only");
});

Deno.test("B2: the person check runs BEFORE the test-mode decision, the profile read, and any send", () => {
  const personAt = handler.indexOf("decideCapiPerson(");
  const testModeAt = handler.indexOf("shouldSendCapiEvent(");
  const profileAt = handler.indexOf('.from("profiles")');
  const fetchAt = handler.indexOf("graph.facebook.com");
  assert(personAt > 0 && testModeAt > personAt && profileAt > personAt && fetchAt > personAt);
  assertEquals(handler.split("decideCapiPerson(").length - 1, 1);
  const callAt = handler.indexOf("decideCapiPerson(");
  const call = handler.slice(callAt, handler.indexOf(");", callAt) + 2);
  assert(/claimLookupFailed\s*[,}]/.test(call) && !/claimLookupFailed\s*:\s*(false|true)/.test(call), "the claim-lookup failure is passed in as the variable, not a constant: " + call);
});

Deno.test("B2: the person-skip returns early and its log carries the PaymentIntent id and a fixed reason only", () => {
  const personAt = handler.indexOf("decideCapiPerson(");
  const after = handler.slice(personAt, personAt + 700);
  const branch = after.slice(0, after.indexOf("return;") + 7);
  assert(/if \(person\.skip\)/.test(branch) && branch.includes("return;"));
  const logStmt = branch.slice(branch.indexOf("console.log("), branch.indexOf("return;"));
  assert(logStmt.includes("paymentIntent.id") && logStmt.includes("person.reason"));
  assert(!/claimErr|\.message|email/i.test(logStmt), logStmt);
});

Deno.test("no raw database or Meta text is logged: claimErr is not passed to console.error, Meta's body is summarised", () => {
  assert(!/console\.error\([^)]*claimErr[^)]*\)/.test(handler.replace(/\n/g, " ")), "claimErr is not logged raw");
  assert(handler.includes("safeMetaErrorSummary(resBody)"), "Meta's error body is summarised");
  assert(!/\$\{resBody\}/.test(handler), "resBody is never interpolated raw");
});

Deno.test("the conversion value is the charged amount, with the constant only as a fallback", () => {
  assert(/valueUsd:\s*capiPurchaseValueUsd\(/.test(handler));
  assert(handler.includes("amount_received"));
});
