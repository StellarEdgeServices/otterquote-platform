// gh-1653 — pure-unit tests for get-homeowner-list/rows.ts.
// Runs under the CI lane `deno test --allow-read=supabase/functions supabase/functions/`
// with no network, no env, no secrets.
import { assertEquals, assertStrictEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildRows, daysSince, homeownerLabel, statusLabel, STATUS_LABELS, type ClaimIn } from "./rows.ts";

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0); // 2026-09-04T12:00:00Z

function claim(over: Partial<ClaimIn> & { id: string }): ClaimIn {
  return {
    user_id: null, status: "active", created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z", trades: ["roofing"], job_type: "retail",
    funding_type: "cash", is_test: false, homeowner_name: null,
    ...over,
  };
}

Deno.test("statusLabel: every status in claims_status_check has a plain-English label", () => {
  const constraintSet = ["draft", "submitted", "active", "waitlisted", "bidding", "contract_signed", "awarded", "documents_needed"];
  for (const s of constraintSet) {
    const label = statusLabel(s);
    assertStrictEquals(typeof label, "string");
    assertStrictEquals(label === s, false, `label for ${s} must not be the raw enum`);
    assertStrictEquals(label.includes("_"), false, `label for ${s} must not contain an underscore`);
  }
  assertEquals(Object.keys(STATUS_LABELS).sort(), constraintSet.slice().sort());
});

Deno.test("statusLabel: unknown / missing status is never hidden", () => {
  assertStrictEquals(statusLabel("some_future_status"), "some_future_status");
  assertStrictEquals(statusLabel(null), "No status");
  assertStrictEquals(statusLabel(undefined), "No status");
});

Deno.test("daysSince: whole days, floored at 0, null on bad input", () => {
  assertStrictEquals(daysSince("2026-09-01T12:00:00Z", NOW), 3);
  assertStrictEquals(daysSince("2026-09-01T13:00:00Z", NOW), 2); // 2d23h -> 2
  assertStrictEquals(daysSince("2026-09-04T11:59:00Z", NOW), 0);
  assertStrictEquals(daysSince("2026-09-05T00:00:00Z", NOW), 0); // future clock skew -> 0, not negative
  assertStrictEquals(daysSince(null, NOW), null);
  assertStrictEquals(daysSince("not a date", NOW), null);
});

Deno.test("homeownerLabel: profile name > claim name > email; null when nothing held", () => {
  assertEquals(homeownerLabel({ full_name: "Ada L", email: "a@x.com" }, { homeowner_name: "Claim Name" }), { name: "Ada L", email: "a@x.com" });
  assertEquals(homeownerLabel({ full_name: "  ", email: "a@x.com" }, { homeowner_name: "Claim Name" }), { name: "Claim Name", email: "a@x.com" });
  assertEquals(homeownerLabel({ full_name: null, email: "a@x.com" }, { homeowner_name: null }), { name: null, email: "a@x.com" });
  assertEquals(homeownerLabel(null, { homeowner_name: null }), { name: null, email: null });
});

Deno.test("buildRows: one row per claim, joined to profile, dwell from updated_at, sorted longest-dwell first", () => {
  const rows = buildRows(
    [
      claim({ id: "c-new", user_id: "u1", updated_at: "2026-09-03T00:00:00Z", status: "documents_needed" }),
      claim({ id: "c-old", user_id: "u2", updated_at: "2026-08-04T00:00:00Z", status: "draft", trades: [], job_type: null, funding_type: null }),
      claim({ id: "c-test", user_id: "u1", updated_at: "2026-07-25T00:00:00Z", status: "active", is_test: true }),
      claim({ id: "c-orphan", user_id: "u-missing", updated_at: "2026-08-26T00:00:00Z", homeowner_name: "On Claim" }),
    ],
    [
      { id: "u1", full_name: "Ada L", email: "ada@x.com" },
      { id: "u2", full_name: null, email: "no-name@x.com" },
    ],
    NOW,
  );

  assertEquals(rows.map((r) => r.claim_id), ["c-test", "c-old", "c-orphan", "c-new"]);
  assertEquals(rows.map((r) => r.days_at_status), [41, 31, 9, 1]);

  const byId = Object.fromEntries(rows.map((r) => [r.claim_id, r]));
  // joined identity
  assertStrictEquals(byId["c-new"].homeowner_name, "Ada L");
  assertStrictEquals(byId["c-new"].homeowner_email, "ada@x.com");
  assertStrictEquals(byId["c-old"].homeowner_name, null);
  assertStrictEquals(byId["c-old"].homeowner_email, "no-name@x.com");
  assertStrictEquals(byId["c-orphan"].homeowner_name, "On Claim");
  assertStrictEquals(byId["c-orphan"].homeowner_email, null);
  // plain status + dwell basis declared on every row
  assertStrictEquals(byId["c-new"].status_label, "Waiting on documents");
  assertStrictEquals(byId["c-old"].status_label, "Started, not submitted");
  for (const r of rows) assertStrictEquals(r.dwell_basis, "updated_at");
  assertStrictEquals(byId["c-new"].status_since, "2026-09-03T00:00:00Z");
  // is_test carried through, not filtered here
  assertStrictEquals(byId["c-test"].is_test, true);
  assertStrictEquals(byId["c-new"].is_test, false);
  // nullable fields normalised
  assertEquals(byId["c-old"].trades, []);
  assertStrictEquals(byId["c-old"].job_type, null);
  assertStrictEquals(byId["c-old"].funding_type, null);
});

Deno.test("buildRows: dwell ties break on oldest created_at, then claim_id (stable)", () => {
  const rows = buildRows(
    [
      claim({ id: "b", created_at: "2026-08-10T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" }),
      claim({ id: "a", created_at: "2026-08-10T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" }),
      claim({ id: "z", created_at: "2026-07-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" }),
    ],
    [],
    NOW,
  );
  assertEquals(rows.map((r) => r.claim_id), ["z", "a", "b"]);
});

Deno.test("buildRows: missing updated_at falls back to created_at; missing both -> null dwell, sorted last", () => {
  const rows = buildRows(
    [
      claim({ id: "none", created_at: null, updated_at: null }),
      claim({ id: "created-only", created_at: "2026-08-25T00:00:00Z", updated_at: null }),
    ],
    [],
    NOW,
  );
  assertEquals(rows.map((r) => r.claim_id), ["created-only", "none"]);
  assertStrictEquals(rows[0].days_at_status, 10);
  assertStrictEquals(rows[1].days_at_status, null);
  assertStrictEquals(rows[1].status_since, null);
});
