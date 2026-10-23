// gh-3051 -- unit tests for the D-323 + D-336 opt-out gate (ad-optout.ts). Only a definite "not_opted_out" is ever sent.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { adSharingGate, combine, insertTimeState, storedProfileState, suppressionState } from "./ad-optout.ts";

Deno.test("insertTimeState: TRUE opts out, FALSE is clear, NULL / undefined / a failed read are unknown", () => {
  assertEquals(insertTimeState({ value: true }), "opted_out");
  assertEquals(insertTimeState({ value: false }), "not_opted_out");
  assertEquals(insertTimeState({ value: null }), "unknown");
  assertEquals(insertTimeState({ value: undefined }), "unknown");
  assertEquals(insertTimeState({ value: false, failed: true }), "unknown");
});

Deno.test("storedProfileState: TRUE opts out; NULL/FALSE clear; failed read unknown; missing is unknown only when required", () => {
  assertEquals(storedProfileState({ value: true }, true), "opted_out");
  assertEquals(storedProfileState({ value: null }, true), "not_opted_out");
  assertEquals(storedProfileState({ value: false }, true), "not_opted_out");
  assertEquals(storedProfileState({ value: false, failed: true }, false), "unknown");
  assertEquals(storedProfileState({ value: null, missing: true }, true), "unknown");
  assertEquals(storedProfileState({ value: null, missing: true }, false), "not_opted_out");
});

Deno.test("suppressionState and combine: any opt-out wins, then any unknown; empty is unknown", () => {
  assertEquals(suppressionState(true, false), "opted_out");
  assertEquals(suppressionState(false, true), "unknown");
  assertEquals(suppressionState(false, false), "not_opted_out");
  assertEquals(combine(["not_opted_out", "unknown", "opted_out"]), "opted_out");
  assertEquals(combine(["not_opted_out", "unknown"]), "unknown");
  assertEquals(combine(["not_opted_out", "not_opted_out"]), "not_opted_out");
  assertEquals(combine([]), "unknown");
});

Deno.test("adSharingGate: only not_opted_out passes (NEGATIVE CONTROL: it does pass)", () => {
  assertEquals(adSharingGate("not_opted_out"), { skip: false, reason: null });
  assertEquals(adSharingGate("opted_out"), { skip: true, reason: "ad_sharing_opt_out" });
  assertEquals(adSharingGate("unknown"), { skip: true, reason: "ad_sharing_opt_out_unknown" });
  assertEquals(adSharingGate(undefined), { skip: true, reason: "ad_sharing_opt_out_unknown" });
  assertEquals(adSharingGate(null), { skip: true, reason: "ad_sharing_opt_out_unknown" });
});
