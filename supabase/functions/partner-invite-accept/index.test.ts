// gh-2154 P-5r — partner-invite-accept pure-logic tests. Run:
// deno test --allow-read=supabase/functions supabase/functions/partner-invite-accept/
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { isInviteEligible, isValidAcceptBody } from "./index.ts";
import { signPartnerInviteToken, verifyPartnerInviteToken } from "./invite-token.ts";

Deno.test("isInviteEligible: pending row with a meta_lead_id is eligible", () => {
  assertEquals(isInviteEligible({ status: "pending", meta_lead_id: "leadgen_1" }), true);
});

Deno.test("isInviteEligible: active row (already accepted) is not eligible", () => {
  assertEquals(isInviteEligible({ status: "active", meta_lead_id: "leadgen_1" }), false);
});

Deno.test("isInviteEligible: pending row with no meta_lead_id (a P-1 signup, never invited) is not eligible", () => {
  assertEquals(isInviteEligible({ status: "pending", meta_lead_id: null }), false);
});

Deno.test("isInviteEligible: null/missing row is not eligible", () => {
  assertEquals(isInviteEligible(null), false);
  assertEquals(isInviteEligible(undefined), false);
});

Deno.test("isValidAcceptBody: agreement_accepted:true is valid", () => {
  assertEquals(isValidAcceptBody({ agreement_accepted: true }), true);
});

Deno.test("isValidAcceptBody: agreement_accepted missing is invalid (no implicit accept)", () => {
  assertEquals(isValidAcceptBody({}), false);
});

Deno.test("isValidAcceptBody: agreement_accepted:'true' (truthy string) is invalid -- must be boolean true", () => {
  assertEquals(isValidAcceptBody({ agreement_accepted: "true" }), false);
});

Deno.test("isValidAcceptBody: agreement_accepted:false is invalid", () => {
  assertEquals(isValidAcceptBody({ agreement_accepted: false }), false);
});

Deno.test("isValidAcceptBody: null body is invalid", () => {
  assertEquals(isValidAcceptBody(null), false);
});

// End-to-end token round trip through the module this function actually
// imports (not the meta-leadgen-webhook copy).
Deno.test("invite token: signed then verified under the same secret resolves to the referral_agents id", async () => {
  const token = await signPartnerInviteToken("11111111-1111-1111-1111-111111111111", "invite-secret-fixture");
  const id = await verifyPartnerInviteToken(token, ["invite-secret-fixture"]);
  assertEquals(id, "11111111-1111-1111-1111-111111111111");
});

Deno.test("invite token: an opt-out-style bare-id token (no invite: namespace) does not verify here", async () => {
  // Simulates what would happen if a PARTNER_ONBOARDING_OPTOUT-style token
  // were ever pointed at this endpoint by mistake -- the namespace prefix
  // must reject it, not just a coincidentally-matching signature.
  const encoder = new TextEncoder();
  function base64url(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  const bareId = "11111111-1111-1111-1111-111111111111";
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode("invite-secret-fixture"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(bareId));
  const bareToken = `${base64url(encoder.encode(bareId))}.${base64url(new Uint8Array(sigBuf))}`;
  const id = await verifyPartnerInviteToken(bareToken, ["invite-secret-fixture"]);
  assertEquals(id, null);
});
