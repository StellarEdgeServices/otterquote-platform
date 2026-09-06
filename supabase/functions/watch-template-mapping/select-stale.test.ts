// Deno unit tests for the gh-1313 template watcher selection + dedup logic.
// Run: deno test supabase/functions/watch-template-mapping/select-stale.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  ALERT_DEDUP_MS,
  ALERT_TYPE,
  alertKey,
  alreadyAlerted,
  buildAlertMessage,
  DEFAULT_THRESHOLD_HOURS,
  isWatchedStatus,
  partitionForAlerting,
  selectStale,
  type TemplateRowInput,
  WATCHED_STATUSES,
} from "./select-stale.ts";

const H = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-04T22:00:00Z");
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

function row(over: Partial<TemplateRowInput> & { id: string }): TemplateRowInput {
  return {
    status: "manual_mapping_pending",
    trade: "roofing",
    funding_type: "retail",
    created_at: iso(400 * H),
    updated_at: iso(400 * H),
    contractor_id: "c-1",
    contractors: { company_name: "PFW Test Contractor", email: "x@example.com", is_test: true },
    ...over,
  };
}

// ── status vocabulary ────────────────────────────────────────────────────────

Deno.test("watched statuses are exactly the three 'somebody must act' states", () => {
  assertEquals([...WATCHED_STATUSES], ["manual_mapping_pending", "pending_validation", "submitted_for_admin_review"]);
  for (const s of WATCHED_STATUSES) assertEquals(isWatchedStatus(s), true, s);
});

Deno.test("terminal statuses are never watched", () => {
  for (const s of ["auto_validated", "manual_validated", "admin_validated", "rejected", "", null, undefined]) {
    assertEquals(isWatchedStatus(s as string), false, String(s));
  }
});

Deno.test("default threshold is 24h and dedup window is 24h", () => {
  assertEquals(DEFAULT_THRESHOLD_HOURS, 24);
  assertEquals(ALERT_DEDUP_MS, 24 * H);
  assertEquals(ALERT_TYPE, "template_stuck");
});

// ── selectStale ──────────────────────────────────────────────────────────────

Deno.test("the production shape: one manual_mapping_pending row 346h old is selected with its age", () => {
  const r = row({ id: "4a6ef653-cc2c-4089-a3be-58f2512ce23e", updated_at: iso(346.3 * H) });
  const out = selectStale([r], NOW);
  assertEquals(out.length, 1);
  assertEquals(out[0].template_id, "4a6ef653-cc2c-4089-a3be-58f2512ce23e");
  assertEquals(out[0].status, "manual_mapping_pending");
  assertEquals(out[0].age_hours, 346.3);
  assertEquals(out[0].company_name, "PFW Test Contractor");
  assertEquals(out[0].is_test, true);
  assertEquals(out[0].since, r.updated_at);
});

Deno.test("a row younger than the threshold is not selected; one exactly at it is", () => {
  const young = row({ id: "y", updated_at: iso(23.9 * H) });
  const edge = row({ id: "e", updated_at: iso(24 * H) });
  const out = selectStale([young, edge], NOW);
  assertEquals(out.map((t) => t.template_id), ["e"]);
});

Deno.test("threshold is configurable", () => {
  const r = row({ id: "r", updated_at: iso(5 * H) });
  assertEquals(selectStale([r], NOW, 4).length, 1);
  assertEquals(selectStale([r], NOW, 6).length, 0);
});

Deno.test("terminal-status rows are dropped regardless of age", () => {
  const rows = ["auto_validated", "manual_validated", "admin_validated", "rejected"].map((status, i) =>
    row({ id: `t${i}`, status, updated_at: iso(1000 * H) })
  );
  assertEquals(selectStale(rows, NOW), []);
});

Deno.test("pending_validation and submitted_for_admin_review are selected too", () => {
  const rows = [
    row({ id: "pv", status: "pending_validation", updated_at: iso(201 * H) }),
    row({ id: "sar", status: "submitted_for_admin_review", updated_at: iso(30 * H) }),
    row({ id: "pv-young", status: "pending_validation", updated_at: iso(2 * H) }),
  ];
  assertEquals(selectStale(rows, NOW).map((t) => t.template_id), ["pv", "sar"]);
});

Deno.test("age is measured from updated_at, falling back to created_at", () => {
  const withUpdated = row({ id: "u", created_at: iso(500 * H), updated_at: iso(10 * H) });
  const noUpdated = row({ id: "n", created_at: iso(500 * H), updated_at: null });
  const out = selectStale([withUpdated, noUpdated], NOW);
  assertEquals(out.map((t) => t.template_id), ["n"]);
  assertEquals(out[0].age_hours, 500);
});

