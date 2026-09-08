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
