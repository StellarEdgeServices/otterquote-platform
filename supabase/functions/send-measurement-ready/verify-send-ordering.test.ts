// gh-1538 — source-ORDER assertions on the X-Verify-Send bypass.
//
// Why this test exists rather than only unit tests on the predicate: an
// authorization bug in a bypass like this is not a wrong value, it is a wrong
// POSITION. If `verifySend` were computed and applied above the admin gate,
// every unit test in loud-failure.test.ts would still pass while any caller
// could force a real send against test data. gh-1467 cost this codebase a
// deployed, 9/9-passing, byte-verified money gate that was simply unreachable
// because a throw sat 34 lines above it — the bytes were correct and the order
// was not. So the order is asserted directly against the shipped source, the
// same technique as docusign-webhook/gate-ordering.test.ts.
//
// These assertions FAIL on main (main has no verifySend at all, and its
// is_test skip is unguarded), which is what makes their passing mean
// something.
//
// Run: deno test --allow-read supabase/functions/send-measurement-ready/verify-send-ordering.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";

const SRC = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);
const LINES = SRC.split("\n");

/** 1-based line number of the first line containing `needle`, or -1. */
function lineOf(needle: string): number {
  const i = LINES.findIndex((l) => l.includes(needle));
  return i === -1 ? -1 : i + 1;
}

Deno.test("gh-1538: the admin 403 is returned BEFORE verifySend is ever computed", () => {
  const forbidden = lineOf('Forbidden: admin role required');
  const verifySend = lineOf("const verifySend = isVerifySendRequested(req.headers)");
  assert(forbidden > 0, "the admin gate's 403 must exist in this function");
  assert(verifySend > 0, "verifySend must be computed in this function");
  assert(
    forbidden < verifySend,
    `the admin 403 (line ${forbidden}) must precede the verifySend computation ` +
      `(line ${verifySend}) — otherwise the header would be evaluated for callers ` +
      `who are not admins`,
  );
});

Deno.test("gh-1538: the caller's own JWT is resolved BEFORE verifySend is computed", () => {
  const getUser = lineOf("await userClient.auth.getUser()");
  const verifySend = lineOf("const verifySend = isVerifySendRequested(req.headers)");
  assert(getUser > 0 && verifySend > 0);
  assert(
    getUser < verifySend,
    `auth.getUser() (line ${getUser}) must precede verifySend (line ${verifySend})`,
  );
});

Deno.test("gh-1538: the is_test send skip is guarded by !verifySend", () => {
  const guarded = LINES.find((l) =>
    l.includes("isTestClaim || isTestAccount(homeownerEmail)") && l.includes("!verifySend")
  );
  assert(
    guarded !== undefined,
    "the is_test skip must read `(isTestClaim || isTestAccount(homeownerEmail)) && !verifySend`; " +
      "found: " + JSON.stringify(LINES.find((l) => l.includes("isTestClaim || isTestAccount"))),
  );
});

Deno.test("gh-1538: verifySend is computed exactly once, from the request headers only", () => {
  const assignments = LINES.filter((l) => /\bconst\s+verifySend\s*=/.test(l));
  assertEquals(
    assignments.length,
    1,
    "verifySend must have exactly one definition, so there is one place to audit",
  );
  assert(
    assignments[0].includes("isVerifySendRequested(req.headers)"),
    "verifySend must come from the request headers via isVerifySendRequested, " +
      "not from a body field, query param or env var",
  );
});

Deno.test("gh-1538: no env var or request body field can switch the bypass on", () => {
  // The bypass must be reachable only through the header. Anything that reads
  // a VERIFY_SEND-ish env var or body key would be a second, unaudited door.
  assert(
    !/Deno\.env\.get\(\s*["'][A-Z_]*VERIFY_SEND/.test(SRC),
    "no env var may enable the verify-send bypass",
  );
  assert(
    !/body\?\.\s*verify_send/.test(SRC),
    "no request-body field may enable the verify-send bypass",
  );
});

Deno.test("gh-1538: the bypass does not touch the order-status or idempotency guards", () => {
  // Both guards must remain unconditional — the header widens is_test only.
  const statusGuard = LINES.find((l) => l.includes('order.status !== "completed"'));
  assert(statusGuard !== undefined, "the order-status guard must still exist");
  assert(
    !statusGuard.includes("verifySend"),
    "the order-status guard must not consult verifySend",
  );
  const idem = LINES.findIndex((l) => l.includes("already_notified"));
  assert(idem > 0, "the idempotency guard must still exist");
  const idemBlock = LINES.slice(Math.max(0, idem - 12), idem + 1).join("\n");
  assert(
    !idemBlock.includes("verifySend"),
    "the idempotency guard must not consult verifySend",
  );
});

Deno.test("gh-1538: a verify-send call is recorded in the failure metadata", () => {
  assert(
    SRC.includes("verify_send: verifySend"),
    "the activity_log metadata must carry verify_send so a verification-triggered " +
      "send is never mistaken for organic traffic",
  );
});

Deno.test("gh-1538: the notification failure writes platform_alerts_log, not activity_log alone", () => {
  assert(
    SRC.includes('from("platform_alerts_log").insert(alert)'),
    "the catch must write the operator-visible alert surface",
  );
  assert(
    SRC.includes("logNotificationFailureLoud("),
    "the catch must use the two-surface writer",
  );
});
