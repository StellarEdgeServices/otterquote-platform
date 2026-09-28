// Deno unit test for gh-1824 footer-batch-5: watch-template-mapping's
// (flag-gated) stale-template digest must carry the D-237 postal address.
// Run: deno test supabase/functions/watch-template-mapping/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildDigest } from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";
import type { StaleTemplate } from "./select-stale.ts";

const ROW: StaleTemplate = {
  template_id: "tmpl-1",
  contractor_id: "c-1",
  company_name: "Acme Roofing",
  is_test: false,
  trade: "roofing",
  funding_type: "insurance",
  status: "manual_mapping_pending",
  age_hours: 30,
  since: "2026-09-01T00:00:00Z",
};

Deno.test("gh-1824 watch-template-mapping: buildDigest includes the D-237 postal address", () => {
  assertEquals(buildDigest([ROW], 24, "watch-template-mapping").text.includes(POSTAL_ADDRESS), true);
});
