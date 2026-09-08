// gh-1570 / gh-1580 — tests for the dry-run fixture mode's two decisions.
// Each assertion is paired with the case that must behave the OTHER way, so a
// change that collapses the two modes into one fails here.
import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { candidateIsTestFlag, parseDryRun } from "./dry-run.ts";

Deno.test("parseDryRun: literal true only", () => {
  assertEquals(parseDryRun({ dry_run: true }), true);
  // Negative controls — every one of these is a NORMAL run. A coerced read
  // ("true", 1) would silently switch which population is scanned on a typo.
  assertEquals(parseDryRun({ dry_run: "true" }), false);
  assertEquals(parseDryRun({ dry_run: 1 }), false);
  assertEquals(parseDryRun({ dry_run: false }), false);
  assertEquals(parseDryRun({}), false);
  assertEquals(parseDryRun(null), false);
  assertEquals(parseDryRun(undefined), false);
  assertEquals(parseDryRun("dry_run"), false);
});

Deno.test("candidateIsTestFlag: the two populations are disjoint", () => {
  // dry run scans ONLY is_test = true
  assertEquals(candidateIsTestFlag(true), true);
  // normal run scans ONLY is_test = false — unchanged from the pre-gh-1570
  // behaviour, which is the property that keeps the cron's real-send
  // population exactly what D-320 ratified.
  assertEquals(candidateIsTestFlag(false), false);
});

Deno.test("a dry run can never widen to the real population", () => {
  // There is no input for which the scan covers both. Stated as an
  // exhaustive check over the flag's domain rather than as a comment.
  const flags = [true, false];
  const scanned = flags.map(candidateIsTestFlag);
  assertEquals(new Set(scanned).size, 2);
  assertEquals(scanned.includes(true) && scanned.includes(false), true);
});

// ─── gh-1859 review fix ──────────────────────────────────────────────────────
// Blocker 1 said the original three tests assert an identity function. These
// assert the two properties that are not identities: which population the
// scan filters on, and that a dry run cannot ride the batch gate's fail-open
// branch.
import { buildCandidateQuery, dryRunAuthorized } from "./dry-run.ts";

function recordingBuilder() {
  const calls: Array<[string, unknown[]]> = [];
  const b = {
    select(c: string) { calls.push(["select", [c]]); return b; },
    eq(c: string, v: unknown) { calls.push(["eq", [c, v]]); return b; },
    neq(c: string, v: unknown) { calls.push(["neq", [c, v]]); return b; },
    lte(c: string, v: unknown) { calls.push(["lte", [c, v]]); return b; },
    limit(n: number) { calls.push(["limit", [n]]); return b; },
  };
  return { b, calls };
}

function isTestFilter(calls: Array<[string, unknown[]]>) {
  return calls.filter((c) => c[0] === "eq" && c[1][0] === "is_test").map((c) => c[1][1]);
}

Deno.test("PROPERTY 1 — the scan is ALWAYS filtered on is_test, to the flag's value", () => {
  const opts = {
    eligibleStatus: "documents_needed",
    excludedStatus: "draft",
    cutoffIso: "2026-09-08T00:00:00.000Z",
    limit: 200,
  };
  const dry = recordingBuilder();
  buildCandidateQuery(dry.b, { ...opts, scanIsTest: candidateIsTestFlag(true) });
  assertEquals(isTestFilter(dry.calls), [true]);

  // NEGATIVE CONTROL: the production call, same builder, same assertion shape.
  const prod = recordingBuilder();
  buildCandidateQuery(prod.b, { ...opts, scanIsTest: candidateIsTestFlag(false) });
  assertEquals(isTestFilter(prod.calls), [false]);

  // Exactly one is_test filter in each — never zero (unfiltered = every
  // homeowner) and never two conflicting ones.
  assertEquals(isTestFilter(dry.calls).length, 1);
  assertEquals(isTestFilter(prod.calls).length, 1);
  // …and the rest of the predicate is still there.
  assertEquals(prod.calls.some((c) => c[0] === "eq" && c[1][0] === "status"), true);
  assertEquals(prod.calls.some((c) => c[0] === "eq" && c[1][0] === "has_measurements"), true);
  assertEquals(prod.calls.some((c) => c[0] === "lte" && c[1][0] === "created_at"), true);
});

Deno.test("dryRunAuthorized: fails CLOSED where the batch gate fails open", () => {
  // The refuted claim: `if (!cronSecret) { authorized = true; }`. With no
  // secret configured, a dry run is refused rather than granted to everyone.
  assertEquals(dryRunAuthorized({ cronSecret: null, incomingCronSecret: null, authHeader: null, serviceRoleKey: "srk" }), false);
  assertEquals(dryRunAuthorized({ cronSecret: "", incomingCronSecret: "", authHeader: "", serviceRoleKey: "srk" }), false);
  assertEquals(dryRunAuthorized({ cronSecret: undefined, incomingCronSecret: "anything", authHeader: null, serviceRoleKey: null }), false);
  // Positive controls: the two credentials that ARE proof.
  assertEquals(dryRunAuthorized({ cronSecret: "s3cret", incomingCronSecret: "s3cret", authHeader: null, serviceRoleKey: null }), true);
  assertEquals(dryRunAuthorized({ cronSecret: "s3cret", incomingCronSecret: null, authHeader: "Bearer srk", serviceRoleKey: "srk" }), true);
  // Near misses.
  assertEquals(dryRunAuthorized({ cronSecret: "s3cret", incomingCronSecret: "wrong", authHeader: null, serviceRoleKey: null }), false);
  assertEquals(dryRunAuthorized({ cronSecret: "s3cret", incomingCronSecret: null, authHeader: "Bearer wrong", serviceRoleKey: "srk" }), false);
  assertEquals(dryRunAuthorized({ cronSecret: "s3cret", incomingCronSecret: null, authHeader: "srk", serviceRoleKey: "srk" }), false);
});
