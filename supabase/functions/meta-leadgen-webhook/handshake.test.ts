// gh-2154 P-5 — handshake.ts tests.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { verifyHandshake } from "./handshake.ts";

const TOKEN = "meta-leadgen-verify-token-fixture-not-real";

function params(over: Record<string, string> = {}): URLSearchParams {
  const p = new URLSearchParams();
  p.set("hub.mode", over["hub.mode"] ?? "subscribe");
  p.set("hub.verify_token", over["hub.verify_token"] ?? TOKEN);
  p.set("hub.challenge", over["hub.challenge"] ?? "123456789");
  return p;
}

Deno.test("verifyHandshake: correct mode + token echoes challenge", () => {
  const result = verifyHandshake(params(), TOKEN);
  assertEquals(result, { ok: true, challenge: "123456789" });
});

Deno.test("verifyHandshake: wrong token is rejected", () => {
  const result = verifyHandshake(params({ "hub.verify_token": "wrong-guess" }), TOKEN);
  assertEquals(result.ok, false);
});

Deno.test("verifyHandshake: wrong hub.mode is rejected", () => {
  const result = verifyHandshake(params({ "hub.mode": "unsubscribe" }), TOKEN);
  assertEquals(result.ok, false);
});

Deno.test("verifyHandshake: unset configured token is always rejected, even with a matching-looking request", () => {
  const result = verifyHandshake(params(), undefined);
  assertEquals(result.ok, false);
});

Deno.test("verifyHandshake: missing hub.challenge is rejected even if mode+token match", () => {
  const p = new URLSearchParams();
  p.set("hub.mode", "subscribe");
  p.set("hub.verify_token", TOKEN);
  const result = verifyHandshake(p, TOKEN);
  assertEquals(result.ok, false);
});
