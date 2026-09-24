// gh-2078c / D-330 -- the dedup event_id contract, server half. REVIEW: FAIL 5805870455 (F1) on #2110: the client parity
// test compared against a COPIED string, so editing either side left CI green while Meta silently stopped deduplicating and
// every purchase was counted twice. Both sides are now pinned to ONE file, capi-event-id.contract.json; this test is the
// server's half (the client's is react-app/app/lib/__tests__/track.test.ts).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const contract = JSON.parse(await Deno.readTextFile(new URL("./capi-event-id.contract.json", import.meta.url)));

Deno.test("contract: the fixture is well formed (a non-empty prefix, and every example is prefix + id)", () => {
  assert(typeof contract.prefix === "string" && contract.prefix.length > 0);
  assert(Array.isArray(contract.examples) && contract.examples.length >= 2);
  for (const e of contract.examples) assertEquals(e.eventId, contract.prefix + e.paymentIntentId);
});

// stripe-webhook/meta-capi.ts arrives with PR #2107. Until then this half is reported as IGNORED (visible in the summary),
// not silently passed; once that file exists on the branch under test it is enforced.
let serverPresent = true;
try {
  await Deno.stat(new URL("../stripe-webhook/meta-capi.ts", import.meta.url));
} catch {
  serverPresent = false;
}

Deno.test({
  name: "contract: the server's buildCapiEventId returns the contract's event_id for every example (enforced once meta-capi.ts exists)",
  ignore: !serverPresent,
  fn: async () => {
    const { buildCapiEventId } = await import("../stripe-webhook/meta-capi.ts");
    for (const e of contract.examples) assertEquals(buildCapiEventId(e.paymentIntentId), e.eventId, e.paymentIntentId);
    assertEquals(buildCapiEventId("pi_x"), contract.prefix + "pi_x");
  },
});
