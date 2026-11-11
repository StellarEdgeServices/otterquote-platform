// Deno unit tests for gh-3586's fee-acceptance gap rule.
// Run: deno test supabase/functions/platform-health-check/fee-acceptance-gap-check.test.ts
// FAIL-FIRST / NEGATIVE CONTROL: on origin/main the module does not exist, so this file fails to import.

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  evaluateFeeAcceptanceGap,
  FEE_GAP_ALERT_TYPE,
  findQuotesMissingAcceptance,
  type GapOptions,
  type QuoteRow,
} from "./fee-acceptance-gap-check.ts";

const NOW = new Date("2026-11-10T18:00:00Z");
const OPTS: GapOptions = { since: "2026-05-07T00:00:00Z", graceMinutes: 10, now: NOW };
const q = (id: string, over: Partial<QuoteRow> = {}): QuoteRow => ({
  id, claim_id: "c1", contractor_id: "k1", created_at: "2026-11-09T12:00:00Z", status: "pending", is_test: false, is_auto_bid: false, ...over,
});

Deno.test("clean fixture (every real quote has a row) is silent", () => {
  const r = findQuotesMissingAcceptance([q("a"), q("b")], ["a", "b"], OPTS);
  assertEquals(r.count, 0);
  assertEquals(evaluateFeeAcceptanceGap(r), null);
});

Deno.test("a real quote with no row fires, naming the quote", () => {
  const r = findQuotesMissingAcceptance([q("a"), q("b")], ["a"], OPTS);
  assertEquals(r.count, 1);
  const alert = evaluateFeeAcceptanceGap(r);
  assertEquals(alert?.alertType, FEE_GAP_ALERT_TYPE);
  assertEquals(alert?.message.includes("b ("), true);
});

Deno.test("planted is_test quote: invisible to the real alert, fires in the includeTest proof run", () => {
  const planted = q("planted", { is_test: true });
  assertEquals(findQuotesMissingAcceptance([planted], [], OPTS).count, 0);
  const proof = findQuotesMissingAcceptance([planted], [], { ...OPTS, includeTest: true });
  assertEquals(proof.count, 1);
  assertEquals(evaluateFeeAcceptanceGap(proof, true)?.message.includes("test-inclusive"), true);
});

Deno.test("a quote inside the grace window does not alert (insert race)", () => {
  const fresh = q("fresh", { created_at: "2026-11-10T17:55:00Z" });
  assertEquals(findQuotesMissingAcceptance([fresh], [], OPTS).count, 0);
  const old = q("old", { created_at: "2026-11-10T17:49:00Z" });
  assertEquals(findQuotesMissingAcceptance([old], [], OPTS).count, 1);
});

Deno.test("quotes before fee_acceptances existed are ignored", () => {
  assertEquals(findQuotesMissingAcceptance([q("legacy", { created_at: "2026-04-01T00:00:00Z" })], [], OPTS).count, 0);
});

Deno.test("auto-bids are excluded (they write no acceptance row)", () => {
  assertEquals(findQuotesMissingAcceptance([q("auto", { is_auto_bid: true })], [], OPTS).count, 0);
});

Deno.test("null is_test counts as non-test; bad created_at never throws", () => {
  assertEquals(findQuotesMissingAcceptance([q("n", { is_test: null })], [], OPTS).count, 1);
  assertEquals(findQuotesMissingAcceptance([q("bad", { created_at: "garbage" })], [], OPTS).count, 0);
});

Deno.test("alert lists at most 20 ids, oldest first, and states the true count", () => {
  const many = Array.from({ length: 25 }, (_, i) => q(`q${i}`, { created_at: `2026-11-0${(i % 9) + 1}T00:00:00Z` }));
  const r = findQuotesMissingAcceptance(many, [], OPTS);
  assertEquals(r.count, 25);
  assertEquals(r.gaps[0].created_at <= r.gaps[24].created_at, true);
  const alert = evaluateFeeAcceptanceGap(r)!;
  assertEquals(alert.subject.includes("25 quotes"), true);
  assertEquals(alert.message.includes("and 5 more"), true);
});

// ---- review fixes (REVIEW 6774741998) ----
import { shouldAlertOnGap } from "./fee-acceptance-gap-check.ts";

Deno.test("an auto-renewed clone (renewed_from_quote_id set, no row) is not a gap", () => {
  const clone = q("renewed", { renewed_from_quote_id: "orig" });
  assertEquals(findQuotesMissingAcceptance([clone], [], OPTS).count, 0);
  // the original with its row is clean; the original WITHOUT a row is still a gap
  assertEquals(findQuotesMissingAcceptance([q("orig"), clone], ["orig"], OPTS).count, 0);
  assertEquals(findQuotesMissingAcceptance([q("orig"), clone], [], OPTS).count, 1);
});

Deno.test("a standing gap does not re-alert every tick; new gap, daily reminder and proof run do", () => {
  const r = findQuotesMissingAcceptance([q("old", { created_at: "2026-11-09T12:00:00Z" })], [], OPTS);
  const T = { graceMinutes: 10, now: NOW };
  // never alerted -> alert
  assertEquals(shouldAlertOnGap(r, null, T).alert, true);
  // alerted 15 minutes ago for this same gap -> silent
  assertEquals(shouldAlertOnGap(r, "2026-11-10T17:45:00Z", T).alert, false);
  // alerted 25 hours ago -> one reminder
  assertEquals(shouldAlertOnGap(r, "2026-11-09T17:00:00Z", T).alert, true);
  // a gap created after the last alert -> alert, counted as new
  const r2 = findQuotesMissingAcceptance([q("old"), q("new", { created_at: "2026-11-10T17:40:00Z" })], [], OPTS);
  const t2 = shouldAlertOnGap(r2, "2026-11-10T17:30:00Z", T);
  assertEquals(t2, { alert: true, newCount: 1 });
  // no gap -> never alert; proof run (force) -> always alert
  assertEquals(shouldAlertOnGap({ count: 0, gaps: [] }, null, T).alert, false);
  assertEquals(shouldAlertOnGap(r, "2026-11-10T17:45:00Z", { ...T, force: true }).alert, true);
});
