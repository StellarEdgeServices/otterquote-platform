// gh-2154 P-5 — signature.ts tests. Run:
// deno test --allow-read=supabase/functions supabase/functions/meta-leadgen-webhook/
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  computeHmacSha256Hex,
  SIGNATURE_PREFIX,
  timingSafeEqualHex,
  verifyMetaSignature,
} from "./signature.ts";

const SECRET = "meta-app-secret-fixture-not-real-000";

Deno.test("verifyMetaSignature: valid signature over the raw body verifies", async () => {
  const body = JSON.stringify({ entry: [{ id: "1" }] });
  const hex = await computeHmacSha256Hex(SECRET, body);
  const ok = await verifyMetaSignature(body, `${SIGNATURE_PREFIX}${hex}`, SECRET);
  assert(ok);
});

Deno.test("verifyMetaSignature: forged signature (wrong key) fails", async () => {
  const body = JSON.stringify({ entry: [{ id: "1" }] });
  const forgedHex = await computeHmacSha256Hex("wrong-secret-attacker-guess", body);
  const ok = await verifyMetaSignature(body, `${SIGNATURE_PREFIX}${forgedHex}`, SECRET);
  assertFalse(ok);
});

Deno.test("verifyMetaSignature: body modified after signing fails", async () => {
  const original = JSON.stringify({ entry: [{ id: "1" }] });
  const tampered = JSON.stringify({ entry: [{ id: "999" }] });
  const hex = await computeHmacSha256Hex(SECRET, original);
  const ok = await verifyMetaSignature(tampered, `${SIGNATURE_PREFIX}${hex}`, SECRET);
  assertFalse(ok);
});

Deno.test("verifyMetaSignature: missing header fails", async () => {
  const body = "{}";
  const ok = await verifyMetaSignature(body, null, SECRET);
  assertFalse(ok);
});

Deno.test("verifyMetaSignature: unset app secret always fails, even with a correctly-formed header", async () => {
  const body = "{}";
  // A header that WOULD verify if a secret were configured -- still must fail closed.
  const hex = await computeHmacSha256Hex("irrelevant", body);
  const ok = await verifyMetaSignature(body, `${SIGNATURE_PREFIX}${hex}`, undefined);
  assertFalse(ok);
});

Deno.test("verifyMetaSignature: header missing the sha256= prefix fails", async () => {
  const body = "{}";
  const hex = await computeHmacSha256Hex(SECRET, body);
  const ok = await verifyMetaSignature(body, hex, SECRET);
  assertFalse(ok);
});

Deno.test("timingSafeEqualHex: equal strings match", () => {
  assert(timingSafeEqualHex("deadbeef", "deadbeef"));
});

Deno.test("timingSafeEqualHex: different-length strings do not match (no early return)", () => {
  assertFalse(timingSafeEqualHex("deadbeef", "dead"));
});

Deno.test("timingSafeEqualHex: single trailing-character difference does not match", () => {
  assertFalse(timingSafeEqualHex("deadbeef", "deadbeee"));
});

// Structural mutation guard: this file's own source must not contain a
// naive `===`/`!==` comparison of the two hex signature strings directly
// (that would defeat the constant-time guarantee, even though it would
// still pass every value-based test above). A mutation that replaces
// timingSafeEqualHex's body with `return a === b;` keeps every prior test
// green, so this checks the source text itself.
Deno.test("timingSafeEqualHex: implementation is not a naive === comparison (structural)", async () => {
  const src = await Deno.readTextFile(new URL("./signature.ts", import.meta.url));
  const fnMatch = src.match(/export function timingSafeEqualHex[\s\S]*?\n\}/);
  assert(fnMatch, "timingSafeEqualHex function body not found");
  const fnBody = fnMatch[0];
  assertFalse(/return a === b/.test(fnBody), "must not short-circuit with a direct === comparison");
  assert(/for\s*\(/.test(fnBody), "must walk the full length in a loop");
  assert(/\^/.test(fnBody), "must accumulate differences (XOR) rather than branch on the first mismatch");
});

Deno.test("computeHmacSha256Hex: matches a known HMAC-SHA256 test vector (key='key', message='The quick brown fox jumps over the lazy dog')", async () => {
  const hex = await computeHmacSha256Hex("key", "The quick brown fox jumps over the lazy dog");
  assertEquals(hex.length, 64);
  assertEquals(hex, "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
});
