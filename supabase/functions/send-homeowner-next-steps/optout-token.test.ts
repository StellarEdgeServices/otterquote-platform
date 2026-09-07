// gh-1786 / D-320 — opt-out token tests.
// Run: deno test supabase/functions/send-homeowner-next-steps/optout-token.test.ts
//
// Every positive assertion here is paired with its NEGATIVE CONTROL, because
// #1786's closes-on demands that "a change that suppresses everybody, or nobody,
// cannot pass as a success": a token check that accepted everything would pass a
// round-trip test on its own.

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  buildOptOutUrl,
  OPTOUT_EVENT_TYPE,
  signOptOutToken,
  verifyOptOutToken,
} from "./optout-token.ts";

const SECRET = "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SECRET = "test-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CLAIM = "6f1d2c3b-4a5e-4f60-8b71-9c0d1e2f3a4b";
const OTHER_CLAIM = "11112222-3333-4444-5555-666677778888";

Deno.test("round trip: a token signed with the secret verifies to its claim id", async () => {
  const token = await signOptOutToken(CLAIM, SECRET);
  assertEquals(await verifyOptOutToken(token, [SECRET]), CLAIM);
});

Deno.test("NEGATIVE CONTROL — a token signed with a DIFFERENT secret is rejected", async () => {
  const forged = await signOptOutToken(CLAIM, OTHER_SECRET);
  // Same shape, same claim, valid base64url, only the key is wrong.
  assertEquals(await verifyOptOutToken(forged, [SECRET]), null);
  // ...and the same token verifies under its own key, so the rejection is the
  // signature check working, not the parser refusing everything.
  assertEquals(await verifyOptOutToken(forged, [OTHER_SECRET]), CLAIM);
});

Deno.test("NEGATIVE CONTROL — swapping the payload for another claim invalidates the token", async () => {
  const token = await signOptOutToken(CLAIM, SECRET);
  const otherToken = await signOptOutToken(OTHER_CLAIM, SECRET);
  const spliced = `${otherToken.split(".")[0]}.${token.split(".")[1]}`;
  assertEquals(await verifyOptOutToken(spliced, [SECRET]), null);
  // The two halves are individually valid — proof the splice is what failed.
  assertEquals(await verifyOptOutToken(token, [SECRET]), CLAIM);
  assertEquals(await verifyOptOutToken(otherToken, [SECRET]), OTHER_CLAIM);
});

Deno.test("NEGATIVE CONTROL — a one-character change in the signature is rejected", async () => {
  const token = await signOptOutToken(CLAIM, SECRET);
  const [payload, sig] = token.split(".");
  const flipped = sig[0] === "A" ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
  assertEquals(await verifyOptOutToken(`${payload}.${flipped}`, [SECRET]), null);
});

Deno.test("malformed input never throws and never verifies", async () => {
  for (
    const bad of [
      null,
      undefined,
      "",
      "notatoken",
      "a.b.c",
      ".",
      "!!!.###",
      `${"x".repeat(50)}.${"y".repeat(50)}`,
    ]
  ) {
    assertEquals(await verifyOptOutToken(bad as string | null | undefined, [SECRET]), null, String(bad));
  }
});

Deno.test("rotation: the PREVIOUS secret still verifies links already in inboxes", async () => {
  const oldToken = await signOptOutToken(CLAIM, OTHER_SECRET);
  // After rotation: SECRET is current, OTHER_SECRET is previous.
  assertEquals(await verifyOptOutToken(oldToken, [SECRET, OTHER_SECRET]), CLAIM);
  // NEGATIVE CONTROL: drop the previous secret and the same link dies — which
  // is the CAN-SPAM 30-day failure mode the rotation list exists to prevent.
  assertEquals(await verifyOptOutToken(oldToken, [SECRET]), null);
});

Deno.test("an empty secret list verifies nothing, and empty strings are not secrets", async () => {
  const token = await signOptOutToken(CLAIM, SECRET);
  assertEquals(await verifyOptOutToken(token, []), null);
  assertEquals(await verifyOptOutToken(token, ["", ""]), null);
});

Deno.test("signing refuses to emit an unsigned or claimless token", async () => {
  await assertRejects(() => signOptOutToken(CLAIM, ""), Error, "secret is required");
  await assertRejects(() => signOptOutToken("", SECRET), Error, "claimId is required");
});

Deno.test("the URL carries the token and no PII", async () => {
  const token = await signOptOutToken(CLAIM, SECRET);
  const url = buildOptOutUrl("https://abc.supabase.co/functions/v1/", token);
  assertEquals(url, `https://abc.supabase.co/functions/v1/homeowner-email-optout?t=${encodeURIComponent(token)}`);
  for (const pii of ["@", "nick", "george", "gmail", "mailto"]) {
    assert(!url.toLowerCase().includes(pii), `url must not contain ${pii}: ${url}`);
  }
});

Deno.test("the event type is the one the sender filters on", () => {
  assertEquals(OPTOUT_EVENT_TYPE, "homeowner_nudge_opt_out");
});
