// get-business-lines-dashboard/movement.test.ts
//
// gh-1570 — pure-unit tests for movement.ts.
//
// movement.ts is a real module with real exports (same shape as ga4.ts), so
// it is imported directly here — no source-extraction/data: URL indirection
// needed (contrast marketing-series.test.ts, which extracts from index.ts
// because index.ts itself has no exports).
//
// Covers: computeMovement/bucketFor (moved here unchanged from index.ts —
// asserted against the same day-boundary values index.ts always implied) and
// the new homeownerBucket override that stops the admin CRM "stuck-first"
// table from painting a zero-real-activity homeowner claim green just
// because an unrelated system write bumped updated_at.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { bucketFor, computeMovement, homeownerBucket } from "./movement.ts";

Deno.test("bucketFor: green <=7, yellow <=13, red beyond", () => {
  assertEquals(bucketFor(0), "green");
  assertEquals(bucketFor(7), "green");
  assertEquals(bucketFor(8), "yellow");
  assertEquals(bucketFor(13), "yellow");
  assertEquals(bucketFor(14), "red");
  assertEquals(bucketFor(41), "red");
});

Deno.test("computeMovement: picks the max timestamp across inputs, null inputs ignored", () => {
  const now = Date.UTC(2026, 8, 15, 0, 0, 0); // 2026-09-15T00:00:00Z
  const result = computeMovement(now, [
    { label: "a", iso: null },
    { label: "b", iso: "2026-09-10T00:00:00Z" },
    { label: "c", iso: "2026-09-13T00:00:00Z" },
  ]);
  assertEquals(result.days, 2);
  assertEquals(result.latest_label, "c");
  assertEquals(result.latest_iso, "2026-09-13T00:00:00Z");
  assertEquals(result.bucket, "green");
});

Deno.test("computeMovement: all-null inputs -> unknown, no latest", () => {
  const now = Date.UTC(2026, 8, 15, 0, 0, 0);
  const result = computeMovement(now, [{ label: "a", iso: null }, { label: "b", iso: null }]);
  assertEquals(result.days, null);
  assertEquals(result.latest_label, null);
  assertEquals(result.latest_iso, null);
  assertEquals(result.bucket, "unknown");
});

// ── gh-1570 homeownerBucket override ────────────────────────────────────

Deno.test("homeownerBucket (a): claim exists, zero real activity ever, updated_at recently bumped -> red despite raw bucket", () => {
  const now = Date.UTC(2026, 8, 15, 0, 0, 0); // 2026-09-15T00:00:00Z
  // Claim created 60 days ago; updated_at bumped 2 days ago by an unrelated
  // system write; no real activity_log row ever (firstActivityIso = null).
  const movement = computeMovement(now, [
    { label: "claim updated_at", iso: "2026-09-13T00:00:00Z" }, // 2 days ago
  ]);
  assertEquals(movement.bucket, "green"); // raw verdict, before the override
  const bucket = homeownerBucket(movement, null, /* hasClaim */ true);
  assertEquals(bucket, "red");
});

Deno.test("homeownerBucket (b) NEGATIVE CONTROL: same claim, but a real activity_log row 2 days ago -> ordinary bucketFor(2) = green, override does not fire", () => {
  const now = Date.UTC(2026, 8, 15, 0, 0, 0);
  const movement = computeMovement(now, [
    { label: "claim updated_at", iso: "2026-09-13T00:00:00Z" },
  ]);
  const bucket = homeownerBucket(movement, "2026-09-13T00:00:00Z", /* hasClaim */ true);
  assertEquals(bucket, "green");
  assertEquals(bucket, movement.bucket);
});

Deno.test("homeownerBucket (c): no claim, first_activity null -> unchanged bucketFor result (override only applies with a claim)", () => {
  const now = Date.UTC(2026, 8, 15, 0, 0, 0);
  // No claim -> only a profile updated_at input, bumped 2 days ago.
  const movement = computeMovement(now, [
    { label: "profile updated_at", iso: "2026-09-13T00:00:00Z" },
  ]);
  assertEquals(movement.bucket, "green");
  const bucket = homeownerBucket(movement, null, /* hasClaim */ false);
  assertEquals(bucket, "green");
  assertEquals(bucket, movement.bucket);
});

Deno.test("homeownerBucket (d): first_activity null, raw bucket already red -> red (idempotent)", () => {
  const now = Date.UTC(2026, 8, 15, 0, 0, 0);
  const movement = computeMovement(now, [
    { label: "claim updated_at", iso: "2026-07-01T00:00:00Z" }, // 76 days ago
  ]);
  assertEquals(movement.bucket, "red");
  const bucket = homeownerBucket(movement, null, /* hasClaim */ true);
  assertEquals(bucket, "red");
});