Deno.test("oldest first", () => {
  const rows = [
    row({ id: "a", updated_at: iso(30 * H) }),
    row({ id: "b", updated_at: iso(300 * H) }),
    row({ id: "c", updated_at: iso(100 * H) }),
  ];
  assertEquals(selectStale(rows, NOW).map((t) => t.template_id), ["b", "c", "a"]);
});

Deno.test("unparseable timestamps are dropped, not treated as infinitely old", () => {
  assertEquals(selectStale([row({ id: "bad", created_at: "not a date", updated_at: null })], NOW), []);
});

Deno.test("missing contractor join yields nulls, not a throw", () => {
  const out = selectStale([row({ id: "x", contractors: null, contractor_id: null })], NOW);
  assertEquals(out[0].company_name, null);
  assertEquals(out[0].is_test, null);
  assertEquals(out[0].contractor_id, null);
});

// ── dedup ────────────────────────────────────────────────────────────────────

Deno.test("alertKey is the stable token and the message starts with it", () => {
  const t = selectStale([row({ id: "abc" })], NOW)[0];
  assertEquals(alertKey("abc"), "template=abc");
  const msg = buildAlertMessage(t, 24);
  assertEquals(msg.startsWith("template=abc #1313:"), true);
  assertEquals(msg.includes("manual_mapping_pending"), true);
  assertEquals(msg.includes("[is_test]"), true);
  assertEquals(msg.includes("admin-template-review.html"), true);
});

Deno.test("alreadyAlerted: a prior alert inside the 24h window suppresses", () => {
  const prior = [{ message: buildAlertMessage(selectStale([row({ id: "abc" })], NOW)[0], 24), sent_at: iso(3 * H) }];
  assertEquals(alreadyAlerted("abc", prior, NOW), true);
});

Deno.test("alreadyAlerted: a prior alert older than 24h does not suppress (one per day)", () => {
  const prior = [{ message: "template=abc #1313: ...", sent_at: iso(25 * H) }];
  assertEquals(alreadyAlerted("abc", prior, NOW), false);
});

Deno.test("alreadyAlerted: another template's alert never suppresses this one", () => {
  const prior = [{ message: "template=other #1313: ...", sent_at: iso(1 * H) }];
  assertEquals(alreadyAlerted("abc", prior, NOW), false);
});

Deno.test("alreadyAlerted: a prefix-sharing id does not collide (template=abc vs template=abcd)", () => {
  const prior = [{ message: "template=abcd #1313: ...", sent_at: iso(1 * H) }];
  assertEquals(alreadyAlerted("abcd", prior, NOW), true);
  assertEquals(alreadyAlerted("abc", prior, NOW), false);
});

Deno.test("alreadyAlerted: the token must lead the message (a mention elsewhere is not a prior alert)", () => {
  const prior = [{ message: "some other alert mentioning template=abc later", sent_at: iso(1 * H) }];
  assertEquals(alreadyAlerted("abc", prior, NOW), false);
});

Deno.test("partitionForAlerting splits into toAlert and deduplicated", () => {
  const stale = selectStale(
    [row({ id: "fresh", updated_at: iso(50 * H) }), row({ id: "seen", updated_at: iso(60 * H) })],
    NOW,
  );
  const prior = [{ message: "template=seen #1313: ...", sent_at: iso(2 * H) }];
  const { toAlert, deduplicated } = partitionForAlerting(stale, prior, NOW);
  assertEquals(toAlert.map((t) => t.template_id), ["fresh"]);
  assertEquals(deduplicated.map((t) => t.template_id), ["seen"]);
});

Deno.test("two runs in one day: second run writes nothing new", () => {
  const stale = selectStale([row({ id: "r1" })], NOW);
  const first = partitionForAlerting(stale, [], NOW);
  assertEquals(first.toAlert.length, 1);
  const written = first.toAlert.map((t) => ({ message: buildAlertMessage(t, 24), sent_at: iso(0) }));
  const second = partitionForAlerting(stale, written, NOW + 6 * H);
  assertEquals(second.toAlert.length, 0);
  assertEquals(second.deduplicated.length, 1);
  const nextDay = partitionForAlerting(stale, written, NOW + 25 * H);
  assertEquals(nextDay.toAlert.length, 1);
});
