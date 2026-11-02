// gh-3241: the referrer-updates opt-out gate of send-partner-status-email.
// Run: deno test --allow-read=supabase/functions supabase/functions/send-partner-status-email/consent.test.ts
//
// FAIL-FIRST: on origin/main consent.ts does not exist and the gate reads only the one claim the stage logic
// picked, so an opt-out recorded on another linked claim (or via referrals.claim_id) still sent the series.

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { decideReferrerConsent, linkedClaimsOrFilter } from "./consent.ts";

const P = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const REF = "33333333-3333-4333-8333-333333333333";

Deno.test("opted out on the primary claim -> withheld (no email)", () => {
  const r = decideReferrerConsent({ primaryClaimId: P, linkedClaims: [{ id: P, referrer_updates_opt_out: true }], referralMetadata: null });
  assertEquals(r.consent, "withheld");
});

Deno.test("negative control: primary claim captured false -> granted (email still sends)", () => {
  const r = decideReferrerConsent({ primaryClaimId: P, linkedClaims: [{ id: P, referrer_updates_opt_out: false }], referralMetadata: null });
  assertEquals(r.consent, "granted");
});

Deno.test("gh-3241: opted out on ANOTHER linked claim -> withheld even though the primary says false", () => {
  const r = decideReferrerConsent({
    primaryClaimId: P,
    linkedClaims: [{ id: P, referrer_updates_opt_out: false }, { id: OTHER, referrer_updates_opt_out: true }],
    referralMetadata: null,
  });
  assertEquals(r.consent, "withheld");
  assert(r.source.includes(OTHER));
});

Deno.test("gh-3241: metadata opt-out true withholds even when the claim column says false", () => {
  const r = decideReferrerConsent({
    primaryClaimId: P,
    linkedClaims: [{ id: P, referrer_updates_opt_out: false }],
    referralMetadata: { referrer_updates_opt_out: true },
  });
  assertEquals(r.consent, "withheld");
});

Deno.test("never asked (NULL) and no metadata -> withheld (fail closed, unchanged)", () => {
  const r = decideReferrerConsent({ primaryClaimId: P, linkedClaims: [{ id: P, referrer_updates_opt_out: null }], referralMetadata: {} });
  assertEquals(r.consent, "withheld");
});

Deno.test("claim column NULL, metadata false -> granted (fallback, unchanged)", () => {
  const r = decideReferrerConsent({ primaryClaimId: P, linkedClaims: [{ id: P, referrer_updates_opt_out: null }], referralMetadata: { referrer_updates_opt_out: false } });
  assertEquals(r.consent, "granted");
});

Deno.test("lookup failed: metadata false -> granted, nothing -> withheld (unchanged)", () => {
  assertEquals(decideReferrerConsent({ primaryClaimId: P, linkedClaims: null, referralMetadata: { referrer_updates_opt_out: false } }).consent, "granted");
  const r = decideReferrerConsent({ primaryClaimId: P, linkedClaims: null, referralMetadata: null });
  assertEquals(r.consent, "withheld");
  assertEquals(r.source, "consent lookup failed");
});

Deno.test("a false on a NON-primary claim alone does not grant", () => {
  const r = decideReferrerConsent({ primaryClaimId: P, linkedClaims: [{ id: OTHER, referrer_updates_opt_out: false }], referralMetadata: null });
  assertEquals(r.consent, "withheld");
});

Deno.test("linkedClaimsOrFilter covers both sides of the link and refuses non-UUIDs", () => {
  assertEquals(linkedClaimsOrFilter(REF, P), `referral_id.eq.${REF},id.eq.${P}`);
  assertEquals(linkedClaimsOrFilter(REF, null), `referral_id.eq.${REF}`);
  assertEquals(linkedClaimsOrFilter(REF, "x),status.eq.open"), `referral_id.eq.${REF}`);
  assertEquals(linkedClaimsOrFilter("not-a-uuid,id.neq.0", P), null);
});

Deno.test("index.ts: gate reads every linked claim, loads referrals.claim_id, and runs before any stamp or send", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(src.includes('import { decideReferrerConsent, linkedClaimsOrFilter, type ReferrerConsent } from "./consent.ts";'));
  assert(src.includes('.select("id, referral_agent_id, homeowner_name, claim_id, metadata")'));
  assert(src.includes('.select("id, referrer_updates_opt_out")'));
  assert(src.includes("query.or(orFilter)"));
  const gate = src.indexOf('if (consent === "withheld")');
  assert(gate > 0, "gate present");
  assert(gate < src.indexOf('.update({ metadata: newMetadata })'), "gate before the idempotency stamp");
  assert(gate < src.indexOf("await sendMailgunEmail("), "gate before the Mailgun send");
});
