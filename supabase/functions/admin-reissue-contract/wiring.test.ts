// gh-2543 part 2 slice 2a -- structural pins on index.ts (the call site, not the pure module):
// a pure-module test cannot see a handler that skips the plan, deletes a document, or emails a party.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

Deno.test("never deletes a vendor document and never emails a party", () => {
  assertEquals(code.includes("document/delete"), false);
  assertEquals(/deletePermanently/i.test(code), false);
  assertEquals(/mailgun|sendMail|resend|\.functions\.invoke/i.test(code), false);
});

Deno.test("admin gate precedes every database read or write", () => {
  const gate = code.indexOf("PRIMARY_ADMIN_EMAIL)");
  assertEquals(gate > 0, true);
  for (const marker of [".from(\"claims\")", ".from(\"quotes\")", ".from(\"platform_alerts_log\")"]) {
    assertEquals(code.indexOf(marker) > gate, true, marker);
  }
});

Deno.test("order: plan, then dry-run return, then audit, then revoke, then quotes, then claims", () => {
  const order = [
    "planReissue(",
    "if (!confirm)",
    ".from(\"platform_alerts_log\")",
    "revokeDocument(plan.envelopeId",
    ".from(\"quotes\")\n        .update(",
    ".from(\"claims\")\n      .update(",
  ].map((m) => code.indexOf(m));
  assertEquals(order.every((i) => i > 0), true, JSON.stringify(order));
  assertEquals([...order].sort((a, b) => a - b), order);
});

Deno.test("revoke is reachable only when the plan says revoke; every update is guarded by the old id and chains .select(", () => {
  assertEquals(/vendorAction === "revoke"\)\s*\{\s*await revokeDocument/.test(code), true);
  const updates = code.split("\n").map((l, i) => [l, i] as const).filter(([l]) => l.includes(".update("));
  assertEquals(updates.length, 2);
  const lines = code.split("\n");
  for (const [, i] of updates) {
    const w = lines.slice(i, i + 6).join("\n");
    assertEquals(w.includes(".eq(\"docusign_envelope_id\", plan.envelopeId)"), true);
    assertEquals(w.includes(".select("), true);
  }
});
