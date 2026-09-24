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

// The server half is UNCONDITIONAL (gh-2107 follow-up 6b, Ben on #2078 5806312169): stripe-webhook/meta-capi.ts is on main (PR #2107),
// so this imports the real buildCapiEventId statically. If that export is renamed, moved or removed, this file fails to load and CI
// goes red; nothing is skipped or ignored any more.
import { buildCapiEventId } from "../stripe-webhook/meta-capi.ts";

Deno.test("contract: the server's buildCapiEventId returns the contract's event_id for every example in the shared file", () => {
  for (const e of contract.examples) assertEquals(buildCapiEventId(e.paymentIntentId), e.eventId, e.paymentIntentId);
  assertEquals(buildCapiEventId("pi_x"), contract.prefix + "pi_x");
});
